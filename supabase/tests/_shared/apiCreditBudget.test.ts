// Tests for the shared TwelveData credit budget.
//
// Context: the previous limiter was a module-level array, so it existed once
// per Edge Function isolate. Six isolates x 50 permitted = 300/min against a
// 55/min plan. Measured 371 peak, 100% quota, 44% of pair-scans skipped with
// "Insufficient candles (0, need 20)" — while every isolate's throttle counter
// read 0, because none of them individually misbehaved.
//
// The two properties that matter here:
//   1. The budget is actually consulted, and a refusal is honoured.
//   2. When the budget is unreachable it FAILS OPEN and says so loudly.
//      Blocking every candle fetch on a DB hiccup would be a hard outage;
//      over-spending only degrades to a fallback provider.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { acquireApiCredit, reserveApiCredit, resetCreditBudgetStats, setCreditCallerContext } from "../../functions/_shared/apiCreditBudget.ts";

const realFetch = globalThis.fetch;

function withFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): void {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init ?? {}))) as typeof fetch;
}

function restore(): void {
  globalThis.fetch = realFetch;
  resetCreditBudgetStats();
}

function withCredentials(): void {
  Deno.env.set("SUPABASE_URL", "https://test.supabase.co");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
}

Deno.test("reserveApiCredit: grants and marks enforced when the budget has room", async () => {
  withCredentials();
  withFetch(() => new Response("true", { status: 200 }));
  try {
    const result = await reserveApiCredit("twelvedata", 50, 60);
    assertEquals(result.granted, true);
    assertEquals(result.enforced, true);
  } finally {
    restore();
  }
});

Deno.test("reserveApiCredit: honours a refusal — this is the whole point", async () => {
  withCredentials();
  withFetch(() => new Response("false", { status: 200 }));
  try {
    const result = await reserveApiCredit("twelvedata", 50, 60);
    assertEquals(
      result.granted,
      false,
      "a refused reservation must not grant — otherwise the shared budget is decorative",
    );
    assertEquals(result.enforced, true);
    assertEquals(resetCreditBudgetStats().refused, 1);
  } finally {
    restore();
  }
});

Deno.test("reserveApiCredit: sends the provider, limit and window the caller asked for", async () => {
  withCredentials();
  let body: Record<string, unknown> = {};
  let url = "";
  withFetch((u, init) => {
    url = u;
    body = JSON.parse(String(init.body));
    return new Response("true", { status: 200 });
  });
  try {
    await reserveApiCredit("twelvedata", 50, 60);
    assert(url.endsWith("/rest/v1/rpc/reserve_api_credit"), `unexpected url: ${url}`);
    assertEquals(body.p_provider, "twelvedata");
    assertEquals(body.p_limit, 50);
    assertEquals(body.p_window_seconds, 60);
  } finally {
    restore();
  }
});

Deno.test("reserveApiCredit: fails OPEN on HTTP error rather than stalling the bot", async () => {
  withCredentials();
  withFetch(() => new Response("boom", { status: 500 }));
  try {
    const result = await reserveApiCredit("twelvedata", 50, 60);
    assertEquals(result.granted, true, "a broken limiter must not take the bot offline");
    assertEquals(result.enforced, false, "but it must admit the budget was not applied");
    assertEquals(result.reason, "http_500");
    assertEquals(resetCreditBudgetStats().rpcFailures, 1);
  } finally {
    restore();
  }
});

Deno.test("reserveApiCredit: fails OPEN when the RPC throws or aborts", async () => {
  withCredentials();
  globalThis.fetch = (() => {
    const err = new Error("The signal has been aborted");
    err.name = "AbortError";
    return Promise.reject(err);
  }) as typeof fetch;
  try {
    const result = await reserveApiCredit("twelvedata", 50, 60);
    assertEquals(result.granted, true);
    assertEquals(result.enforced, false);
    assertEquals(result.reason, "timeout");
  } finally {
    restore();
  }
});

Deno.test("reserveApiCredit: fails OPEN on a non-boolean response", async () => {
  withCredentials();
  withFetch(() => new Response(JSON.stringify({ message: "no function matches" }), { status: 200 }));
  try {
    const result = await reserveApiCredit("twelvedata", 50, 60);
    assertEquals(result.granted, true);
    assertEquals(result.enforced, false, "a PostgREST error object is not a grant");
    assertEquals(result.reason, "bad_response");
  } finally {
    restore();
  }
});

Deno.test("reserveApiCredit: fails OPEN without service credentials, and makes no request", async () => {
  Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
  Deno.env.set("SUPABASE_URL", "https://test.supabase.co");
  let called = false;
  withFetch(() => {
    called = true;
    return new Response("true", { status: 200 });
  });
  try {
    const result = await reserveApiCredit("twelvedata", 50, 60);
    assertEquals(result.granted, true);
    assertEquals(result.enforced, false);
    assertEquals(result.reason, "no_service_credentials");
    assertEquals(called, false, "must not attempt an unauthenticated RPC");
  } finally {
    restore();
  }
});

Deno.test("resetCreditBudgetStats: accumulates then clears", async () => {
  withCredentials();
  withFetch(() => new Response("false", { status: 200 }));
  try {
    await reserveApiCredit("twelvedata", 50, 60);
    await reserveApiCredit("twelvedata", 50, 60);
    const first = resetCreditBudgetStats();
    assertEquals(first.refused, 2);
    assertEquals(resetCreditBudgetStats().refused, 0, "stats must clear so per-scan numbers are per-scan");
  } finally {
    restore();
  }
});

// ─── Wiring and migration shape ──────────────────────────────────────
// These read source rather than behaviour. The bug being prevented is someone
// later "simplifying" the pieces back into the broken shape, which no
// behavioural test would catch because the code would still run fine.

const candleSource = await Deno.readTextFile(
  new URL("../../functions/_shared/candleSource.ts", import.meta.url),
);

Deno.test("candleSource: the TwelveData path actually consults the shared budget", () => {
  assert(
    candleSource.includes("acquireApiCredit("),
    "waitForTwelveDataSlot must reserve from the shared budget, not only its per-isolate array",
  );
  const slotFn = candleSource.slice(
    candleSource.indexOf("async function waitForTwelveDataSlot"),
    candleSource.indexOf("export function resetThrottleStats"),
  );
  assert(
    slotFn.includes("acquireApiCredit("),
    "the reservation must happen inside waitForTwelveDataSlot, on the path every fetch takes",
  );
  assert(
    slotFn.includes('"twelvedata"'),
    "reservations must be attributed to a provider so budgets do not merge",
  );
});

Deno.test("candleSource: a refused reservation returns false so the caller falls back", () => {
  const slotFn = candleSource.slice(
    candleSource.indexOf("async function waitForTwelveDataSlot"),
    candleSource.indexOf("export function resetThrottleStats"),
  );
  assert(
    /if \(!granted\)[\s\S]{0,200}return false/.test(slotFn),
    "exhausting the shared budget must return false (skip to fallback), never true",
  );
});

const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260812020000_add_api_credit_budget.sql",
    import.meta.url,
  ),
);

Deno.test("migration: reservation is serialised, because count-then-insert is the bug", () => {
  assert(
    migration.includes("pg_advisory_xact_lock"),
    "concurrent isolates racing between the count and the insert is precisely the failure " +
      "being fixed; the reservation must hold a lock",
  );
  const fn = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION"));
  assert(
    fn.indexOf("pg_advisory_xact_lock") < fn.indexOf("SELECT count(*)"),
    "the lock must be taken before the count, not after",
  );
});

Deno.test("migration: the usage table is service-role only and RLS-enabled", () => {
  assert(migration.includes("ENABLE ROW LEVEL SECURITY"), "every table in this project has RLS on");
  assert(migration.includes("TO service_role"), "credit accounting is infrastructure, not user data");
  assert(
    !/TO\s+authenticated/i.test(migration),
    "clients have no reason to see or spend the API budget",
  );
});

Deno.test("migration: old rows are pruned so the table cannot grow without bound", () => {
  assert(
    /DELETE FROM public\.api_credit_usage/.test(migration),
    "one row per credit at ~55/min needs a prune, or the table grows forever",
  );
});

// ─── acquireApiCredit ────────────────────────────────────────────────

Deno.test("acquireApiCredit: returns false without waiting when maxWaitMs is 0", async () => {
  withCredentials();
  let calls = 0;
  withFetch(() => {
    calls++;
    return new Response("false", { status: 200 });
  });
  try {
    const started = Date.now();
    const granted = await acquireApiCredit("twelvedata", 50, { maxWaitMs: 0 });
    assertEquals(granted, false);
    assertEquals(calls, 1, "maxWaitMs 0 means try once — live polls must not block");
    assert(Date.now() - started < 500, "must return promptly");
  } finally {
    restore();
  }
});

Deno.test("acquireApiCredit: retries while waiting and succeeds when a credit frees up", async () => {
  withCredentials();
  let calls = 0;
  withFetch(() => new Response(++calls >= 3 ? "true" : "false", { status: 200 }));
  try {
    const granted = await acquireApiCredit("twelvedata", 50, { maxWaitMs: 5_000, pollMs: 10 });
    assertEquals(granted, true);
    assertEquals(calls, 3, "the rolling window frees credits gradually, so it must re-ask");
  } finally {
    restore();
  }
});

Deno.test("acquireApiCredit: counts fail-open grants as unenforced", async () => {
  withCredentials();
  withFetch(() => new Response("boom", { status: 503 }));
  try {
    assertEquals(await acquireApiCredit("twelvedata", 50), true);
    assertEquals(resetCreditBudgetStats().unenforced, 1, "a grant nobody checked must be visible");
  } finally {
    restore();
  }
});

// ─── Coverage ratchet ────────────────────────────────────────────────
// The original limiter was bypassed by two call sites that talked to
// TwelveData directly and never imported candleSource, so the budget it
// enforced was fictional. This fails the build if a third one appears.

async function tsFilesUnder(dir: URL): Promise<URL[]> {
  const out: URL[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const child = new URL(`${entry.name}${entry.isDirectory ? "/" : ""}`, dir);
    if (entry.isDirectory) out.push(...await tsFilesUnder(child));
    else if (entry.name.endsWith(".ts")) out.push(child);
  }
  return out;
}

Deno.test("every TwelveData call site reserves from the shared budget", async () => {
  const root = new URL("../../functions/", import.meta.url);
  const offenders: string[] = [];

  for (const file of await tsFilesUnder(root)) {
    const src = await Deno.readTextFile(file);
    if (!src.includes("api.twelvedata.com")) continue;
    const name = file.pathname.split("/functions/")[1];
    // candleSource owns the reservation for everything routed through it.
    const meters = src.includes("acquireApiCredit(") || src.includes("reserveApiCredit(");
    if (!meters) offenders.push(name);
  }

  assertEquals(
    offenders,
    [],
    `these hit TwelveData without reserving a credit, so the shared budget cannot see them: ${offenders.join(", ")}`,
  );
});

// ─── Attribution ─────────────────────────────────────────────────────
// The budget went live already saturated — pinned at exactly 50/min. Deciding
// what to cut requires knowing who is spending it, and eight functions reach
// TwelveData through candleSource, so a single "candleSource" label would say
// nothing useful.

Deno.test("reserveApiCredit: records who spent the credit", async () => {
  withCredentials();
  let body: Record<string, unknown> = {};
  withFetch((_u, init) => {
    body = JSON.parse(String(init.body));
    return new Response("true", { status: 200 });
  });
  try {
    await reserveApiCredit("twelvedata", 50, 60, "bot-scanner:candleSource");
    assertEquals(body.p_caller, "bot-scanner:candleSource");
  } finally {
    restore();
  }
});

Deno.test("acquireApiCredit: attributes to <function>:<callsite>", async () => {
  withCredentials();
  let body: Record<string, unknown> = {};
  withFetch((_u, init) => {
    body = JSON.parse(String(init.body));
    return new Response("true", { status: 200 });
  });
  try {
    setCreditCallerContext("zone-confirmation-scanner");
    await acquireApiCredit("twelvedata", 50, { label: "candleSource" });
    assertEquals(
      body.p_caller,
      "zone-confirmation-scanner:candleSource",
      "the function must be identifiable, not just the module it went through",
    );
  } finally {
    setCreditCallerContext("unknown");
    restore();
  }
});

Deno.test("every function that reaches TwelveData declares who it is", async () => {
  const root = new URL("../../functions/", import.meta.url);
  const anonymous: string[] = [];

  for await (const entry of Deno.readDir(root)) {
    if (!entry.isDirectory || entry.name.startsWith("_")) continue;
    const indexUrl = new URL(`${entry.name}/index.ts`, root);
    let src: string;
    try {
      src = await Deno.readTextFile(indexUrl);
    } catch {
      continue;
    }
    const reachesTwelveData = src.includes("api.twelvedata.com") ||
      src.includes("candleSource.ts");
    if (!reachesTwelveData) continue;
    if (!src.includes("setCreditCallerContext(")) anonymous.push(entry.name);
  }

  assertEquals(
    anonymous,
    [],
    `these spend TwelveData credits without identifying themselves, so their usage ` +
      `is invisible in the breakdown: ${anonymous.join(", ")}`,
  );
});

const attributionMigration = await Deno.readTextFile(
  new URL("../../migrations/20260812031000_add_credit_caller_attribution.sql", import.meta.url),
);

Deno.test("migration: the 3-arg overload survives, so a mid-deploy call still enforces", () => {
  assert(
    !/DROP FUNCTION IF EXISTS public\.reserve_api_credit\(TEXT, INT, INT\)\s*;/.test(
      attributionMigration,
    ),
    "migrations run before functions redeploy; dropping the old signature would make " +
      "already-deployed code 404, fail open, and stop enforcing for the length of the deploy",
  );
  assert(
    attributionMigration.includes("'unattributed'"),
    "a stale deploy must be visible in the breakdown rather than writing NULL",
  );
});

const retentionMigration = await Deno.readTextFile(
  new URL("../../migrations/20260812033000_widen_credit_usage_retention.sql", import.meta.url),
);

Deno.test("migration: retention is independent of the rate window", () => {
  assert(
    retentionMigration.includes("retention_seconds"),
    "history retention and the enforcement window are different concerns and must be " +
      "separately named — pruning at 2x the window left only ~2 minutes of history, " +
      "which cannot distinguish continuous saturation from a burst",
  );
  assert(
    !/reserved_at < now\(\) - make_interval\(secs => p_window_seconds \* 2\)/.test(
      retentionMigration,
    ),
    "the prune must no longer be derived from p_window_seconds",
  );
});

Deno.test("migration: the counting window is still p_window_seconds, not retention", () => {
  const counting = retentionMigration.slice(retentionMigration.indexOf("SELECT count(*) INTO used"));
  assert(
    counting.includes("now() - make_interval(secs => p_window_seconds)"),
    "widening retention must not widen what is enforced — the count still looks back " +
      "exactly one window, or the limit silently becomes 50 per 30 minutes",
  );
});

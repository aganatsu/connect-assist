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
import { reserveApiCredit, resetCreditBudgetStats } from "../../functions/_shared/apiCreditBudget.ts";

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
    candleSource.includes("reserveApiCredit("),
    "waitForTwelveDataSlot must reserve from the shared budget, not only its per-isolate array",
  );
  const slotFn = candleSource.slice(
    candleSource.indexOf("async function waitForTwelveDataSlot"),
    candleSource.indexOf("export function resetThrottleStats"),
  );
  assert(
    slotFn.includes("reserveApiCredit("),
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
    /remaining <= 0[\s\S]{0,400}return false/.test(slotFn),
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

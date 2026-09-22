import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  summariseInvocation, accumulate, accumulateKeys, parseTelemetry,
  emptyTelemetry, mgmtTelemetryKey, RECENT_INVOCATIONS,
  type FetchRecord,
} from "../../functions/_shared/smcMgmtTelemetry.ts";

const T0 = Date.UTC(2026, 8, 22, 16, 0, 0);
const f = (symbol: string, interval: string, reason: string, cacheHit = false): FetchRecord =>
  ({ symbol, interval, reason: reason as FetchRecord["reason"], cacheHit, bars: 300, ms: 40 });

const ctx = (over: Record<string, number> = {}) => ({
  mode: "manage" as const, startedAtMs: T0, endedAtMs: T0 + 900,
  openPositions: 0, pendingOrders: 16, distinctSymbols: 3,
  managementActions: 0, budgetRefused: 0, budgetGaveUp: 0, budgetUnenforced: 0, ...over,
});

// ── what the loop is actually being asked ────────────────────────────────────

Deno.test("separates provider fetches from per-cycle cache hits", () => {
  // The question "does each pending order cause its own fetch" is answered by
  // this split: many calls, few provider fetches means the cache already groups.
  const r = summariseInvocation(ctx(), [
    f("EUR/USD", "15m", "pending_fill_check"),
    f("EUR/USD", "15m", "pending_fill_check", true),
    f("EUR/USD", "15m", "pending_thesis_m15", true),
    f("GBP/USD", "1d", "pending_thesis_htf"),
  ]);
  assertEquals(r.fetchCalls, 4);
  assertEquals(r.providerFetches, 2);
  assertEquals(r.cacheHits, 2);
  assertEquals(r.distinctKeys, 2, "the floor a perfect grouping could reach");
});

Deno.test("repeated keys inside one invocation are named", () => {
  // Free at the provider, but it shows call sites are unaware of each other —
  // which is exactly what a grouping change would fix.
  const r = summariseInvocation(ctx(), [
    f("EUR/USD", "15m", "pending_fill_check"),
    f("EUR/USD", "15m", "pending_thesis_m15", true),
    f("EUR/USD", "15m", "pending_confirmation", true),
    f("USD/JPY", "1h", "pending_thesis_htf"),
  ]);
  assertEquals(r.repeatedKeys, { "EUR/USD|15m": 3 });
  assert(!("USD/JPY|1h" in r.repeatedKeys), "a single request is not a repeat");
});

Deno.test("attributes every fetch to a call site", () => {
  const r = summariseInvocation(ctx(), [
    f("EUR/USD", "1d", "rate_map"), f("GBP/USD", "1d", "rate_map"),
    f("AUD/USD", "1d", "fotsi_daily"),
    f("EUR/USD", "15m", "pending_fill_check"),
  ]);
  assertEquals(r.byReason, { rate_map: 2, fotsi_daily: 1, pending_fill_check: 1 });
});

Deno.test("an invocation with nothing to manage is flagged, and so are its fetches", () => {
  // "Are fetches happening even when no management decision can change?" —
  // nothing open and nothing pending means every request was avoidable.
  const idle = summariseInvocation(ctx({ openPositions: 0, pendingOrders: 0 }),
    [f("EUR/USD", "1d", "rate_map")]);
  assertEquals(idle.noEligibleWork, true);
  assertEquals(idle.providerFetches, 1, "it fetched anyway");

  const busy = summariseInvocation(ctx({ openPositions: 1, pendingOrders: 0 }), []);
  assertEquals(busy.noEligibleWork, false);
});

Deno.test("idle-but-fetching invocations are counted separately in the rollup", () => {
  let t = accumulate(null, summariseInvocation(ctx({ openPositions: 0, pendingOrders: 0 }),
    [f("EUR/USD", "1d", "rate_map")]));
  t = accumulate(t, summariseInvocation(ctx({ openPositions: 0, pendingOrders: 0 }), []));
  t = accumulate(t, summariseInvocation(ctx({ pendingOrders: 5 }), [f("EUR/USD", "15m", "pending_fill_check")]));
  assertEquals(t.invocations, 3);
  assertEquals(t.idleInvocations, 2);
  assertEquals(t.idleInvocationsThatFetched, 1, "the avoidable-spend headline");
});

// ── rollup behaviour ─────────────────────────────────────────────────────────

Deno.test("totals accumulate and the recent ring is bounded", () => {
  let t = emptyTelemetry();
  for (let i = 0; i < RECENT_INVOCATIONS + 15; i++) {
    t = accumulate(t, summariseInvocation(ctx(), [f("EUR/USD", "15m", "pending_fill_check")]));
  }
  assertEquals(t.invocations, RECENT_INVOCATIONS + 15);
  assertEquals(t.manageInvocations, RECENT_INVOCATIONS + 15);
  assertEquals(t.totalProviderFetches, RECENT_INVOCATIONS + 15);
  assertEquals(t.recent.length, RECENT_INVOCATIONS, "the ring must not grow without bound");
  assertEquals(t.recent[0].at, t.updatedAt, "newest first");
});

Deno.test("per-key totals count only provider fetches", () => {
  const fetches = [
    f("EUR/USD", "15m", "pending_fill_check"),
    f("EUR/USD", "15m", "pending_thesis_m15", true),   // cache hit, must not count
    f("USD/JPY", "1h", "pending_thesis_htf"),
  ];
  const t = accumulateKeys(accumulate(null, summariseInvocation(ctx(), fetches)), fetches);
  assertEquals(t.totalsByKey, { "EUR/USD|15m": 1, "USD/JPY|1h": 1 });
});

Deno.test("a corrupt or foreign payload restarts cleanly rather than throwing", () => {
  assertEquals(parseTelemetry(null), null);
  assertEquals(parseTelemetry("not json"), null);
  assertEquals(parseTelemetry('{"nope":1}'), null);
  const fresh = accumulate(parseTelemetry("garbage"), summariseInvocation(ctx(), []));
  assertEquals(fresh.invocations, 1);
});

Deno.test("the key is namespaced per bot and user", () => {
  assertEquals(mgmtTelemetryKey("u1", "smc"), "smc_mgmt_telemetry:smc:u1");
  assert(mgmtTelemetryKey("u1", "smc") !== mgmtTelemetryKey("u2", "smc"));
});

// ── it must not change the loop ──────────────────────────────────────────────

Deno.test("the telemetry module is pure — no client, no fetch, no env", async () => {
  const src = await Deno.readTextFile("supabase/functions/_shared/smcMgmtTelemetry.ts");
  for (const impure of ["createClient", "fetch(", "Deno.env", ".from(", "supabase-js"]) {
    assert(!src.includes(impure), `telemetry module is not pure: ${impure}`);
  }
});

Deno.test("the scanner wrapper observes without altering the fetch", async () => {
  const src = await Deno.readTextFile("supabase/functions/bot-scanner/index.ts");
  const w = src.slice(src.indexOf("const cachedFetch = ("), src.indexOf("// ── Scan overlap lock"));
  // It must return scanCache's own promise chain, not a reconstructed value.
  assert(w.includes("scanCache.get(sym, interval, range)"), "the wrapper stopped calling scanCache");
  assert(w.includes("return p.then("), "the wrapper must pass the value through");
  for (const bad of ["await new Promise", "setTimeout", "if (", "catch"]) {
    assert(!w.includes(bad), `the wrapper adds control flow (${bad}) — it must only record`);
  }
});

Deno.test("management telemetry cannot fail a management cycle", async () => {
  const src = await Deno.readTextFile("supabase/functions/bot-scanner/index.ts");
  const fn = src.slice(src.indexOf("async function recordMgmtTelemetry"));
  assert(fn.includes("try {") && fn.includes("catch"), "the writer can throw");
  // It must use the non-resetting reader, or it steals counts from the scan log.
  assert(fn.includes("peekThrottleStats()"), "the writer resets counters the scan cycle needs");
  assert(!fn.includes("resetThrottleStats("), "the writer resets shared counters");
});

Deno.test("peekThrottleStats does not mutate the counters", async () => {
  const src = await Deno.readTextFile("supabase/functions/_shared/candleSource.ts");
  const fn = src.slice(src.indexOf("export function peekThrottleStats"),
                       src.indexOf("export function resetThrottleStats"));
  for (const assign of ["_tdThrottleCount =", "_td429Count =", "_tdUnenforcedCount =", "_tdGaveUpCount ="]) {
    assert(!fn.includes(assign), `peek assigns ${assign}`);
  }
});

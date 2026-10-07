/**
 * STEP 15 PR 3 — dry-run outcome resolver: rules, data handling, run wiring.
 * The two database functions are proven on real Postgres in
 * paperSettlementLedger.test.ts.
 */
import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type Bar, fxOpen, HORIZON_DAYS, OUTCOME_METHOD, resolveHypothetical, type HypotheticalInput } from "../../functions/_shared/hypotheticalOutcome.ts";
import { loadBars, runOutcomeResolver } from "../../functions/_shared/outcomeResolverRun.ts";

const T0 = Date.parse("2026-10-07T18:22:01Z"); // 4d8eab45's hypothetical fill (Wednesday)
const B = (iso: string, o: number, h: number, l: number, c: number): Bar => ({ t: Date.parse(iso), o, h, l, c });
// GBP/USD long: fill 1.32175, stop 1.319745, target 1.324995
const base = (bars: Bar[], over: Partial<HypotheticalInput> = {}): HypotheticalInput => ({
  direction: "long", fillAtMs: T0, fillPrice: 1.32175, stop: 1.319745, target: 1.324995,
  riskUsd: 499.245, costInPrice: 0.0001, pipSize: 0.0001, bars,
  lastObservationMs: Date.parse("2026-10-08T00:00:00Z"), nowMs: Date.parse("2026-10-08T00:00:00Z"), ...over,
});
/** n contiguous flat 5m bars from `startIso` around `px`. */
function flat(startIso: string, n: number, px: number, spread = 0.0003): Bar[] {
  return Array.from({ length: n }, (_, k) => ({ t: Date.parse(startIso) + k * 300_000, o: px, h: px + spread, l: px - spread, c: px }));
}

Deno.test("replay starts at the first bar opening after the fill (the fill bar is skipped)", () => {
  // the 18:20 bar contains the fill and touches the stop — it must be ignored
  // last bar 18:50 closes 18:55; a scan at 19:00 makes all six final and nothing after them is due yet
  const r = resolveHypothetical(base([B("2026-10-07T18:20:00Z", 1.3218, 1.3219, 1.3190, 1.3218), ...flat("2026-10-07T18:25:00Z", 6, 1.3218)],
    { lastObservationMs: Date.parse("2026-10-07T19:00:00Z") }));
  assertEquals(r.status, "pending");
});

Deno.test("stop, target, same-bar tie → stop, and gap-through at the open — long and short", () => {
  const stop = resolveHypothetical(base([...flat("2026-10-07T18:25:00Z", 2, 1.3218), B("2026-10-07T18:35:00Z", 1.3215, 1.3216, 1.3196, 1.3200)]));
  assert(stop.status === "resolved");
  assertEquals([stop.exitReason, stop.exitPrice, stop.barsReplayed], ["hypothetical_stop", 1.319745, 3]);
  assertAlmostEquals(stop.rGross, -1, 1e-12);
  assertEquals(new Date(stop.closedAtMs).toISOString(), "2026-10-07T18:40:00.000Z");

  const tgt = resolveHypothetical(base([B("2026-10-07T18:25:00Z", 1.3230, 1.3252, 1.3225, 1.3249)]));
  assert(tgt.status === "resolved");
  assertEquals([tgt.exitReason, tgt.exitPrice], ["hypothetical_target", 1.324995]);
  assertAlmostEquals(tgt.rGross, (1.324995 - 1.32175) / (1.32175 - 1.319745), 1e-12);

  const tie = resolveHypothetical(base([B("2026-10-07T18:25:00Z", 1.3220, 1.3260, 1.3190, 1.3230)]));
  assert(tie.status === "resolved");
  assertEquals(tie.exitReason, "hypothetical_stop", "stop wins a same-bar tie");

  const gap = resolveHypothetical(base([B("2026-10-07T18:25:00Z", 1.3190, 1.3195, 1.3180, 1.3188)]));
  assert(gap.status === "resolved");
  assertEquals([gap.exitReason, gap.exitPrice, new Date(gap.closedAtMs).toISOString()], ["hypothetical_gap_through_stop", 1.3190, "2026-10-07T18:25:00.000Z"]);
  assert(gap.rGross < -1, "a gap through the stop loses more than 1R");

  const gapT = resolveHypothetical(base([B("2026-10-07T18:25:00Z", 1.3260, 1.3265, 1.3255, 1.3262)]));
  assert(gapT.status === "resolved");
  assertEquals([gapT.exitReason, gapT.exitPrice], ["hypothetical_target", 1.3260]);

  // short: USD/JPY, fill 158.21184, stop 158.45462, target 157.92962
  const s = { direction: "short" as const, fillPrice: 158.21184, stop: 158.45462, target: 157.92962, pipSize: 0.01 };
  const sStop = resolveHypothetical(base([B("2026-10-07T18:25:00Z", 158.30, 158.46, 158.25, 158.40)], s));
  assert(sStop.status === "resolved");
  assertEquals(sStop.exitReason, "hypothetical_stop");
  assertAlmostEquals(sStop.rGross, -1, 1e-12);
  const sTie = resolveHypothetical(base([B("2026-10-07T18:25:00Z", 158.20, 158.50, 157.90, 158.10)], s));
  assert(sTie.status === "resolved");
  assertEquals(sTie.exitReason, "hypothetical_stop");
  const sGap = resolveHypothetical(base([B("2026-10-07T18:25:00Z", 158.60, 158.70, 158.55, 158.65)], s));
  assert(sGap.status === "resolved");
  assertEquals([sGap.exitReason, sGap.exitPrice], ["hypothetical_gap_through_stop", 158.60]);
});

Deno.test("gross R, net R after the recorded cost, and P/L from the recorded risk dollars", () => {
  const r = resolveHypothetical(base([B("2026-10-07T18:25:00Z", 1.3230, 1.3252, 1.3225, 1.3249)]));
  assert(r.status === "resolved");
  const risk = 1.32175 - 1.319745;
  assertAlmostEquals(r.rNet!, r.rGross - 0.0001 / risk, 1e-12);
  assertAlmostEquals(r.pnlUsd!, r.rGross * 499.245, 1e-9);
  assertAlmostEquals(r.pnlNetUsd!, r.rNet! * 499.245, 1e-9);
  const noCost = resolveHypothetical(base([B("2026-10-07T18:25:00Z", 1.3230, 1.3252, 1.3225, 1.3249)], { costInPrice: null, riskUsd: null }));
  assert(noCost.status === "resolved");
  assertEquals([noCost.rNet, noCost.pnlUsd], [null, null], "unknown inputs stay unknown — not invented");
});

Deno.test("only FINAL bars decide: a bar not yet re-scanned ≥ 5 min after its close is ignored", () => {
  const touching = B("2026-10-07T18:25:00Z", 1.3215, 1.3216, 1.3190, 1.3200);
  // last scan at 18:31 → the 18:25 bar closed 18:30, not final until a scan ≥ 18:35
  assertEquals(resolveHypothetical(base([touching], { lastObservationMs: Date.parse("2026-10-07T18:31:00Z") })).status, "pending");
  assertEquals(resolveHypothetical(base([touching], { lastObservationMs: Date.parse("2026-10-07T18:35:00Z") })).status, "resolved");
});

Deno.test("missing non-weekend bar → deferred with the gap; nothing is invented", () => {
  const bars = [...flat("2026-10-07T18:25:00Z", 3, 1.3218), ...flat("2026-10-07T18:45:00Z", 3, 1.3218)]; // 18:40 missing
  const r = resolveHypothetical(base([...bars, B("2026-10-07T19:00:00Z", 1.3215, 1.3216, 1.3190, 1.3200)]));
  assert(r.status === "deferred");
  assertEquals(new Date(r.gapStartMs).toISOString(), "2026-10-07T18:40:00.000Z");
  // a missing slot AFTER the last bar that should already be final is a gap too
  const tail = resolveHypothetical(base(flat("2026-10-07T18:25:00Z", 2, 1.3218), { lastObservationMs: Date.parse("2026-10-07T19:00:00Z") }));
  assert(tail.status === "deferred");
});

Deno.test("the FX weekend is not a gap (Fri 17:00 → Sun 17:00 New York)", () => {
  assertEquals([fxOpen(Date.parse("2026-10-09T20:55:00Z")), fxOpen(Date.parse("2026-10-09T21:00:00Z"))], [true, false], "Fri 16:55 / 17:00 NY (EDT)");
  assertEquals([fxOpen(Date.parse("2026-10-10T12:00:00Z")), fxOpen(Date.parse("2026-10-11T20:55:00Z")), fxOpen(Date.parse("2026-10-11T21:00:00Z"))], [false, false, true]);
  // a long held over the weekend: last Friday bar 20:55Z, next bar Sunday 21:00Z — no gap; Monday-open gap through the stop
  const fri = Date.parse("2026-10-09T20:41:00Z"); // first replayed bar opens 20:45
  const bars = [...flat("2026-10-09T20:45:00Z", 3, 1.3218), B("2026-10-11T21:00:00Z", 1.3180, 1.3185, 1.3170, 1.3175)];
  const r = resolveHypothetical(base(bars, { fillAtMs: fri, lastObservationMs: Date.parse("2026-10-11T21:30:00Z") }));
  assert(r.status === "resolved");
  assertEquals(r.exitReason, "hypothetical_gap_through_stop");
});

Deno.test(`open at horizon (${HORIZON_DAYS} days) marks at the last final close`, () => {
  const startIso = "2026-10-07T18:25:00Z";
  // weekday-only flat bars for > 14 days would need weekends skipped; use a 1-day horizon to keep it compact
  const bars = flat(startIso, 300, 1.3220);
  const r = resolveHypothetical(base(bars, { horizonDays: 1, lastObservationMs: Date.parse("2026-10-09T00:00:00Z") }));
  assert(r.status === "resolved");
  assertEquals([r.exitReason, r.exitPrice, r.marginPips], ["open_at_horizon", 1.3220, null]);
  assertAlmostEquals(r.rGross, (1.3220 - 1.32175) / (1.32175 - 1.319745), 1e-12);
});

Deno.test("invalid inputs are reported, never resolved", () => {
  assertEquals(resolveHypothetical(base([], { stop: 1.3230 })).status, "invalid");
  assertEquals(resolveHypothetical(base([], { fillPrice: 0 })).status, "invalid");
  assertEquals(resolveHypothetical(base([], { fillAtMs: NaN })).status, "invalid");
});

Deno.test("the decisive margin is recorded (revision sensitivity is visible)", () => {
  const r = resolveHypothetical(base([B("2026-10-07T18:25:00Z", 1.3215, 1.3216, 1.31972, 1.3200)]));
  assert(r.status === "resolved");
  assertAlmostEquals(r.marginPips!, (1.319745 - 1.31972) / 0.0001, 1e-9); // 0.25 pip past the stop
});

// ─── the run: reads bars (latest revision), writes only through the two functions ───

function fakeDb(bars: Record<string, unknown>[], cands: Record<string, unknown>[], rpcReply: unknown = "resolved") {
  const calls: { fn: string; args: any }[] = [];
  const writes: string[] = [];
  const q = (table: string) => {
    let rows = table === "smc_scan_bars" ? bars : cands;
    let lo = 0, hi = 1e9;
    const b: any = {
      select: () => b, eq: () => b, is: () => b, gte: () => b, order: () => b, limit: () => b,
      range: (a: number, z: number) => { lo = a; hi = z; return b; },
      insert: () => { writes.push(`insert:${table}`); return b; }, update: () => { writes.push(`update:${table}`); return b; },
      delete: () => { writes.push(`delete:${table}`); return b; },
      then: (res: any) => Promise.resolve({ data: rows.slice(lo, hi + 1), error: null }).then(res),
    };
    return b;
  };
  return { calls, writes, from: q, rpc: async (fn: string, args: any) => { calls.push({ fn, args }); return { data: rpcReply, error: null }; } };
}

Deno.test("loadBars keeps the LATEST revision of each bar and the newest observation time", async () => {
  const db = fakeDb([
    { bar_time: "2026-10-07T18:25:00+00:00", open: 1.3218, high: 1.3219, low: 1.3217, close: 1.32194, first_seen_at: "2026-10-07T18:30:04+00:00" },
    { bar_time: "2026-10-07T18:25:00+00:00", open: 1.3218, high: 1.3219, low: 1.3190, close: 1.32184, first_seen_at: "2026-10-07T18:40:13+00:00" },
  ], []);
  const r = await loadBars(db, "GBP/USD", "2026-10-07T18:00:00Z");
  assertEquals(r.bars.length, 1);
  assertEquals([r.bars[0].l, r.bars[0].c], [1.3190, 1.32184]);
  assertEquals(new Date(r.lastObservationMs).toISOString(), "2026-10-07T18:40:13.000Z");
});

Deno.test("a run resolves through attribution_resolve_hypothetical only — no table writes, no provider", async () => {
  const cand = { signal_id: "s1", symbol: "GBP/USD", direction: "long", filled_at: "2026-10-07T18:22:01Z", fill_price: 1.32175,
    fill_stop_price: 1.319745, fill_target_price: 1.324995, fill_risk_usd: 499.245, cost_in_price: 0.0001 };
  const bars = [{ bar_time: "2026-10-07T18:25:00+00:00", open: 1.3215, high: 1.3216, low: 1.3196, close: 1.32, first_seen_at: "2026-10-07T18:40:00+00:00" }];
  const db = fakeDb(bars, [cand]);
  const s = await runOutcomeResolver(db, Date.parse("2026-10-07T19:00:00Z"));
  assertEquals([s.candidates, s.resolved, s.errors.length], [1, 1, 0]);
  assertEquals(db.calls.map((c) => c.fn), ["attribution_resolve_hypothetical"]);
  assertEquals([db.calls[0].args.p_outcome.exit_reason, db.calls[0].args.p_outcome.method], ["hypothetical_stop", OUTCOME_METHOD]);
  assertEquals(db.writes, [], "no direct table writes");
  // pending → no call at all; a gap → the deferral function
  const db2 = fakeDb([], [cand]);
  const p = await runOutcomeResolver(db2, Date.parse("2026-10-07T18:26:00Z"));
  assertEquals([p.pending, db2.calls.length], [1, 0]);
});

Deno.test("source: the function is service-role only and the runner never touches trading tables or providers", () => {
  const fn = Deno.readTextFileSync(new URL("../../functions/attribution-outcome-resolver/index.ts", import.meta.url));
  const run = Deno.readTextFileSync(new URL("../../functions/_shared/outcomeResolverRun.ts", import.meta.url));
  assert(fn.includes('if (!isServiceRole(req.headers.get("Authorization"), serviceKey)) return respond({ error: "Unauthorized" }, 401);'));
  for (const t of ["pending_orders", "paper_positions", "paper_accounts", "paper_account_ledger", "paper_trade_history", "bot_configs"]) {
    assert(!run.includes(`"${t}"`), `runner must not touch ${t}`);
  }
  assert(!/\.insert\(|\.update\(|\.delete\(|\.upsert\(/.test(run), "writes only via the two RPCs");
  assert(!/fetch\(|cachedFetch|fetchCandles/.test(run), "no market-data provider call");
  const cron = Deno.readTextFileSync(new URL("../../cron/attribution_outcome_resolver_cron.sql", import.meta.url));
  assert(cron.includes("cron.schedule('attribution-outcome-resolver-15m', '7,22,37,52 * * * *'"));
});

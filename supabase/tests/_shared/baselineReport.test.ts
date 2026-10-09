import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type AttributionRow, BASELINE_A, BASELINE_A_FROM_MS, cohortOf, decisionContext, isRedetection, maeMfe, summarize,
} from "../../functions/_shared/baselineReport.ts";

const AFTER = "2026-10-09T18:00:00Z";
let seq = 0;
function row(over: Partial<AttributionRow> = {}): AttributionRow {
  seq++;
  return {
    signal_id: `s${seq}`, symbol: "GBP/USD", direction: "long", dry_run: false, config_version: BASELINE_A.configVersion,
    route: BASELINE_A.route, primary_engine: BASELINE_A.primaryEngine, decision_at: AFTER, order_placed_at: AFTER,
    touched_at: null, confirmed_at: null, filled_at: null, closed_at: null, entry_source: "refinedEntry", confirmation: null,
    terminal_status: null, terminal_reason: null, stop_source: "floor", stop_distance_pips: 25, fill_stop_distance_pips: null,
    fill_inside_floor: null, intended_risk_usd: 500, intended_risk_pct: 0.5, fill_risk_usd: null, fill_risk_pct: null,
    fill_price: null, fill_stop_price: null, exit_reason: null, realized_pnl_usd: null, realized_r_gross: null, realized_r_net: null,
    ...over,
  };
}
const closedTrade = (r: number, net: number, pnl: number, over: Partial<AttributionRow> = {}) => row({
  touched_at: "2026-10-09T18:30:00Z", confirmed_at: "2026-10-09T18:40:00Z", filled_at: "2026-10-09T18:40:00Z",
  closed_at: "2026-10-09T20:40:00Z", terminal_status: "filled", terminal_reason: "FILLED", confirmation: { tier: 3, type: "bullish_reversal_pattern", timeframe: "5m" },
  fill_price: 1.3, fill_stop_price: 1.2975, fill_stop_distance_pips: 25, fill_risk_usd: 498, fill_risk_pct: 0.498,
  exit_reason: r > 0 ? "target" : "stop", realized_r_gross: r, realized_r_net: net, realized_pnl_usd: pnl, ...over,
});

Deno.test("cohort: Baseline A is real + frozen config + Route 2 + impulse_zone + decided at/after the unlock; dry-run before the unlock is context; nothing is pooled", () => {
  assertEquals(BASELINE_A_FROM_MS, Date.parse("2026-10-09T17:22:40.402Z"));
  assertEquals(cohortOf(row()), "baseline_a");
  assertEquals(cohortOf(row({ decision_at: "2026-10-09T17:22:40.402Z" })), "baseline_a", "the unlock instant itself counts");
  assertEquals(cohortOf(row({ decision_at: "2026-10-09T17:22:40.401Z" })), "excluded", "a real order before the unlock is not Baseline A");
  assertEquals(cohortOf(row({ dry_run: true, decision_at: "2026-10-08T10:00:00Z" })), "historical_dry_run");
  assertEquals(cohortOf(row({ dry_run: true, decision_at: "2026-10-08T10:00:00Z", config_version: "3d5b8fb0d756b3596ed46d133e873a88" })), "historical_dry_run");
  assertEquals(cohortOf(row({ dry_run: true })), "excluded", "a dry-run order after the unlock is neither");
  assertEquals(cohortOf(row({ config_version: "3d5b8fb0d756b3596ed46d133e873a88" })), "excluded");
  assertEquals(cohortOf(row({ route: "route1_market" })), "excluded");
  assertEquals(cohortOf(row({ primary_engine: "ob_fvg" })), "excluded");
});

Deno.test("empty cohort: every rate and average is null, never a division by zero", () => {
  const s = summarize([]);
  assertEquals([s.funnel.orders, s.rates.fill, s.outcomes.winRate, s.outcomes.expectancyNetR, s.outcomes.realizedPnlUsd], [0, null, null, null, 0]);
  assertEquals(s.timingMinutes.fillToClose, { n: 0, median: null, mean: null });
});

Deno.test("funnel and rates: every terminal status counted against orders; expiry split by reason", () => {
  const rows = [
    closedTrade(1.1, 1.0, 547), closedTrade(-1, -1.06, -498),
    row({ terminal_status: "invalidated", terminal_reason: "CANCELLED_ZONE_EXIT", touched_at: AFTER }),
    row({ terminal_status: "superseded", terminal_reason: "CANCELLED_SUPERSEDED" }),
    row({ terminal_status: "expired", terminal_reason: "EXPIRED_NEVER_TOUCHED" }),
    row({ terminal_status: "expired", terminal_reason: "EXPIRED_AFTER_TOUCH_NO_CONFIRMATION", touched_at: AFTER }),
    row({ terminal_status: "blocked_caps", terminal_reason: "CANCELLED_POSITION_CAP" }),
    row({ terminal_status: "cancelled", terminal_reason: "CANCELLED_DIRECTION_FLIP" }),
    row(), // open
    closedTrade(0, 0, 0, { closed_at: null, exit_reason: null, realized_r_gross: null, realized_r_net: null, realized_pnl_usd: null }), // open position
  ];
  const s = summarize(rows);
  assertEquals([s.funnel.orders, s.funnel.touched, s.funnel.fills, s.funnel.closed, s.funnel.openOrders, s.funnel.openPositions], [10, 5, 3, 2, 1, 1]);
  assertEquals([s.rates.fill, s.rates.invalidated, s.rates.superseded, s.rates.expired, s.rates.expiredNeverTouched, s.rates.expiredAfterTouch, s.rates.blocked, s.rates.cancelled],
    [0.3, 0.1, 0.1, 0.2, 0.1, 0.1, 0.1, 0.1]);
  assertEquals(s.funnel.byTerminal.open, 1);
});

Deno.test("outcomes: win rate, gross/net R, expectancy = winRate × avgWin − lossRate × |avgLoss|, realized P/L", () => {
  const s = summarize([closedTrade(1.1, 1.04, 547), closedTrade(-1, -1.06, -498), closedTrade(-1, -1.06, -498), closedTrade(1.1, 1.04, 547)]);
  const o = s.outcomes;
  assertEquals([o.closed, o.wins, o.losses, o.breakeven, o.winRate], [4, 2, 2, 0, 0.5]);
  assertAlmostEquals(o.avgGrossR!, 0.05);
  assertAlmostEquals(o.avgNetR!, -0.01);
  assertAlmostEquals(o.expectancyNetR!, 0.5 * 1.04 - 0.5 * 1.06);
  assertEquals(o.realizedPnlUsd, 98);
  assertEquals(o.byExitReason, { target: 2, stop: 2 });
});

Deno.test("breakdowns by pair, entry source, confirmation tier and type", () => {
  const s = summarize([
    closedTrade(1.1, 1.04, 547, { symbol: "USD/JPY", entry_source: "zoneMid", confirmation: { tier: 2, type: "choch" } }),
    closedTrade(-1, -1.06, -498, { symbol: "GBP/USD" }),
    row({ symbol: "USD/JPY", entry_source: "zoneMid", terminal_status: "invalidated" }),
  ]);
  assertEquals(s.byPair["USD/JPY"].orders, 2);
  assertEquals(s.byPair["USD/JPY"].fillRate, 0.5);
  assertEquals(s.byEntrySource.zoneMid.realizedPnlUsd, 547);
  assertEquals(s.byEntrySource.refinedEntry.winRate, 0);
  assertEquals(Object.keys(s.byConfirmationTier).sort(), ["2", "3"]);
  assertEquals(s.byConfirmationType.choch.orders, 1, "only confirmed orders enter the confirmation breakdowns");
});

Deno.test("risk, stop distance and timing (minutes, from the attribution timestamps); resets from events", () => {
  const t = closedTrade(1.1, 1.04, 547, { decision_at: "2026-10-09T18:00:00Z", order_placed_at: "2026-10-09T18:00:01Z", fill_risk_usd: 450 });
  const s = summarize([t], { resets: new Map([[t.signal_id, 3]]) });
  assertEquals(s.risk.fillOverIntended.mean, 0.9);
  assertEquals(s.risk.stopDistancePips.median, 25);
  assertAlmostEquals(s.timingMinutes.decisionToOrder.median!, 1 / 60);
  assertEquals([s.timingMinutes.orderToTouch.median, s.timingMinutes.touchToConfirm.median, s.timingMinutes.confirmToFill.median, s.timingMinutes.fillToClose.median],
    [30 - 1 / 60, 10, 0, 120]);
  assertEquals(s.timingMinutes.resetsPerOrder.mean, 3);
});

const T0 = Date.parse("2026-10-09T18:40:00Z");
const bar = (i: number, o: number, h: number, l: number, c: number) => ({ t: T0 + i * 300_000, o, h, l, c });

Deno.test("MAE/MFE: long and short, in pips and R, over the bars between fill and close", () => {
  const bars = [bar(-1, 1.29, 1.35, 1.25, 1.29), bar(0, 1.3, 1.3015, 1.2990, 1.3010), bar(1, 1.301, 1.3027, 1.3005, 1.3020), bar(2, 1.302, 1.3022, 1.2985, 1.2990), bar(3, 1.5, 1.6, 1.0, 1.5)];
  const long = maeMfe({ direction: "long", fillPrice: 1.3, stopPrice: 1.2975, filledAtMs: T0 + 60_000, closedAtMs: T0 + 900_000, pipSize: 0.0001 }, bars);
  assert(long.status === "ok");
  assertEquals(long.bars, 3, "bars before the fill bar and from the close onward are excluded");
  assertAlmostEquals(long.mfePips, 27, 1e-6);
  assertAlmostEquals(long.maePips, 15, 1e-6);
  assertAlmostEquals(long.mfeR, 27 / 25, 1e-9);
  const short = maeMfe({ direction: "short", fillPrice: 1.3, stopPrice: 1.3025, filledAtMs: T0, closedAtMs: T0 + 900_000, pipSize: 0.0001 }, bars);
  assert(short.status === "ok");
  assertAlmostEquals(short.mfePips, 15, 1e-6);
  assertAlmostEquals(short.maePips, 27, 1e-6);
});

Deno.test("MAE/MFE is never guessed: a missing bar while FX is open → gap; no bars → no_bars; missing inputs → invalid", () => {
  const bars = [bar(0, 1.3, 1.301, 1.299, 1.3), bar(2, 1.3, 1.301, 1.299, 1.3)]; // bar 1 missing on a Friday afternoon (market open)
  const g = maeMfe({ direction: "long", fillPrice: 1.3, stopPrice: 1.2975, filledAtMs: T0, closedAtMs: T0 + 900_000, pipSize: 0.0001 }, bars);
  assertEquals(g.status, "gap");
  assertEquals(maeMfe({ direction: "long", fillPrice: 1.3, stopPrice: 1.2975, filledAtMs: T0, closedAtMs: T0 + 900_000, pipSize: 0.0001 }, []).status, "no_bars");
  assertEquals(maeMfe({ direction: "long", fillPrice: null, stopPrice: 1.2975, filledAtMs: T0, closedAtMs: T0 + 1, pipSize: 0.0001 }, bars).status, "invalid");
  const s = summarize([closedTrade(1, 1, 1, { signal_id: "x" })], { maeMfe: new Map([["x", g]]) });
  assertEquals([s.maeMfe.ok, s.maeMfe.unavailable.gap, s.maeMfe.maeR.n], [0, 1, 0], "a gap is reported, not averaged");
});

Deno.test("pre-order context: zone_setup_insert_failed 'already active' is a re-detection, not a signal or a failure; refused setups are deduplicated (approx.)", () => {
  const d = (status: string, skip: string | null = null, entry = 1.3) => ({ symbol: "CHF/JPY", scanned_at: AFTER, status, skip, direction: "long", entry });
  assert(isRedetection(d("zone_setup_insert_failed", "Zone setup already active (see Zone Setups panel)")));
  assert(!isRedetection(d("zone_setup_insert_failed", "attribution_write_failed: x")));
  const c = decisionContext([
    d("zone_setup_insert_failed", "Zone setup already active (see Zone Setups panel)"),
    d("zone_setup_insert_failed", "Zone setup already active (see Zone Setups panel)"),
    d("zone_setup_rejected_rr"), d("zone_setup_rejected_rr"), d("zone_setup_rejected_rr", null, 1.31), d("skipped_tp_too_small"),
    d("skipped_no_impulse_zone"),
  ]);
  assertEquals(c.redetections, 2);
  assertEquals(c.byStatus.redetection_of_active_order, 2);
  assertEquals(c.byStatus.zone_setup_insert_failed, undefined);
  assertEquals([c.refusedDecisions, c.approxDistinctRefusedSetups], [4, 3]);
  assertEquals(c.approxDistinctRefusedByStatus, { zone_setup_rejected_rr: 2, skipped_tp_too_small: 1 });
});

Deno.test("the CLI is read-only: no insert / update / upsert / delete / rpc anywhere in it", () => {
  const cli = Deno.readTextFileSync(new URL("../../../local-runner/baseline-a-report.ts", import.meta.url));
  assert(!/\.(insert|update|upsert|delete|rpc)\(/.test(cli));
  assert(cli.includes('cohortOf(r) === "baseline_a"') && cli.includes('cohortOf(r) === "historical_dry_run"'));
});

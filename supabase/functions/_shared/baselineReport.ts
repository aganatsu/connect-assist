/**
 * BASELINE A strategy report — pure metrics over trade_attribution rows (no I/O, no writes).
 * Spec: docs/BASELINE_A_REPORT_SPEC_V1.md.
 *
 * trade_attribution is the source of truth: one row per placed Route 2 order, written with the
 * order and kept current by the lifecycle / settlement triggers. paper_trade_history is not used
 * (its entry-telemetry columns are never filled at settlement).
 *
 * Cohorts are never pooled:
 *   baseline_a          real orders on the frozen config, decided at or after the unlock;
 *   historical_dry_run  dry-run orders decided before the unlock (17-A re-anchor and 17-B
 *                       log-only TP gate applied to them only, and caps never bound) — context;
 *   excluded            anything else (counted, never measured).
 */
import { type Bar, fxOpen } from "./hypotheticalOutcome.ts";

export const BASELINE_A = {
  configVersion: "1037e6170289f865e4d6618dcf28b94d",
  route: "route2_pending_confirmation",
  primaryEngine: "impulse_zone",
  /** paper_accounts.entries_locked_at written by UNLOCK_ATOMIC_AT_ZERO_DRY.sql (2026-10-09 17:22:40.402828+00). */
  unlockedAt: "2026-10-09T17:22:40.402828Z",
} as const;
// Date.parse keeps milliseconds: .402828 → .402. Harmless — no real order can exist before the unlock.
export const BASELINE_A_FROM_MS = Date.parse(BASELINE_A.unlockedAt);

const BAR_MS = 5 * 60_000;

export interface AttributionRow {
  signal_id: string;
  symbol: string;
  direction: "long" | "short";
  dry_run: boolean;
  config_version: string;
  route: string;
  primary_engine: string;
  decision_at: string;
  order_placed_at: string | null;
  touched_at: string | null;
  confirmed_at: string | null;
  filled_at: string | null;
  closed_at: string | null;
  entry_source: string | null;
  confirmation: { tier?: unknown; type?: unknown; timeframe?: unknown } | null;
  terminal_status: string | null;
  terminal_reason: string | null;
  stop_source: string | null;
  stop_distance_pips: number | string | null;
  fill_stop_distance_pips: number | string | null;
  fill_inside_floor: boolean | null;
  intended_risk_usd: number | string | null;
  intended_risk_pct: number | string | null;
  fill_risk_usd: number | string | null;
  fill_risk_pct: number | string | null;
  fill_price: number | string | null;
  fill_stop_price: number | string | null;
  exit_reason: string | null;
  realized_pnl_usd: number | string | null;
  realized_r_gross: number | string | null;
  realized_r_net: number | string | null;
}

export type Cohort = "baseline_a" | "historical_dry_run" | "excluded";

export function cohortOf(r: Pick<AttributionRow, "dry_run" | "config_version" | "route" | "primary_engine" | "decision_at">): Cohort {
  const at = Date.parse(r.decision_at);
  if (!r.dry_run && r.config_version === BASELINE_A.configVersion && r.route === BASELINE_A.route
      && r.primary_engine === BASELINE_A.primaryEngine && at >= BASELINE_A_FROM_MS) return "baseline_a";
  if (r.dry_run && at < BASELINE_A_FROM_MS) return "historical_dry_run";
  return "excluded";
}

const num = (x: unknown): number | null => (x == null || x === "" ? null : Number.isFinite(Number(x)) ? Number(x) : null);
const ms = (s: string | null) => (s ? Date.parse(s) : null);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const rate = (n: number, d: number) => (d > 0 ? n / d : null);
const countBy = <T>(xs: T[], key: (x: T) => string) =>
  xs.reduce<Record<string, number>>((acc, x) => { const k = key(x); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});

// ── MAE / MFE from stored 5-minute bars ──────────────────────────────────────

export type MaeMfe =
  | { status: "ok"; maePips: number; mfePips: number; maeR: number; mfeR: number; bars: number }
  | { status: "gap" | "no_bars" | "invalid"; reason: string };

/**
 * Maximum adverse / favourable excursion between fill and close, from 5-minute bars (the bars the
 * outcome resolver replays). Bar-granular: the fill bar and the close bar may include price action
 * just before the fill / after the close, so both numbers are upper bounds within one bar.
 * A missing bar while the FX market was open makes the result "gap" (never guessed).
 */
export function maeMfe(i: {
  direction: "long" | "short"; fillPrice: number | null; stopPrice: number | null;
  filledAtMs: number | null; closedAtMs: number | null; pipSize: number;
}, bars: Bar[]): MaeMfe {
  if (i.fillPrice == null || i.stopPrice == null || i.filledAtMs == null || i.closedAtMs == null || i.closedAtMs < i.filledAtMs
      || i.fillPrice === i.stopPrice || !(i.pipSize > 0)) return { status: "invalid", reason: "fill, stop, fill time or close time missing" };
  const first = Math.floor(i.filledAtMs / BAR_MS) * BAR_MS;
  const inWindow = bars.filter((b) => b.t >= first && b.t < i.closedAtMs! && b.t + BAR_MS > i.filledAtMs!);
  if (!inWindow.length) return { status: "no_bars", reason: "no 5m bar between fill and close" };
  const have = new Set(inWindow.map((b) => b.t));
  for (let t = first; t < i.closedAtMs; t += BAR_MS) {
    if (!have.has(t) && fxOpen(t)) return { status: "gap", reason: `missing 5m bar at ${new Date(t).toISOString()} while the FX market was open` };
  }
  const hi = Math.max(...inWindow.map((b) => b.h));
  const lo = Math.min(...inWindow.map((b) => b.l));
  const fav = i.direction === "long" ? hi - i.fillPrice : i.fillPrice - lo;
  const adv = i.direction === "long" ? i.fillPrice - lo : hi - i.fillPrice;
  const risk = Math.abs(i.fillPrice - i.stopPrice);
  const mfe = Math.max(0, fav), mae = Math.max(0, adv);
  return { status: "ok", maePips: mae / i.pipSize, mfePips: mfe / i.pipSize, maeR: mae / risk, mfeR: mfe / risk, bars: inWindow.length };
}

// ── the summary ──────────────────────────────────────────────────────────────

export interface Stat { n: number; median: number | null; mean: number | null }
const stat = (xs: number[]): Stat => ({ n: xs.length, median: median(xs), mean: mean(xs) });
const minutes = (a: string | null, b: string | null) => {
  const x = ms(a), y = ms(b);
  return x != null && y != null && y >= x ? (y - x) / 60_000 : null;
};
const defined = (xs: (number | null)[]) => xs.filter((x): x is number => x != null);

export interface OutcomeStats {
  closed: number; wins: number; losses: number; breakeven: number; winRate: number | null;
  avgGrossR: number | null; avgNetR: number | null; netRMissing: number;
  avgWinR: number | null; avgLossR: number | null;
  /** mean net R per closed trade = winRate × avgWin − lossRate × |avgLoss| (net of the cost estimate) */
  expectancyNetR: number | null;
  expectancyGrossR: number | null;
  realizedPnlUsd: number; avgPnlUsd: number | null; pnlMissing: number;
  byExitReason: Record<string, number>;
}

function outcomes(rows: AttributionRow[]): OutcomeStats {
  const closed = rows.filter((r) => r.closed_at != null && num(r.realized_r_gross) != null);
  const g = closed.map((r) => num(r.realized_r_gross)!);
  const n = defined(closed.map((r) => num(r.realized_r_net)));
  const pnl = defined(closed.map((r) => num(r.realized_pnl_usd)));
  const wins = g.filter((x) => x > 0), losses = g.filter((x) => x < 0);
  return {
    closed: closed.length, wins: wins.length, losses: losses.length, breakeven: g.length - wins.length - losses.length,
    winRate: rate(wins.length, closed.length),
    avgGrossR: mean(g), avgNetR: mean(n), netRMissing: closed.length - n.length,
    avgWinR: mean(wins), avgLossR: mean(losses),
    expectancyNetR: mean(n), expectancyGrossR: mean(g),
    realizedPnlUsd: pnl.reduce((a, b) => a + b, 0), avgPnlUsd: mean(pnl), pnlMissing: closed.length - pnl.length,
    byExitReason: countBy(closed, (r) => r.exit_reason ?? "unknown"),
  };
}

export interface Breakdown {
  orders: number; fills: number; fillRate: number | null; closed: number; winRate: number | null;
  avgGrossR: number | null; avgNetR: number | null; realizedPnlUsd: number;
}
function breakdown(rows: AttributionRow[], key: (r: AttributionRow) => string): Record<string, Breakdown> {
  const groups: Record<string, AttributionRow[]> = {};
  for (const r of rows) (groups[key(r)] ??= []).push(r);
  return Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)).map(([k, g]) => {
    const fills = g.filter((r) => r.filled_at != null).length;
    const o = outcomes(g);
    return [k, { orders: g.length, fills, fillRate: rate(fills, g.length), closed: o.closed, winRate: o.winRate,
      avgGrossR: o.avgGrossR, avgNetR: o.avgNetR, realizedPnlUsd: o.realizedPnlUsd }];
  }));
}

export interface Summary {
  funnel: {
    orders: number; touched: number; confirmed: number; fills: number; closed: number;
    openOrders: number; openPositions: number; byTerminal: Record<string, number>;
  };
  rates: {
    touch: number | null; fill: number | null; invalidated: number | null; cancelled: number | null;
    expired: number | null; expiredNeverTouched: number | null; expiredAfterTouch: number | null;
    superseded: number | null; blocked: number | null;
  };
  outcomes: OutcomeStats;
  maeMfe: { ok: number; unavailable: Record<string, number>; maeR: Stat; mfeR: Stat; maePips: Stat; mfePips: Stat };
  risk: {
    intendedUsd: Stat; fillUsd: Stat; fillOverIntended: Stat; intendedPct: Stat; fillPct: Stat;
    stopDistancePips: Stat; fillStopDistancePips: Stat; stopSource: Record<string, number>; fillInsideFloor: number;
  };
  timingMinutes: {
    decisionToOrder: Stat; orderToTouch: Stat; touchToConfirm: Stat; confirmToFill: Stat; fillToClose: Stat;
    decisionToFill: Stat; resetsPerOrder: Stat;
  };
  byPair: Record<string, Breakdown>;
  byEntrySource: Record<string, Breakdown>;
  byConfirmationTier: Record<string, Breakdown>;
  byConfirmationType: Record<string, Breakdown>;
}

export function summarize(rows: AttributionRow[], extra: { maeMfe?: Map<string, MaeMfe>; resets?: Map<string, number> } = {}): Summary {
  const orders = rows.length;
  const term = (s: string) => rows.filter((r) => r.terminal_status === s).length;
  const filled = rows.filter((r) => r.filled_at != null);
  const expired = rows.filter((r) => r.terminal_status === "expired");
  const mm = rows.map((r) => extra.maeMfe?.get(r.signal_id)).filter((x): x is MaeMfe => x != null);
  const ok = mm.filter((x): x is Extract<MaeMfe, { status: "ok" }> => x.status === "ok");
  const ratio = defined(filled.map((r) => {
    const f = num(r.fill_risk_usd), i = num(r.intended_risk_usd);
    return f != null && i != null && i > 0 ? f / i : null;
  }));
  return {
    funnel: {
      orders, touched: rows.filter((r) => r.touched_at != null).length, confirmed: rows.filter((r) => r.confirmed_at != null).length,
      fills: filled.length, closed: rows.filter((r) => r.closed_at != null).length,
      openOrders: rows.filter((r) => r.terminal_status == null).length,
      openPositions: filled.filter((r) => r.closed_at == null).length,
      byTerminal: countBy(rows, (r) => r.terminal_status ?? "open"),
    },
    rates: {
      touch: rate(rows.filter((r) => r.touched_at != null).length, orders),
      fill: rate(filled.length, orders),
      invalidated: rate(term("invalidated"), orders),
      cancelled: rate(term("cancelled"), orders),
      expired: rate(expired.length, orders),
      expiredNeverTouched: rate(expired.filter((r) => r.terminal_reason === "EXPIRED_NEVER_TOUCHED").length, orders),
      expiredAfterTouch: rate(expired.filter((r) => r.terminal_reason === "EXPIRED_AFTER_TOUCH_NO_CONFIRMATION").length, orders),
      superseded: rate(term("superseded"), orders),
      blocked: rate(term("blocked_caps") + term("blocked_risk_gate") + term("entries_locked"), orders),
    },
    outcomes: outcomes(rows),
    maeMfe: {
      ok: ok.length,
      unavailable: countBy(mm.filter((x) => x.status !== "ok"), (x) => x.status),
      maeR: stat(ok.map((x) => x.maeR)), mfeR: stat(ok.map((x) => x.mfeR)),
      maePips: stat(ok.map((x) => x.maePips)), mfePips: stat(ok.map((x) => x.mfePips)),
    },
    risk: {
      intendedUsd: stat(defined(rows.map((r) => num(r.intended_risk_usd)))),
      fillUsd: stat(defined(filled.map((r) => num(r.fill_risk_usd)))),
      fillOverIntended: stat(ratio),
      intendedPct: stat(defined(rows.map((r) => num(r.intended_risk_pct)))),
      fillPct: stat(defined(filled.map((r) => num(r.fill_risk_pct)))),
      stopDistancePips: stat(defined(rows.map((r) => num(r.stop_distance_pips)))),
      fillStopDistancePips: stat(defined(filled.map((r) => num(r.fill_stop_distance_pips)))),
      stopSource: countBy(rows, (r) => r.stop_source ?? "unknown"),
      fillInsideFloor: filled.filter((r) => r.fill_inside_floor === true).length,
    },
    timingMinutes: {
      decisionToOrder: stat(defined(rows.map((r) => minutes(r.decision_at, r.order_placed_at)))),
      orderToTouch: stat(defined(rows.map((r) => minutes(r.order_placed_at, r.touched_at)))),
      touchToConfirm: stat(defined(rows.map((r) => minutes(r.touched_at, r.confirmed_at)))),
      confirmToFill: stat(defined(rows.map((r) => minutes(r.confirmed_at, r.filled_at)))),
      fillToClose: stat(defined(rows.map((r) => minutes(r.filled_at, r.closed_at)))),
      decisionToFill: stat(defined(rows.map((r) => minutes(r.decision_at, r.filled_at)))),
      resetsPerOrder: stat(extra.resets ? rows.map((r) => extra.resets!.get(r.signal_id) ?? 0) : []),
    },
    byPair: breakdown(rows, (r) => r.symbol),
    byEntrySource: breakdown(rows, (r) => r.entry_source ?? "unknown"),
    byConfirmationTier: breakdown(rows.filter((r) => r.confirmed_at != null), (r) => String(r.confirmation?.tier ?? "unknown")),
    byConfirmationType: breakdown(rows.filter((r) => r.confirmed_at != null), (r) => String(r.confirmation?.type ?? "unknown")),
  };
}

// ── pre-order context (smc_scan_decision) ────────────────────────────────────

export interface DecisionRow { symbol: string; scanned_at: string; status: string | null; skip: string | null; direction: string | null; entry: string | number | null }

/** zone_setup_insert_failed with "already active" = the setup was re-detected while its order was
 *  awaiting confirmation (unique active-order index): neither a failure nor a new signal. */
export const isRedetection = (d: Pick<DecisionRow, "status" | "skip">) =>
  d.status === "zone_setup_insert_failed" && /already active/i.test(d.skip ?? "");

const REFUSED = /^(zone_setup_rejected_|skipped_tp_too_small)/;

export function decisionContext(rows: DecisionRow[]) {
  const status = countBy(rows, (d) => (isRedetection(d) ? "redetection_of_active_order" : d.status ?? "unknown"));
  const refused = rows.filter((d) => d.status && REFUSED.test(d.status));
  // approximate: no zone id is recorded on a decision, so a setup is (pair, direction, entry, refusal)
  const distinct = new Set(refused.map((d) => `${d.symbol}|${d.direction}|${num(d.entry) == null ? "?" : Math.round(num(d.entry)! * 1e5) / 1e5}|${d.status}`));
  return {
    decisions: rows.length,
    byStatus: Object.fromEntries(Object.entries(status).sort(([, a], [, b]) => b - a)),
    redetections: rows.filter(isRedetection).length,
    refusedDecisions: refused.length,
    approxDistinctRefusedSetups: distinct.size,
    approxDistinctRefusedByStatus: countBy([...distinct], (k) => k.split("|")[3]),
  };
}

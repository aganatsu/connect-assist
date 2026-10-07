/**
 * STEP 13 — equity-based account risk limits (FTMO 2-Step-style profile).
 *
 * Pure functions; the gate (propFirmGate.ts) does the I/O. Every number comes
 * from the profile row (prop_firm_config) — nothing FTMO-specific is
 * hard-coded here:
 *
 *   hard daily limit      initial × max_daily_loss_pct          (FTMO: 5%)
 *   hard overall floor    initial × (1 − max_overall_loss_pct)  (FTMO: $90,000)
 *   our daily buffers     initial × daily_entry_stop_pct / daily_flatten_pct
 *   our overall buffers   overall_entry_stop_equity / overall_flatten_equity
 *
 * Daily loss = day-start BALANCE (ledger balance at 00:00 in the profile's
 * day_boundary_tz) − current EQUITY. Equity = balance (all realized P/L) +
 * floating P/L in USD − commissions − swaps of open positions.
 *
 * Fail-closed rule: missing data (rates, prices, ledger, profile values)
 * blocks new entries and fills, and NEVER flattens. Only a successful
 * calculation that crosses a flatten threshold can flatten.
 *
 * No size reduction and no profit-target shutdown exist in this path.
 */
import { getQuoteToUSDRate, SPECS } from "./smcAnalysis.ts";
import { requiredRatePairs } from "./rateMapPolicy.ts";

// ─── Trading day ─────────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();
function localParts(at: Date, tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second) };
}

/** UTC instant of local midnight starting `date` (YYYY-MM-DD) in `tz`. */
function localMidnightUtc(date: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  // Midnight local is between 14:00 the previous day and 12:00 the same day
  // in UTC for any real zone; step hourly and take the first instant whose
  // local date is `date`.
  for (let h = -14; h <= 14; h++) {
    const t = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - h * 3600_000);
    const lp = localParts(t, tz);
    if (lp.date === date && lp.hour === 0 && lp.minute === 0) return t;
  }
  throw new Error(`no local midnight for ${date} in ${tz}`);
}

export interface TradingDay {
  /** Local date in the boundary zone, "YYYY-MM-DD". */
  tradingDay: string;
  startsAt: Date;
  endsAt: Date;
}

/**
 * THE trading-day boundary (the only one): the local date in `tz`
 * (FTMO: Europe/Prague, i.e. midnight CE(S)T — 22:00 UTC in summer,
 * 23:00 UTC in winter).
 */
export function tradingDayAt(at: Date, tz = "Europe/Prague"): TradingDay {
  const { date } = localParts(at, tz);
  const startsAt = localMidnightUtc(date, tz);
  const next = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + 1));
  const endsAt = localMidnightUtc(next.toISOString().slice(0, 10), tz);
  return { tradingDay: date, startsAt, endsAt };
}

// ─── Day-start balance ───────────────────────────────────────────────────────

export interface LedgerRow { balance_after: number | string; created_at: string; kind?: string }

/**
 * Balance at the boundary, from the settlement ledger of the CURRENT epoch:
 * the last row before the boundary; if the epoch began after the boundary
 * (a reset during the day), the epoch's first row (the reset itself).
 */
export function dayStartBalanceFromLedger(
  lastBeforeBoundary: LedgerRow | null,
  firstOfEpoch: LedgerRow | null,
): { ok: true; balance: number; source: "ledger_before_boundary" | "epoch_start" } | { ok: false; reason: string } {
  const row = lastBeforeBoundary ?? firstOfEpoch;
  const v = row ? Number(row.balance_after) : NaN;
  if (!row || !Number.isFinite(v) || v <= 0) return { ok: false, reason: "no ledger balance for the day boundary" };
  return { ok: true, balance: v, source: lastBeforeBoundary ? "ledger_before_boundary" : "epoch_start" };
}

// ─── Equity ──────────────────────────────────────────────────────────────────

export interface OpenPositionInput {
  symbol: string;
  direction: string;
  size: number | string;
  entry_price: number | string;
  current_price?: number | string | null;
  /** Accrued swap in USD (negative = cost). Paper positions have none. */
  swap?: number | string | null;
  /** Commission already charged in USD (positive = cost). Paper positions have none. */
  commission?: number | string | null;
  position_id?: string;
}

export interface PositionValuation {
  position_id: string | null;
  symbol: string;
  direction: string;
  lots: number;
  entry: number;
  current: number;
  priceDiff: number;
  lotUnits: number;
  quoteToUSD: number;
  floatingUsd: number;
  commissionUsd: number;
  swapUsd: number;
}

export type EquityResult =
  | { ok: true; equity: number; balance: number; floatingUsd: number; commissionsUsd: number; swapsUsd: number; positions: PositionValuation[] }
  | { ok: false; reason: string; balance: number; positions: PositionValuation[] };

const num = (v: unknown) => (v === null || v === undefined || v === "" ? NaN : Number(v));

/**
 * balance + Σ(floating P/L in USD) − Σ commissions + Σ swaps.
 * `commissionPerLotRoundTrip`: cost per lot not yet charged on open positions
 * (0 on paper — paper does not charge commission).
 */
export function computeEquity(i: {
  balance: number;
  positions: OpenPositionInput[];
  rateMap: Record<string, number> | undefined;
  commissionPerLotRoundTrip?: number;
}): EquityResult {
  const valued: PositionValuation[] = [];
  if (!(Number.isFinite(i.balance) && i.balance > 0)) return { ok: false, reason: "balance missing", balance: i.balance, positions: valued };
  let floating = 0, commissions = 0, swaps = 0;
  for (const p of i.positions) {
    const spec = SPECS[p.symbol];
    if (!spec) return { ok: false, reason: `no contract spec for ${p.symbol}`, balance: i.balance, positions: valued };
    const missing = requiredRatePairs([p.symbol]).find((pair) => !(i.rateMap?.[pair] && i.rateMap[pair] > 0));
    if (missing) return { ok: false, reason: `missing FX rate ${missing} for ${p.symbol}`, balance: i.balance, positions: valued };
    const lots = num(p.size), entry = num(p.entry_price), current = num(p.current_price);
    if (!(lots > 0) || !(entry > 0) || !(current > 0)) {
      return { ok: false, reason: `missing size/entry/current price for ${p.symbol} ${p.position_id ?? ""}`.trim(), balance: i.balance, positions: valued };
    }
    // Same formula as every settlement (calcPnl / flattenPnl): price move ×
    // contract size × lots × quote→USD. The rate is known to be present.
    const priceDiff = p.direction === "long" ? current - entry : entry - current;
    const quoteToUSD = getQuoteToUSDRate(p.symbol, i.rateMap);
    const pnl = priceDiff * spec.lotUnits * lots * quoteToUSD;
    const charged = Number.isFinite(num(p.commission)) ? num(p.commission) : 0;
    const commissionUsd = charged + (i.commissionPerLotRoundTrip ?? 0) * lots;
    const swapUsd = Number.isFinite(num(p.swap)) ? num(p.swap) : 0;
    floating += pnl; commissions += commissionUsd; swaps += swapUsd;
    valued.push({
      position_id: p.position_id ?? null, symbol: p.symbol, direction: p.direction, lots, entry, current,
      priceDiff,
      lotUnits: spec.lotUnits, quoteToUSD, floatingUsd: pnl, commissionUsd, swapUsd,
    });
  }
  return { ok: true, equity: i.balance + floating - commissions + swaps, balance: i.balance, floatingUsd: floating, commissionsUsd: commissions, swapsUsd: swaps, positions: valued };
}

// ─── Profile ─────────────────────────────────────────────────────────────────

export interface RiskProfile {
  initial_balance: number;
  max_daily_loss_pct: number;          // hard (FTMO 0.05)
  max_overall_loss_pct: number;        // hard (FTMO 0.10 → floor 90,000)
  daily_entry_stop_pct: number;        // ours, e.g. 0.03
  daily_flatten_pct: number;           // ours, e.g. 0.04
  overall_entry_stop_equity: number;   // ours, e.g. 92,000
  overall_flatten_equity: number;      // ours, e.g. 91,000
  close_on_breach: boolean;
  day_boundary_tz: string;
}

export function validateProfile(raw: Record<string, unknown> | null | undefined):
  { ok: true; profile: RiskProfile; hardDailyLimitUsd: number; hardOverallFloor: number } | { ok: false; reason: string } {
  if (!raw) return { ok: false, reason: "no risk profile" };
  const n = (k: string) => Number(raw[k]);
  const p: RiskProfile = {
    initial_balance: n("initial_balance"),
    max_daily_loss_pct: n("max_daily_loss_pct"),
    max_overall_loss_pct: n("max_overall_loss_pct"),
    daily_entry_stop_pct: raw.daily_entry_stop_pct == null ? NaN : n("daily_entry_stop_pct"),
    daily_flatten_pct: raw.daily_flatten_pct == null ? NaN : n("daily_flatten_pct"),
    overall_entry_stop_equity: raw.overall_entry_stop_equity == null ? NaN : n("overall_entry_stop_equity"),
    overall_flatten_equity: raw.overall_flatten_equity == null ? NaN : n("overall_flatten_equity"),
    close_on_breach: raw.close_on_breach === true,
    day_boundary_tz: typeof raw.day_boundary_tz === "string" && raw.day_boundary_tz ? raw.day_boundary_tz : "",
  };
  const hardFloor = p.initial_balance * (1 - p.max_overall_loss_pct);
  const fails: string[] = [];
  if (!(p.initial_balance > 0)) fails.push("initial_balance");
  if (!(p.max_daily_loss_pct > 0 && p.max_daily_loss_pct < 1)) fails.push("max_daily_loss_pct");
  if (!(p.max_overall_loss_pct > 0 && p.max_overall_loss_pct < 1)) fails.push("max_overall_loss_pct");
  if (!(p.daily_entry_stop_pct > 0 && p.daily_entry_stop_pct < p.daily_flatten_pct && p.daily_flatten_pct < p.max_daily_loss_pct)) {
    fails.push("daily thresholds must satisfy 0 < entry stop < flatten < hard limit");
  }
  if (!(p.overall_entry_stop_equity < p.initial_balance && p.overall_flatten_equity < p.overall_entry_stop_equity && p.overall_flatten_equity > hardFloor)) {
    fails.push("overall thresholds must satisfy hard floor < flatten < entry stop < initial");
  }
  if (!p.day_boundary_tz) fails.push("day_boundary_tz");
  else { try { new Intl.DateTimeFormat("en", { timeZone: p.day_boundary_tz }); } catch { fails.push("day_boundary_tz invalid"); } }
  if (fails.length) return { ok: false, reason: `invalid risk profile: ${fails.join("; ")}` };
  return { ok: true, profile: p, hardDailyLimitUsd: p.initial_balance * p.max_daily_loss_pct, hardOverallFloor: hardFloor };
}

// ─── Decision ────────────────────────────────────────────────────────────────

export type RiskSeverity = "ok" | "entry_stop" | "flatten" | "data_error";

export interface RiskDecision {
  allowEntries: boolean;
  flatten: boolean;
  severity: RiskSeverity;
  reason: string;
  dailyLossUsd: number | null;
  dailyLossPctOfInitial: number | null;
  equity: number | null;
  dayStartBalance: number | null;
  thresholds: {
    dailyEntryStopUsd: number; dailyFlattenUsd: number; dailyHardLimitUsd: number;
    overallEntryStopEquity: number; overallFlattenEquity: number; overallHardFloor: number;
  } | null;
}

/** Fail closed: blocks entries and fills, never flattens. */
export function dataError(reason: string): RiskDecision {
  return { allowEntries: false, flatten: false, severity: "data_error", reason: `risk data unavailable — entries blocked, no liquidation: ${reason}`, dailyLossUsd: null, dailyLossPctOfInitial: null, equity: null, dayStartBalance: null, thresholds: null };
}

export function evaluateAccountRisk(
  rawProfile: Record<string, unknown> | null | undefined,
  dayStart: ReturnType<typeof dayStartBalanceFromLedger>,
  eq: EquityResult,
): RiskDecision {
  const v = validateProfile(rawProfile);
  if (!v.ok) return dataError(v.reason);
  if (!dayStart.ok) return dataError(dayStart.reason);
  if (!eq.ok) return dataError(eq.reason);
  const p = v.profile;
  const t = {
    dailyEntryStopUsd: p.initial_balance * p.daily_entry_stop_pct,
    dailyFlattenUsd: p.initial_balance * p.daily_flatten_pct,
    dailyHardLimitUsd: v.hardDailyLimitUsd,
    overallEntryStopEquity: p.overall_entry_stop_equity,
    overallFlattenEquity: p.overall_flatten_equity,
    overallHardFloor: v.hardOverallFloor,
  };
  const dailyLoss = dayStart.balance - eq.equity;
  const base = { dailyLossUsd: dailyLoss, dailyLossPctOfInitial: dailyLoss / p.initial_balance, equity: eq.equity, dayStartBalance: dayStart.balance, thresholds: t };
  const $ = (x: number) => `$${x.toFixed(2)}`;
  const flat = (why: string): RiskDecision => ({ allowEntries: false, flatten: p.close_on_breach, severity: "flatten", reason: why, ...base });
  if (dailyLoss >= t.dailyFlattenUsd) return flat(`daily loss ${$(dailyLoss)} ≥ flatten ${$(t.dailyFlattenUsd)} (hard limit ${$(t.dailyHardLimitUsd)})`);
  if (eq.equity <= t.overallFlattenEquity) return flat(`equity ${$(eq.equity)} ≤ flatten floor ${$(t.overallFlattenEquity)} (hard floor ${$(t.overallHardFloor)})`);
  if (dailyLoss >= t.dailyEntryStopUsd) return { allowEntries: false, flatten: false, severity: "entry_stop", reason: `daily loss ${$(dailyLoss)} ≥ entry stop ${$(t.dailyEntryStopUsd)}`, ...base };
  if (eq.equity <= t.overallEntryStopEquity) return { allowEntries: false, flatten: false, severity: "entry_stop", reason: `equity ${$(eq.equity)} ≤ entry-stop floor ${$(t.overallEntryStopEquity)}`, ...base };
  return { allowEntries: true, flatten: false, severity: "ok", reason: `daily loss ${$(Math.max(0, dailyLoss))} of ${$(t.dailyEntryStopUsd)}; equity ${$(eq.equity)} (floor ${$(t.overallEntryStopEquity)})`, ...base };
}

// Canonical 1H structure bars: validity, price-grid rounding and the D9 settlement rule. PURE — no database, no clock.
//
// Decisions (docs/V3_2C_DECISION_RECORD_V1.md; D9 as amended 2026-10-15):
//   - The canonical 1H bar is the FIRST VALID OBSERVATION MADE AT LEAST 15 MINUTES AFTER THAT BAR'S CLOSE. Earlier
//     observations may be logged but never become canonical; later differing observations are revision telemetry only
//     and never rewrite canonical history. Why: first observations differed from settled values on 7.8–12.3% of measured
//     bars (up to 7.2 pips); first observations ≥ 15 min after close matched the settled / research values on 100% of the
//     measured sample; V3.2c is path-dependent, so a frozen preliminary candle becomes structural drift. +15 min is the
//     settlement delay chosen from that evidence — NOT a provider guarantee — and stays telemetry-monitored.
//   - Price grid (approved 2026-10-15): ALL SIX PAIRS ARE ROUNDED TO 5 DECIMAL PLACES before canonical storage. The provider
//     quotes all six to 5 dp, JPY included; 3-dp JPY rounding would change most JPY bars and the validated USD/JPY V3.2c
//     structure; 5 dp keeps USD/JPY and CHF/JPY research-equivalent and normalizes 2025 float32 storage artefacts
//     (0.82586002 → 0.82586). NZD/CAD and NZD/CHF may show small historical structural differences because those artefacts
//     are intentionally normalized out — an accepted canonical-data cleanup, not a strategy-rule change.
//   - History 2025-04-16 21:00Z → 2026-10-09 21:00Z comes only from the approved research import (D19, Q2).
//   - The reserved V2.1.1 OOS window stays untouched: the live writer may not write any bar before
//     max(release, 2026-10-23 21:00Z); the span 2026-10-09 21:00Z → release is filled later from smc_scan_bars (D26).
// FX hours: fxOpenNY below is the frozen V3.2c rule (the vendored V3.2c timeframes module fxOpen), copied so that NO production
// function imports the vendored V3.2c module (its timeframes.ts imports engine.ts). A test asserts equality with the frozen
// fxOpen for every hour 2024–2027, so the store and the frozen aggregation can never disagree.

const nyFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", weekday: "short" });
/** FX session open (closed Fri 17:00 → Sun 17:00 America/New_York) — identical to the frozen V3.2c fxOpen. */
export function fxOpenNY(t: number): boolean {
  const p = Object.fromEntries(nyFmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const h = +p.hour % 24, wd = p.weekday;
  return !(wd === "Sat" || (wd === "Fri" && h >= 17) || (wd === "Sun" && h < 17));
}

export const STRUCTURE_PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY", "CHF/JPY", "NZD/CAD", "NZD/CHF"] as const;
export const H1_MS = 3_600_000;
export const SETTLE_MS = 15 * 60_000;
export const EPOCH_MS = Date.parse("2025-04-16T21:00:00Z");
export const RESEARCH_IMPORT_END_MS = Date.parse("2026-10-09T21:00:00Z"); // exclusive
export const MIN_LIVE_RELEASE_MS = Date.parse("2026-10-23T21:00:00Z"); // the reserved OOS window closes Friday 2026-10-23 17:00 NY

export type BarSource = "research_import" | "scanner_live" | "smc_scan_bars_fill";
/** Data-quality reasons are logged; ownership reasons (another path owns that span) are only counted. */
export type RejectReason =
  | "unknown_symbol" | "ohlc_inconsistent" | "off_grid" | "outside_fx_hours" | "not_closed" | "not_settled" // data quality / timing
  | "before_epoch" | "outside_source_span"; // ownership
export const LOGGED_REJECTIONS: ReadonlySet<RejectReason> = new Set(["unknown_symbol", "ohlc_inconsistent", "off_grid", "outside_fx_hours", "not_settled"]);

export interface Observation {
  symbol: string;
  barTime: number; // open time, UTC ms
  o: number; h: number; l: number; c: number;
  observedAt: number; // UTC ms; conservative (see the scanner writer)
  provider: string | null;
}
export interface SourceSpan { source: BarSource; sourceRef: string | null; minBarTime: number; maxBarTimeExclusive: number }
export interface CanonicalRow {
  symbol: string; bar_time: string; open: number; high: number; low: number; close: number;
  provider: string | null; source: BarSource; source_ref: string | null; observed_at: string;
}
export type Evaluation =
  | { kind: "candidate"; row: CanonicalRow; hash: string }
  | { kind: "rejected"; reason: RejectReason; obs: Observation; hash: string };

const iso = (ms: number) => new Date(ms).toISOString();

/** Canonical price grid: 5 decimal places for all six pairs (JPY included) — the provider's quoted precision. */
export const PRICE_DECIMALS = 5;
export function priceDecimals(symbol: string): number {
  if (!STRUCTURE_PAIRS.includes(symbol as typeof STRUCTURE_PAIRS[number])) throw new Error(`not a structure pair: ${symbol}`);
  return PRICE_DECIMALS;
}
/** Round to the 5-dp grid, symmetric in sign (0.82586002 → 0.82586). */
export function roundToGrid(symbol: string, x: number): number {
  const k = 10 ** priceDecimals(symbol);
  return (Math.sign(x) * Math.round(Math.abs(x) * k)) / k;
}
export function valueHash(symbol: string, o: number, h: number, l: number, c: number): string {
  const d = STRUCTURE_PAIRS.includes(symbol as typeof STRUCTURE_PAIRS[number]) ? priceDecimals(symbol) : 8;
  return [o, h, l, c].map((v) => (Number.isFinite(v) ? v.toFixed(d) : "NaN")).join("|");
}

/** Classify one observation for one ingestion path. Order: identity → geometry → ownership → timing → OHLC. */
export function evaluateObservation(obs: Observation, span: SourceSpan): Evaluation {
  const known = STRUCTURE_PAIRS.includes(obs.symbol as typeof STRUCTURE_PAIRS[number]);
  const rounded = known ? [obs.o, obs.h, obs.l, obs.c].map((v) => roundToGrid(obs.symbol, v)) : [obs.o, obs.h, obs.l, obs.c];
  const [o, h, l, c] = rounded;
  const hash = valueHash(obs.symbol, o, h, l, c);
  const reject = (reason: RejectReason): Evaluation => ({ kind: "rejected", reason, obs, hash });
  if (!known) return reject("unknown_symbol");
  if (![obs.o, obs.h, obs.l, obs.c, obs.barTime, obs.observedAt].every(Number.isFinite)) return reject("ohlc_inconsistent");
  if (obs.barTime % H1_MS !== 0) return reject("off_grid");
  if (!fxOpenNY(obs.barTime)) return reject("outside_fx_hours");
  if (obs.barTime < EPOCH_MS) return reject("before_epoch");
  if (obs.barTime < span.minBarTime || obs.barTime >= span.maxBarTimeExclusive) return reject("outside_source_span");
  if (obs.observedAt < obs.barTime + H1_MS) return reject("not_closed");
  if (obs.observedAt < obs.barTime + H1_MS + SETTLE_MS) return reject("not_settled");
  if (!(h >= Math.max(o, c) && l <= Math.min(o, c) && h >= l)) return reject("ohlc_inconsistent");
  return {
    kind: "candidate", hash,
    row: { symbol: obs.symbol, bar_time: iso(obs.barTime), open: o, high: h, low: l, close: c, provider: obs.provider, source: span.source, source_ref: span.sourceRef, observed_at: iso(obs.observedAt) },
  };
}

export interface RevisionRow extends CanonicalRow { value_hash: string; canonical_value_hash: string; max_abs_diff: number }
export interface RejectionRow {
  symbol: string; bar_time: string; reason: RejectReason; value_hash: string;
  open: number | null; high: number | null; low: number | null; close: number | null;
  provider: string | null; source: BarSource; observed_at: string;
}
export interface WritePlan { inserts: CanonicalRow[]; revisions: RevisionRow[]; rejections: RejectionRow[]; counts: Record<string, number> }

/**
 * Turn evaluations into writes, given the canonical values already stored ({bar_time ISO → {hash, ohlc}}).
 * New bar → insert (append-only, first valid settled observation wins). Existing bar, same value → nothing.
 * Existing bar, different value → revision row; the canonical row is never touched.
 */
export function planWrites(evals: Evaluation[], existing: Map<string, { hash: string; open: number; high: number; low: number; close: number }>, source: BarSource): WritePlan {
  const counts: Record<string, number> = {};
  const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
  const inserts: CanonicalRow[] = [], revisions: RevisionRow[] = [], rejections: RejectionRow[] = [];
  const seen = new Map<string, string>(); // bar_time → hash planned in THIS batch (duplicate observations within a batch)
  for (const e of evals) {
    if (e.kind === "rejected") {
      bump(`rejected:${e.reason}`);
      if (LOGGED_REJECTIONS.has(e.reason)) {
        const f = (v: number) => (Number.isFinite(v) ? v : null);
        rejections.push({ symbol: e.obs.symbol, bar_time: Number.isFinite(e.obs.barTime) ? iso(e.obs.barTime) : iso(0), reason: e.reason, value_hash: e.hash,
          open: f(e.obs.o), high: f(e.obs.h), low: f(e.obs.l), close: f(e.obs.c), provider: e.obs.provider, source, observed_at: Number.isFinite(e.obs.observedAt) ? iso(e.obs.observedAt) : iso(0) });
      }
      continue;
    }
    const key = e.row.bar_time, ex = existing.get(key) ?? (seen.has(key) ? { hash: seen.get(key)!, open: NaN, high: NaN, low: NaN, close: NaN } : undefined);
    if (!ex) { inserts.push(e.row); seen.set(key, e.hash); bump("insert"); continue; }
    if (ex.hash === e.hash) { bump("duplicate"); continue; }
    const diffs = [e.row.open - ex.open, e.row.high - ex.high, e.row.low - ex.low, e.row.close - ex.close].map(Math.abs).filter(Number.isFinite);
    revisions.push({ ...e.row, value_hash: e.hash, canonical_value_hash: ex.hash, max_abs_diff: diffs.length ? Math.max(...diffs) : 0 });
    bump("revision");
  }
  return { inserts, revisions, rejections, counts };
}

/** Candle.datetime from candleSource is ISO with Z; tolerate the provider form "YYYY-MM-DD HH:MM:SS" (UTC requested). */
export function candleTimeMs(datetime: string): number {
  const s = datetime.includes("T") ? datetime : datetime.replace(" ", "T");
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
}

/**
 * SMC scan candle observability. PURE — no database, no network, no clock.
 *
 * WHAT THIS IS FOR. No SMC engine can be determinism-tested, because the candles
 * the scanner scored were never persisted. A re-derivation from re-fetched
 * provider data tops out at 92.1% and cannot go higher: production's own inputs
 * are unrecoverable. This builds the rows that fix that, from deployment
 * forward.
 *
 * IT CHANGES NO DECISION. Everything here runs AFTER the zone engine has been
 * called and its input arrays are already fixed. Nothing in this module is read
 * by any gate, score, entry, stop or target, and the caller is required to treat
 * a write failure as a logging problem rather than a trading one.
 *
 * WHY NORMALIZED. The same 300-bar array is re-sent every five minutes with one
 * new bar on the end. Storing the array per scan costs ~249 MB/day for twelve
 * pairs across three slots; storing bars once and a manifest naming the range
 * costs ~2.5 MB/day for the same information.
 */

import type { Candle } from "./smcAnalysis.ts";

/** The frozen-behaviour label. A research control name, not a validation claim. */
export const SMC_CONTRACT_VERSION = "smc-zone-impulse-control-v1";

/** Which argument of the zone engine an array was passed as. */
export type SnapshotSlot =
  | "top" | "mid" | "low" | "entry" | "confirm" | "ltf_confirm" | "context";

export interface SnapshotInput {
  slot: SnapshotSlot;
  timeframe: string;
  candles: readonly Candle[];
  provider?: string | null;
}

export interface BarRow {
  symbol: string;
  timeframe: string;
  bar_time: string;
  /**
   * Digest of THIS observation's OHLC, and part of the primary key. A provider
   * that revises an already-closed bar then adds a row instead of silently
   * losing the value an earlier scan actually scored.
   */
  bar_hash: string;
  open: number; high: number; low: number; close: number;
  volume: number | null;
  provider: string | null;
}

export interface ManifestRow {
  scan_cycle_id: string;
  user_id: string;
  bot_id: string;
  symbol: string;
  style: string;
  slot: SnapshotSlot;
  timeframe: string;
  first_bar_time: string;
  last_bar_time: string;
  bar_count: number;
  provider: string | null;
  last_bar_closed: boolean | null;
  fetched_at: string | null;
  content_hash: string;
  contract_version: string;
  /**
   * The final bar when it was still forming, kept here rather than in the bar
   * table. Its OHLC changes every scan until the interval closes, so writing it
   * to an immutable dedup-on-first-write store permanently freezes a partial
   * bar — which is exactly the defect this column was added to fix.
   */
  forming_bar: FormingBar | null;
}

export interface FormingBar {
  datetime: string;
  open: number; high: number; low: number; close: number;
  volume: number | null;
}

/**
 * Digest over the exact array that was scored.
 *
 * Non-cryptographic on purpose: this is a uniqueness and tamper-evidence key
 * inside one project's own tables, not a security token, and a stable
 * synchronous function keeps the module pure. Same construction the IPO paper
 * contract uses for its content-addressed ids.
 */
export function hashCandles(candles: readonly Candle[]): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const eat = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0;
      h2 = Math.imul(h2 + s.charCodeAt(i) + 1, 0x85ebca6b) >>> 0;
    }
  };
  for (const c of candles) {
    eat(`${c.datetime}|${c.open}|${c.high}|${c.low}|${c.close}|`);
  }
  eat(`n=${candles.length}`);
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/**
 * Was the newest bar still forming when it was scored?
 *
 * Stage 2 measured that the SMC path scores against a forming bar in ~61% of
 * scans, because `closedBarsOnly` is imported only by the IPO runner. Recording
 * the answer removes the need to re-derive it later — and `null` when the bar
 * length is unknown, rather than a guess.
 */
export function lastBarClosed(
  candles: readonly Candle[], nowMs: number, barMs: number | null,
): boolean | null {
  if (!candles.length || !barMs || barMs <= 0) return null;
  const last = candles[candles.length - 1];
  const t = Date.parse(last.datetime);
  if (!Number.isFinite(t)) return null;
  return t + barMs <= nowMs;
}

/** Milliseconds per bar for the intervals the scanner uses. Null when unknown. */
export function barMsOf(timeframe: string): number | null {
  const m: Record<string, number> = {
    "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
    "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000, "1w": 604_800_000,
  };
  return m[timeframe] ?? null;
}

export interface BuildArgs {
  scanCycleId: string;
  userId: string;
  botId: string;
  symbol: string;
  style: string;
  nowMs: number;
  fetchedAt?: string | null;
  inputs: readonly SnapshotInput[];
}

/**
 * Turns the arrays a scan actually used into deduplicated bar rows plus one
 * manifest row per slot.
 *
 * Empty arrays are skipped rather than written as a zero-bar manifest: a slot
 * the engine was never given is not the same as a slot it was given nothing for,
 * and only the caller knows which happened.
 */
export function buildSnapshot(args: BuildArgs): { bars: BarRow[]; manifest: ManifestRow[] } {
  const seen = new Set<string>();
  const bars: BarRow[] = [];
  const manifest: ManifestRow[] = [];

  // Which (timeframe, bar) pairs are still forming anywhere in this scan.
  // Collected up front because slots share arrays — the scalper passes the same
  // 5m array as `low`, `entry` and `ltf_confirm` — and a bar excluded from one
  // slot must not be admitted through another.
  const forming = new Set<string>();
  for (const input of args.inputs) {
    const cs = input.candles;
    if (!cs || cs.length === 0) continue;
    const closed = lastBarClosed(cs, args.nowMs, barMsOf(input.timeframe));
    // `null` means the interval length is unknown, so the bar is not PROVABLY
    // closed. Treated as forming: a wrong guess here corrupts the store
    // permanently, while an unnecessary inline copy costs a few bytes.
    if (closed !== true) forming.add(`${input.timeframe}|${cs[cs.length - 1].datetime}`);
  }

  for (const input of args.inputs) {
    const cs = input.candles;
    if (!cs || cs.length === 0) continue;

    for (const c of cs) {
      if (forming.has(`${input.timeframe}|${c.datetime}`)) continue;
      // One row per (symbol, timeframe, bar). Two slots sharing a timeframe —
      // the scalper passes 5m as both `low` and `entry` — must not double-write.
      const key = `${input.timeframe}|${c.datetime}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bars.push({
        symbol: args.symbol,
        timeframe: input.timeframe,
        bar_time: c.datetime,
        bar_hash: hashCandles([c]),
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: typeof c.volume === "number" ? c.volume : null,
        provider: input.provider ?? null,
      });
    }

    const last = cs[cs.length - 1];
    const isForming = forming.has(`${input.timeframe}|${last.datetime}`);
    manifest.push({
      scan_cycle_id: args.scanCycleId,
      user_id: args.userId,
      bot_id: args.botId,
      symbol: args.symbol,
      style: args.style,
      slot: input.slot,
      timeframe: input.timeframe,
      first_bar_time: cs[0].datetime,
      last_bar_time: cs[cs.length - 1].datetime,
      bar_count: cs.length,
      provider: input.provider ?? null,
      last_bar_closed: lastBarClosed(cs, args.nowMs, barMsOf(input.timeframe)),
      fetched_at: args.fetchedAt ?? null,
      content_hash: hashCandles(cs),
      contract_version: SMC_CONTRACT_VERSION,
      forming_bar: isForming
        ? {
          datetime: last.datetime,
          open: last.open, high: last.high, low: last.low, close: last.close,
          volume: typeof last.volume === "number" ? last.volume : null,
        }
        : null,
    });
  }

  return { bars, manifest };
}

export interface ContextRow {
  scan_cycle_id: string;
  user_id: string;
  bot_id: string;
  symbol: string;
  style: string;
  direction: string | null;
  last_price: number | null;
  tf_labels: Record<string, unknown>;
  engine_args: Record<string, unknown>;
  htf_confluence_hash: string | null;
  liquidity_pool_hash: string | null;
  /**
   * The derived bundles themselves. Stored, not re-derived: they depend on
   * detector parameters that are config-driven, and a replay that guesses one
   * wrong produces a mismatch indistinguishable from an engine defect.
   */
  htf_confluence: unknown;
  liquidity_pools: unknown;
  contract_version: string;
}

/**
 * Digest over an arbitrary derived structure.
 *
 * Key order is normalised so two structurally identical bundles hash the same
 * regardless of how they were assembled — otherwise a replay would report drift
 * every time an unrelated refactor reordered an object literal.
 */
export function hashStructure(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) {
        if (typeof o[k] === "function" || o[k] === undefined) continue;
        out[k] = norm(o[k]);
      }
      return out;
    }
    // -0 and 0 must not hash differently, and a NaN must be visible as itself.
    if (typeof v === "number" && Object.is(v, -0)) return 0;
    return v;
  };
  let s: string;
  try {
    s = JSON.stringify(norm(value)) ?? "null";
  } catch {
    return "unhashable";               // a cycle is a bug in the caller, not a crash here
  }
  return hashCandles([{ datetime: s, open: 0, high: 0, low: 0, close: 0 } as Candle]);
}

export interface ContextArgs {
  scanCycleId: string;
  userId: string;
  botId: string;
  symbol: string;
  style: string;
  direction: string | null;
  lastPrice: number | null;
  tfLabels: Record<string, unknown>;
  engineArgs: Record<string, unknown>;
  htfConfluence: unknown;
  liquidityPools: unknown;
}

/**
 * The engine arguments that are not candles.
 *
 * Stage 2E is the whole reason this exists: a replay that rebuilt the candles
 * perfectly but omitted `htfConfluenceData` agreed with production on only
 * 37.3% of AUD/USD scans. The derived bundles are hashed rather than stored —
 * they are pure functions of arrays that are already snapshotted, so a replay
 * re-derives and verifies instead of paying to keep a second copy.
 */
export function buildContext(a: ContextArgs): ContextRow {
  return {
    scan_cycle_id: a.scanCycleId,
    user_id: a.userId,
    bot_id: a.botId,
    symbol: a.symbol,
    style: a.style,
    direction: a.direction,
    last_price: Number.isFinite(a.lastPrice as number) ? a.lastPrice : null,
    tf_labels: a.tfLabels ?? {},
    engine_args: a.engineArgs ?? {},
    htf_confluence_hash: a.htfConfluence == null ? null : hashStructure(a.htfConfluence),
    liquidity_pool_hash: a.liquidityPools == null ? null : hashStructure(a.liquidityPools),
    htf_confluence: a.htfConfluence ?? null,
    liquidity_pools: a.liquidityPools ?? null,
    contract_version: SMC_CONTRACT_VERSION,
  };
}

/**
 * Rebuilds the array a manifest row describes, from stored bars.
 *
 * Exported here so the replay utility and the writer agree on the reconstruction
 * rule by construction rather than by two developers remembering the same thing.
 * Returns null when the digest does not match — a replay must fail loudly rather
 * than silently score a different array.
 */
export function reconstruct(
  manifest: Pick<ManifestRow, "first_bar_time" | "last_bar_time" | "bar_count" | "content_hash"> &
    { forming_bar?: FormingBar | null },
  storedBars: readonly Candle[],
): { candles: Candle[]; ok: true } | { candles: null; ok: false; reason: string } {
  const from = Date.parse(manifest.first_bar_time);
  const to = Date.parse(manifest.last_bar_time);
  const slice = storedBars
    .filter((c) => {
      const t = Date.parse(c.datetime);
      return t >= from && t <= to;
    })
    .sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));

  // The forming bar never entered the bar table; it lives on the manifest.
  const fb = manifest.forming_bar;
  if (fb) {
    slice.push({
      datetime: fb.datetime,
      open: fb.open, high: fb.high, low: fb.low, close: fb.close,
      volume: fb.volume ?? undefined,
    } as Candle);
  }

  if (slice.length !== manifest.bar_count) {
    return { candles: null, ok: false, reason: `bar_count ${slice.length} != ${manifest.bar_count}` };
  }
  const h = hashCandles(slice);
  if (h !== manifest.content_hash) {
    return { candles: null, ok: false, reason: `content_hash ${h} != ${manifest.content_hash}` };
  }
  return { candles: slice, ok: true };
}

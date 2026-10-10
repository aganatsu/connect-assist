/**
 * CANDIDATE C — live shadow: "always enter at the Impulse Zone midpoint".
 *
 * Baseline A (production) enters at `bestZone.refinedEntry` when the zone has
 * one, else at the zone midpoint. Candidate C differs in that ONE variable: it
 * always uses the midpoint. Everything else — the signal and every gate verdict
 * (inherited from A, including A's placement-time caps), the Route 2 stop / TP /
 * R:R / sizing rules, the 8h fixed TTL, the minute-level hunt and its
 * confirmation — is A's code.
 *
 * Isolation (what keeps A unchanged):
 *   - C orders live under their own bot id, always `dry_run = true` (the
 *     database refuses any position sourced from a dry-run order, and the
 *     one-active-order index includes bot_id, so C never collides with A);
 *   - C reads candles from the per-cycle scan cache ONLY (`peek`), never the
 *     provider: zero TwelveData credits. A minute without cached data is
 *     recorded as `shadow_no_data` and the order is left untouched;
 *   - C placement intents are built without I/O inside the pair loop and
 *     written after it, so A's writes, timing and control flow are untouched;
 *   - fill-time caps use C's own hypothetical book, never A's positions;
 *   - no Telegram, no A counters, no A scan-log arrays, separate poll-log
 *     insert under its own poller name.
 *
 * Flag: env `SMC_SHADOW_ZONEMID` = off (default) | drain | on.
 *   off   — no placement, no hunt, no shadow query at all;
 *   drain — no new placements; the hunt finishes existing C orders (≤ 8h);
 *   on    — full shadow.
 * A function secret, not bot config: the config hash is unchanged.
 */

import { passesDistanceGuard, pendingDistanceAtr, ROUTE2_MAX_PENDING_DISTANCE_ATR, type Route2EntrySource } from "./route2Forward.ts";
import { route2StopFromLimit } from "./route2StopGeometry.ts";
import { orderEffectiveRR } from "./simplification.ts";
import { fillTimeSize, type FillSizing } from "./fillTimeSizing.ts";
import type { Candle } from "./smcAnalysis.ts";
import { splitByLevel } from "./route2SameLevel.ts";
import { placeRoute2Order, type PlaceRoute2Input, type PlaceRoute2Result } from "./route2Placement.ts";

export const SHADOW_BOT_ID = "smc_shadow_zonemid";
export const SHADOW_STRATEGY_VERSION = "shadow-zonemid.v1";
export const SHADOW_POLLER_NAME = "bot-scanner:shadow-zonemid" as const;
export const SHADOW_ENV_VAR = "SMC_SHADOW_ZONEMID";
/** Evaluation-validity thresholds (owner requirement, 2026-10-09). */
export const SHADOW_MIN_COVERAGE_OVERALL = 0.9;
export const SHADOW_MIN_COVERAGE_PER_PAIR = 0.8;

export type ShadowMode = "off" | "drain" | "on";

/** Anything other than exactly "on" / "drain" (case-insensitive) is OFF. */
export function parseShadowMode(raw: string | null | undefined): ShadowMode {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "on" || v === "drain" ? v : "off";
}
export const shadowPlaces = (m: ShadowMode): boolean => m === "on";
export const shadowHunts = (m: ShadowMode): boolean => m === "on" || m === "drain";
export const isShadowOrder = (row: { bot_id?: unknown } | null | undefined): boolean => row?.bot_id === SHADOW_BOT_ID;

/**
 * "zm" + 10 hex = 12 characters. A's order ids are exactly 8 hex
 * (`randomUUID().slice(0, 8)`), so the two can never be equal — which matters
 * because the hunt's writes key on (order_id, user_id) and `ta_order_id` is
 * unique on (user_id, order_id) across bots.
 */
export function shadowOrderId(uuid: string = crypto.randomUUID()): string {
  return "zm" + uuid.replace(/-/g, "").slice(0, 10);
}

/** C is built only for Impulse Zone entries — the population A and C share. */
export const shadowEligibleSource = (s: Route2EntrySource): boolean => s === "refinedEntry" || s === "zoneMid";

/** C's limit: the same expression as A's midpoint fallback. */
export function zoneMidLimit(bestZone: { high?: unknown; low?: unknown } | null | undefined): number | null {
  const hi = bestZone?.high, lo = bestZone?.low;
  if (typeof hi !== "number" || typeof lo !== "number" || !Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return (hi + lo) / 2;
}

// ── Placement geometry ──────────────────────────────────────────────────────

export interface ShadowGeometryInput {
  direction: "long" | "short";
  limit: number;
  lastPrice: number;
  h1Atr: number | null;
  /** The market-anchored stop chain's final stop (`sl` in the scanner). */
  marketSL: number;
  tpRatio: number;
  stopAnchor: string;
  swingSL: number | null;
  impulseSL: number | null;
  impulseCapPips: number | null;
  minSlPips: number;
  pipSize: number;
  symbol: string;
  rateMap?: Record<string, number>;
  commissionPerLot?: number;
  orderRRMin: number;
  rrGateMode: string;
  sizingMode: string;
  balance: number;
  /** simp.riskPercent (fill-time sizing). */
  riskPercent: number;
  maxLotsPerTrade?: number;
  /** computePositionSize(...).lots at (entry, stop) — the scanner's legacy sizer. */
  legacyLots: (entry: number, stop: number) => number;
  /** A's 0.5× cut applies unless the signal source is unified. */
  halveLegacy: boolean;
}

export type ShadowGeometry =
  | {
    ok: true; limit: number; distanceAtr: number | null; stop: number; target: number; size: number;
    route2Stop: Record<string, unknown>; orderRR: Record<string, unknown>; plannedSizing: FillSizing | null;
  }
  | {
    ok: false; status: "zone_setup_rejected_distance" | "zone_setup_rejected_stop" | "zone_setup_rejected_rr";
    reason: string; distanceAtr: number | null; route2Stop?: Record<string, unknown>; orderRR?: Record<string, unknown>;
  };

/**
 * The Route 2 placement rules, in the order the scanner applies them to A's
 * limit: distance guard → market-anchored TP → limit-anchored stop chain →
 * order R:R gate → sizing. Pure; mirrors bot-scanner's Route 2 block
 * statement for statement (pinned by shadowZoneMid.test.ts against recorded
 * A orders), so feeding it A's limit reproduces A's order.
 */
export function shadowRoute2Geometry(i: ShadowGeometryInput): ShadowGeometry {
  const distanceAtr = pendingDistanceAtr(i.lastPrice, i.limit, i.h1Atr);
  if (!passesDistanceGuard(distanceAtr)) {
    return {
      ok: false, status: "zone_setup_rejected_distance", distanceAtr,
      reason: distanceAtr === null ? "H1 ATR unavailable"
        : `entry ${distanceAtr.toFixed(2)} ATR from price, limit ${ROUTE2_MAX_PENDING_DISTANCE_ATR}`,
    };
  }

  let limitSL = i.marketSL;
  let limitTP: number;
  const riskFromLimit = Math.abs(i.limit - i.marketSL);
  if (i.direction === "long") limitTP = i.limit + riskFromLimit * i.tpRatio;
  else limitTP = i.limit - riskFromLimit * i.tpRatio;

  const anchored = route2StopFromLimit({
    direction: i.direction, limit: i.limit, swingSL: i.swingSL, impulseSL: i.impulseSL,
    impulseCapPips: i.impulseCapPips, minSlPips: i.minSlPips, pipSize: i.pipSize, tpRatio: i.tpRatio,
  });
  const route2Stop: Record<string, unknown> = {
    anchor: i.stopAnchor,
    limitEntry: i.limit,
    market: {
      sl: limitSL, tp: limitTP, riskPipsFromLimit: riskFromLimit / i.pipSize,
      targetPips: Math.abs(limitTP - i.limit) / i.pipSize,
      belowFloor: riskFromLimit / i.pipSize < i.minSlPips,
    },
    limit: anchored.ok
      ? { ...anchored, targetPips: Math.abs(anchored.tp - i.limit) / i.pipSize, belowFloor: anchored.riskPips < i.minSlPips - 1e-9 }
      : anchored,
    floorPips: i.minSlPips,
    capPips: i.impulseCapPips,
  };
  if (i.stopAnchor === "limit") {
    if (!anchored.ok) {
      return { ok: false, status: "zone_setup_rejected_stop", distanceAtr, route2Stop, reason: `stop geometry unavailable: ${anchored.reason}` };
    }
    limitSL = anchored.sl;
    limitTP = anchored.tp;
  }

  const orr = orderEffectiveRR({ entry: i.limit, stop: limitSL, target: limitTP, symbol: i.symbol, rateMap: i.rateMap, commissionPerLot: i.commissionPerLot });
  const orrBlocks = orr.effectiveRR < i.orderRRMin;
  const orderRR = { ...orr, min: i.orderRRMin, mode: i.rrGateMode, wouldBlock: orrBlocks };
  if (i.rrGateMode === "order_geometry" && orrBlocks) {
    return { ok: false, status: "zone_setup_rejected_rr", distanceAtr, route2Stop, orderRR, reason: `order R:R ${orr.effectiveRR.toFixed(2)} effective < ${i.orderRRMin}` };
  }

  let size = i.legacyLots(i.limit, limitSL);
  if (i.halveLegacy) {
    size = Math.round(size * 0.5 * 100) / 100;
    if (size < 0.01) size = 0.01;
  }
  let plannedSizing: FillSizing | null = null;
  if (i.sizingMode === "fill_time") {
    plannedSizing = fillTimeSize({
      balance: i.balance, riskPercent: i.riskPercent, fillPrice: i.limit, stop: limitSL,
      symbol: i.symbol, rateMap: i.rateMap, commissionPerLot: i.commissionPerLot, maxLotsPerTrade: i.maxLotsPerTrade,
    });
    if (plannedSizing.ok) size = plannedSizing.lots;
  }
  return { ok: true, limit: i.limit, distanceAtr, stop: limitSL, target: limitTP, size, route2Stop, orderRR, plannedSizing };
}

// ── Placement: writing the queued intents ───────────────────────────────────

/** One C order, built inside the pair loop without I/O; written after it. */
export interface ShadowIntent {
  symbol: string;
  direction: string;
  limit: number;
  pipSize: number;
  score: number;
  lastPrice: number;
  stop: number;
  target: number;
  size: number;
  order: Record<string, unknown>;
  attribution: Record<string, unknown>;
  /** dry_run_context.shadow — the pairing fields are filled at write time. */
  shadowCtx: { pairedSignalId: string | null; aFinalStatus: string | null } & Record<string, unknown>;
  /** A's decision capture and scan detail for this setup: READ ONLY. */
  cap: { signal_id?: unknown } | null;
  detail: { status?: unknown } | null;
}

export interface ShadowWriteTally { placed: number; refreshed: number; duplicate: number; failed: number }

/**
 * A's Route 2 placement rules, applied in the shadow bot's namespace: a live
 * C order at the same level is refreshed in place; otherwise C orders at a
 * moved level are superseded and the new one inserted through
 * route2_place_order (which scopes the supersede to the order's own bot id).
 * Each intent is isolated: a failure is counted and logged, never thrown.
 * A's rows are never read or written; `cap` / `detail` are only read.
 */
export async function writeShadowIntents(
  supabase: any, userId: string, intents: ShadowIntent[],
  place: (s: any, i: PlaceRoute2Input) => Promise<PlaceRoute2Result> = placeRoute2Order,
): Promise<ShadowWriteTally> {
  const tally: ShadowWriteTally = { placed: 0, refreshed: 0, duplicate: 0, failed: 0 };
  for (const it of intents) {
    try {
      const { data: stale, error: staleErr } = await supabase.from("pending_orders")
        .select("order_id, entry_price, signal_score, signal_id")
        .eq("user_id", userId).eq("bot_id", SHADOW_BOT_ID)
        .eq("symbol", it.symbol).eq("direction", it.direction)
        .eq("status", "pending");
      if (staleErr) throw new Error(`stale lookup: ${staleErr.message}`);
      const { same, moved } = splitByLevel<any>(stale ?? [], it.limit, it.pipSize);
      if (same.length > 0) {
        const { error: refErr } = await supabase.from("pending_orders").update({
          signal_score: it.score, current_price: it.lastPrice,
          stop_loss: it.stop, take_profit: it.target, size: it.size,
        }).in("order_id", same.map((o: any) => o.order_id)).eq("user_id", userId).eq("bot_id", SHADOW_BOT_ID);
        if (refErr) throw new Error(`refresh: ${refErr.message}`);
        tally.refreshed++;
        continue;
      }
      const supersede = moved.map((o: any) => ({
        order_id: o.order_id as string,
        cancel_reason: `Superseded by new setup (score ${Number(it.score).toFixed(1)} vs old ${moved[0].signal_score?.toFixed?.(1) ?? "?"}, entry ${it.limit} vs old ${moved[0].entry_price})`,
      }));
      // Pairing, read off A's records for this setup after A acted on it.
      it.shadowCtx.pairedSignalId = typeof it.cap?.signal_id === "string" ? it.cap.signal_id : null;
      it.shadowCtx.aFinalStatus = typeof it.detail?.status === "string" ? it.detail.status : null;
      const placement = await place(supabase, { attribution: it.attribution, order: it.order, supersede });
      if (placement.outcome === "placed") tally.placed++;
      else if (placement.outcome === "duplicate") tally.duplicate++;
      else {
        tally.failed++;
        console.warn(`[shadow-zonemid] ${it.symbol} ${it.direction}: placement ${placement.outcome} (${placement.code}): ${placement.error}`);
      }
    } catch (e: any) {
      tally.failed++;
      console.warn(`[shadow-zonemid] ${it.symbol} ${it.direction}: write failed (A unaffected): ${e?.message}`);
    }
  }
  return tally;
}

// ── Hunt: cache-only data ───────────────────────────────────────────────────

/**
 * Every series A's hunt body would read for an order in this state, so a C
 * minute is either fully observed or not observed at all (never a thesis
 * check silently failing open on a missing series).
 */
export function shadowRequiredSeries(i: {
  pendingInterval: string; status: string; thesisValidationEnabled: boolean; thesisStyleAware: boolean;
  isManagementOnly: boolean; style: string; confirmTF: string;
}): string[] {
  const out = [i.pendingInterval];
  if (i.thesisValidationEnabled) {
    out.push("1d", "4h", "1h");
    if (i.thesisStyleAware || !i.isManagementOnly) {
      if (i.style === "scalper") out.push("15m");
      else if (i.style === "swing_trader") out.push("1w");
    }
  }
  if (i.status === "awaiting_confirmation") out.push(i.confirmTF);
  return [...new Set(out)];
}

/** All required series from the cache, or the list that is missing (absent or empty). */
export function peekAll(
  peek: (symbol: string, interval: string) => Candle[] | undefined, symbol: string, intervals: string[],
): { ok: true; series: Map<string, Candle[]> } | { ok: false; missing: string[] } {
  const series = new Map<string, Candle[]>();
  const missing: string[] = [];
  for (const iv of intervals) {
    const c = peek(symbol, iv);
    if (c && c.length > 0) series.set(iv, c);
    else missing.push(iv);
  }
  return missing.length ? { ok: false, missing } : { ok: true, series };
}

/**
 * C's hypothetical book for fill-time caps: C attribution rows filled and not
 * yet closed. Same shape the hunt's cap checks read from A's positions.
 * Known bias: hypothetical closes are written by the outcome resolver (every
 * 15 min on stored 5m bars), so a C trade can count as open up to one resolver
 * cycle after it would have closed — C is capped slightly MORE often, never less.
 */
export function shadowBookFromAttribution(
  rows: { symbol?: unknown; direction?: unknown }[] | null | undefined,
): { symbol: string; direction: string }[] {
  return (rows ?? [])
    .filter((r) => typeof r?.symbol === "string" && typeof r?.direction === "string")
    .map((r) => ({ symbol: r.symbol as string, direction: r.direction as string }));
}

// ── Evaluation validity ─────────────────────────────────────────────────────

export interface ShadowCoverage {
  overall: number | null;
  polls: number;
  perPair: Record<string, { polls: number; covered: number; coverage: number; meetsMin: boolean }>;
  /** Pairs below the per-pair minimum: reported separately, excluded from promotion. */
  excludedPairs: string[];
  /** C-vs-A results are valid only when this is true. */
  valid: boolean;
}

/**
 * Coverage of the shadow hunt: the share of C order-minutes that were fully
 * observed. A `shadow_no_data` poll is a minute C could not evaluate.
 * Valid only at ≥ 90% overall AND ≥ 80% for every pair.
 */
export function shadowCoverage(polls: { symbol: string; branch: string }[]): ShadowCoverage {
  const perPair: ShadowCoverage["perPair"] = {};
  let covered = 0;
  for (const p of polls) {
    const e = perPair[p.symbol] ??= { polls: 0, covered: 0, coverage: 0, meetsMin: false };
    e.polls++;
    if (p.branch !== "shadow_no_data") { e.covered++; covered++; }
  }
  for (const e of Object.values(perPair)) {
    e.coverage = e.covered / e.polls;
    e.meetsMin = e.coverage >= SHADOW_MIN_COVERAGE_PER_PAIR;
  }
  const overall = polls.length ? covered / polls.length : null;
  const excludedPairs = Object.entries(perPair).filter(([, e]) => !e.meetsMin).map(([s]) => s).sort();
  return {
    overall, polls: polls.length, perPair, excludedPairs,
    valid: overall !== null && overall >= SHADOW_MIN_COVERAGE_OVERALL && excludedPairs.length === 0,
  };
}

/**
 * ROUTE 2 FORWARD VALIDATION — distance guard, TTL, and causal telemetry.
 *
 * WHY THIS EXISTS. Route 2 could not be causally backtested: poll instants,
 * per-cycle data availability and which of the two pollers handled a
 * transition were never recorded. This module supplies the guard and the
 * record that make a FORWARD validation causal instead.
 *
 * Two structural corrections are implemented here, both pre-registered by
 * research and neither of them a strategy change:
 *
 *   DISTANCE GUARD — reject a pending order whose entry sits more than
 *     1.5 H1-ATR from spot. Measured: 73% of Route 2 entries sat beyond
 *     1.5 ATR and filled 2.4% of the time inside the TTL. The guard REJECTS;
 *     it never moves the entry price and never substitutes a zone.
 *
 *   TTL — 8 hours, fixed from creation. Measured on the bounded population:
 *     8h captures 84.1% of valid 24h touches against 50.6% at 2h, with the
 *     valid share of arrivals flat (88.3% / 87.9% / 87.3%), so the longer
 *     horizon does not buy worse arrivals.
 *
 * PAPER / RESEARCH ONLY. Nothing here reaches broker execution: that is
 * gated separately on `paper_accounts.execution_mode === "live"`, which this
 * module neither reads nor sets.
 *
 * This module is pure — no clock, no database, no config reads.
 */

import { SMC_CONTRACT_VERSION } from "./smcScanSnapshot.ts";

/** Pre-registered by SMC_ROUTE2_PENDING_DISTANCE_V1. Not a tunable. */
export const ROUTE2_MAX_PENDING_DISTANCE_ATR = 1.5;
/** Pre-registered by SMC_ROUTE2_ZONE_STALENESS_AND_TTL_SELECTION_V1. */
export const ROUTE2_TTL_HOURS = 8;
export const ROUTE2_TTL_MINUTES = ROUTE2_TTL_HOURS * 60;

/** Where the pending entry price came from. Production precedence order. */
export type Route2EntrySource = "unified" | "refinedEntry" | "zoneMid" | "legacy";

/**
 * Distance from spot to the proposed pending entry, in H1 ATR.
 *
 * Returns null when ATR is unavailable or non-positive. A null must NOT be
 * read as "passes" — see `passesDistanceGuard`.
 */
export function pendingDistanceAtr(
  currentPrice: number, pendingEntry: number, h1Atr: number | null,
): number | null {
  if (h1Atr === null || !Number.isFinite(h1Atr) || h1Atr <= 0) return null;
  if (!Number.isFinite(currentPrice) || !Number.isFinite(pendingEntry)) return null;
  return Math.abs(currentPrice - pendingEntry) / h1Atr;
}

/**
 * The guard. Exactly 1.5 ATR is ACCEPTED — the cap is inclusive, matching the
 * research population which was built with `distAtrH1 <= 1.5`.
 *
 * An unmeasurable distance (null) FAILS. Admitting an order whose distance
 * could not be computed would reintroduce the unbounded tail this guard
 * exists to remove, and would do it silently.
 */
export function passesDistanceGuard(
  distanceAtr: number | null, maxAtr = ROUTE2_MAX_PENDING_DISTANCE_ATR,
): boolean {
  if (distanceAtr === null || !Number.isFinite(distanceAtr)) return false;
  return distanceAtr <= maxAtr;
}

/**
 * Expiry for a Route 2 pending order: FIXED from creation.
 *
 * Deliberately not extended by refresh-in-place. Production's refresh reset
 * `expires_at` to `now + TTL` on every re-detection, so a persistently
 * re-detected zone never expired — tolerable at 60 minutes, unbounded at 8
 * hours. The research measured arrival from the FIRST detection, so a fixed
 * window is also the only thing that matches what was validated.
 */
export function route2ExpiresAt(placedAtIso: string, ttlMinutes = ROUTE2_TTL_MINUTES): string {
  const t = Date.parse(placedAtIso);
  if (!Number.isFinite(t)) throw new Error(`route2ExpiresAt: unparseable placedAt "${placedAtIso}"`);
  return new Date(t + ttlMinutes * 60_000).toISOString();
}

/** Maximum practical lifetime of a Route 2 order, in minutes. */
export const ROUTE2_MAX_LIFETIME_MINUTES = ROUTE2_TTL_MINUTES;

// ─── terminal reasons ───────────────────────────────────────────────────────

/** Typed terminal states. Free-text `cancel_reason` is kept for humans only. */
export const TERMINAL_REASONS = [
  "EXPIRED_NEVER_TOUCHED",
  "EXPIRED_AFTER_TOUCH_NO_CONFIRMATION",
  "CANCELLED_SL_INVALIDATION",
  "CANCELLED_IMPULSE_BROKEN",
  "CANCELLED_ZONE_EXIT",
  "CANCELLED_DIRECTION_FLIP",
  // Beyond the registered list: production also cancels on a FOTSI currency
  // exhaustion veto (thesisValidator.ts:252), a HARD cancel that is neither a
  // direction flip nor a zone failure. Labelling it as either would be wrong.
  "CANCELLED_THESIS_FOTSI",
  "CANCELLED_REFINED_ZONE_FAILURE",
  "CANCELLED_POSITION_CAP",
  "CANCELLED_SUPERSEDED",
  "FILLED",
] as const;
export type TerminalReason = (typeof TERMINAL_REASONS)[number];

/**
 * Expiry splits on whether the zone was ever reached, which is the single
 * most useful distinction in the funnel: 21 of 22 measurable live orders died
 * without price ever arriving.
 */
export function expiryReason(everTouched: boolean): TerminalReason {
  return everTouched ? "EXPIRED_AFTER_TOUCH_NO_CONFIRMATION" : "EXPIRED_NEVER_TOUCHED";
}

// ─── config versioning ──────────────────────────────────────────────────────

/** Key-sorted JSON, so two equal configs always hash the same. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

/**
 * Stable 64-bit FNV-1a over the canonical form, as 16 hex chars.
 *
 * Synchronous on purpose: this is called on the trade path and `crypto.subtle`
 * is async. It is a change detector, not a security primitive.
 */
export function configHash(config: unknown): string {
  const s = canonicalJson(config);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0"));
}

// ─── order-level telemetry ──────────────────────────────────────────────────

export interface Route2OrderTelemetryInput {
  zoneId: string | null;
  zoneTimeframe: string | null;
  zoneCreatedAt: string | null;
  pendingCreatedAt: string;
  entrySource: Route2EntrySource;
  pendingEntryPrice: number;
  currentPriceAtCreation: number;
  h1Atr: number | null;
  distanceAtr: number | null;
  initialStopLoss: number | null;
  initialTakeProfit: number | null;
  configHash: string;
  zoneStory: Record<string, unknown> | null;
  /** True when price was strictly at the zone, i.e. Route 1 would have taken
   *  this setup as a market fill had it not been disabled. */
  wouldHaveBeenRoute1: boolean;
}

/**
 * The immutable creation record for a Route 2 pending order.
 *
 * `zone_age_minutes` is derived here rather than at read time so the value
 * cannot drift if `zone_created_at` is ever repaired.
 */
export function buildRoute2OrderTelemetry(i: Route2OrderTelemetryInput): Record<string, unknown> {
  const created = Date.parse(i.pendingCreatedAt);
  const formed = i.zoneCreatedAt ? Date.parse(i.zoneCreatedAt) : NaN;
  return {
    zone_id: i.zoneId,
    zone_created_at: i.zoneCreatedAt,
    zone_age_minutes: Number.isFinite(formed) && Number.isFinite(created)
      ? Math.round((created - formed) / 60_000) : null,
    entry_source: i.entrySource,
    current_price_at_creation: i.currentPriceAtCreation,
    h1_atr_at_creation: i.h1Atr,
    pending_distance_atr: i.distanceAtr,
    initial_stop_loss: i.initialStopLoss,
    initial_take_profit: i.initialTakeProfit,
    config_hash: i.configHash,
    strategy_version: SMC_CONTRACT_VERSION,
    expiry_policy: "fixed_from_creation",
    would_have_been_route1: i.wouldHaveBeenRoute1,
    zone_story_at_creation: i.zoneStory,
  };
}

/**
 * Stable identity for the zone a pending order was drawn from.
 *
 * Bounds are rounded to 7 significant digits so float noise across scans does
 * not mint a new id for the same zone. Deliberately NOT time-based: the same
 * zone re-detected on a later cycle must produce the same id.
 */
export function zoneId(
  symbol: string, timeframe: string | null, direction: string,
  zoneHigh: number, zoneLow: number,
): string {
  const r = (n: number) => Number(n.toPrecision(7)).toString();
  return `${symbol}|${timeframe ?? "?"}|${direction}|${r(zoneLow)}|${r(zoneHigh)}`;
}

/**
 * When the POI formed, located by matching its bounds against the series it
 * was detected on. Returns the bar's `datetime`, or null if unlocatable.
 *
 * Bounds conventions are production's own and must stay in step with them:
 *   OB  — smcAnalysis.ts obZoneWithWicks: high = (max(o,c)+high)/2,
 *         low = (min(o,c)+low)/2
 *   FVG — smcAnalysis.ts detectFVGs, recorded on the MIDDLE candle c2:
 *         bullish high = c3.low, low = c1.high
 *         bearish high = c1.low, low = c3.high
 *
 * Verified against 3,433 historical POIs: 100% located (1,718 OB, 1,715 FVG).
 * Null is returned rather than an estimate — an approximate zone age would
 * silently corrupt the staleness analysis this field exists to feed.
 */
export function locatePoiFormation(
  bars: Array<{ datetime: string; open: number; high: number; low: number; close: number }>,
  poiType: string | null, poiHigh: number, poiLow: number,
): string | null {
  if (!bars.length || !Number.isFinite(poiHigh) || !Number.isFinite(poiLow)) return null;
  const scale = Math.abs(poiHigh) || 1;
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, scale * 1e-7);
  if (poiType === "ob") {
    for (let i = bars.length - 1; i >= 0; i--) {
      const c = bars[i];
      const bh = Math.max(c.open, c.close), bl = Math.min(c.open, c.close);
      if (near(bh + (c.high - bh) * 0.5, poiHigh) && near(bl - (bl - c.low) * 0.5, poiLow)) {
        return c.datetime;
      }
    }
  } else if (poiType === "fvg") {
    for (let i = bars.length - 1; i >= 2; i--) {
      const c1 = bars[i - 2], c3 = bars[i];
      if ((near(c3.low, poiHigh) && near(c1.high, poiLow)) ||
          (near(c1.low, poiHigh) && near(c3.high, poiLow))) {
        return bars[i - 1].datetime;
      }
    }
  }
  return null;
}

// ─── poll log ───────────────────────────────────────────────────────────────

export interface PollRecordInput {
  pendingId: string;
  pollTimestamp: string;
  pollerName: "bot-scanner" | "zone-confirmation-scanner";
  candlesAvailable: number;
  currentPrice: number | null;
  statusBefore: string;
  zoneTouchDetected?: boolean;
  zoneTouchBarTime?: string | null;
  confirmationChecked?: boolean;
  confirmationResult?: string | null;
  confirmationTier?: number | null;
  directionState?: string | null;
  impulseBroken?: boolean | null;
  zoneExit?: string | null;
  structuralInvalidation?: string | null;
  branchTaken: string;
  statusAfter: string;
}

/**
 * One row per lifecycle evaluation, per order, per poller.
 *
 * `candles_available` is recorded even when zero — a skipped poll caused by a
 * refused fetch is exactly the event whose absence made the historical
 * lifecycle unreplayable, and it must not look like "nothing happened".
 */
export function buildPollRecord(i: PollRecordInput): Record<string, unknown> {
  return {
    pending_id: i.pendingId,
    poll_timestamp: i.pollTimestamp,
    poller_name: i.pollerName,
    candles_available: i.candlesAvailable,
    current_price: i.currentPrice,
    status_before: i.statusBefore,
    zone_touch_detected: i.zoneTouchDetected ?? false,
    zone_touch_bar_time: i.zoneTouchBarTime ?? null,
    confirmation_checked: i.confirmationChecked ?? false,
    confirmation_result: i.confirmationResult ?? null,
    confirmation_tier: i.confirmationTier ?? null,
    direction_state: i.directionState ?? null,
    impulse_broken: i.impulseBroken ?? null,
    zone_exit: i.zoneExit ?? null,
    structural_invalidation: i.structuralInvalidation ?? null,
    branch_taken: i.branchTaken,
    status_after: i.statusAfter,
  };
}

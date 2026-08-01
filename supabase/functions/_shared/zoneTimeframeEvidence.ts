/**
 * zoneTimeframeEvidence.ts — Phase 1 per-timeframe evidence contract.
 *
 * OBSERVATION ONLY. Nothing in this module participates in scoring, ranking,
 * gating, configuration or execution. It records what the zone engine saw on
 * every timeframe slot so rejections can be explained after the fact.
 */

import type { Candle } from "./smcAnalysis.ts";
import {
  collectImpulseLegCandidates,
  mapImpulsePOIs,
  measureImpulsePOIQualification,
  type ImpulseLeg,
  type MultiTFZoneResult,
  type RankedPOI,
  type TFSlotLabels,
  type ZoneEngineOptions,
  type ZoneEngineResult,
} from "./impulseZoneEngine.ts";
import { canonicalCandidateId } from "./zoneCandidateIdentity.ts";

export const ZONE_TF_EVIDENCE_CONTRACT_VERSION = "zone-tf-evidence.v1";

export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export type EvidenceSource = "live_scan" | "confirmation" | "replay" | "backtest";

/**
 * Golden Replay preserves an input fingerprint, not complete historical candle
 * arrays. Provenance is always explicit so refetched data is never presented as
 * an exact reconstruction of what the bot saw.
 */
export type ReplayProvenance =
  | "exact_input"
  | "historically_refetched"
  | "approximate_config"
  | "unreplayable";

/** Persisted engine option allowlist. Nothing else may reach the database. */
export const ENGINE_OPTION_ALLOWLIST = [
  "minQualityScore",
  "maxAgeBars",
  "minBodyRatio",
  "minDisplacementATR",
  "fibMaxRetracement",
  "originOBRetest",
  "strictATRMult",
  "pipSize",
] as const;

export interface EvidenceLimits {
  maxLegsPerSlot: number;
  maxPOIsPerSlot: number;
  maxCandidatesPerSlot: number;
  maxRowBytes: number;
}

export const DEFAULT_EVIDENCE_LIMITS: EvidenceLimits = {
  maxLegsPerSlot: 8,
  maxPOIsPerSlot: 40,
  maxCandidatesPerSlot: 10,
  maxRowBytes: 96_000,
};

/** Chunking limits for persistence: whichever bound is hit first closes a chunk. */
export const DEFAULT_CHUNK_LIMITS = { maxRows: 10, maxBytes: 512_000 };

export interface SlotEvidence {
  slot: "top" | "mid" | "low";
  timeframe: string;
  available: boolean;
  skippedReason: string | null;
  candleCount: number;
  reason: string;
  impulses: Array<{
    selected: boolean;
    direction: string;
    high: number;
    low: number;
    bosPrice: number;
    startIndex: number;
    endIndex: number;
    startDate: string | null;
    endDate: string | null;
    spanBars: number;
    isValid: boolean;
    rejection: { code: string; explanation: string } | null;
  }>;
  pois: Array<{
    candidateId: string;
    type: string;
    high: number;
    low: number;
    direction: string;
    candleIndex: number;
    isOriginOB: boolean;
    ageBars: number;
    bodyRatio: number | null;
    displacementATRMultiple: number | null;
    accepted: boolean;
    rejection:
      | { code: string; measured: number; threshold: number; comparator: string; explanation: string }
      | null;
  }>;
  candidates: Array<{
    candidateId: string;
    rank: number;
    type: string;
    high: number;
    low: number;
    fibLevel: number;
    fibDepth: number;
    fibScore: number;
    srConfirmed: boolean;
    ltfRefined: boolean;
    htfConfluenceScore: number;
    htfLayers: string[];
    totalScore: number;
  }>;
  truncated: { legs: number; pois: number; candidates: number } | null;
}

export interface ScanEvidenceContext {
  userId: string;
  botId: string;
  scanCycleId: string;
  symbol: string;
  direction: "bullish" | "bearish";
  observedAt: string;
  evaluatedAt?: string;
  tradingStyle: string;
  stylePolicyVersion: string | null;
  styleBasePolicyHash: string | null;
  stylePolicyHash: string | null;
  evidenceSource?: EvidenceSource;
  replayRunId?: string | null;
  replayProvenance?: ReplayProvenance | null;
  parentEvidenceId?: string | null;
  pendingOrderId?: string | null;
  confirmationAttempt?: number;
  limits?: Partial<EvidenceLimits>;
}

export interface SlotInput {
  slot: "top" | "mid" | "low";
  timeframe: string;
  candles: Candle[];
  result: ZoneEngineResult | null;
}

function pickEngineOptions(options?: ZoneEngineOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!options) return out;
  for (const key of ENGINE_OPTION_ALLOWLIST) {
    const value = (options as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  if (options.zoneLifecycleV2) {
    out["zoneLifecycleV2.enabled"] = Boolean(options.zoneLifecycleV2.enabled);
  }
  return out;
}

function legRecord(
  leg: ImpulseLeg,
  selected: boolean,
  rejection: { code: string; explanation: string } | null,
) {
  return {
    selected,
    direction: leg.direction,
    high: leg.high,
    low: leg.low,
    bosPrice: leg.bosPrice,
    startIndex: leg.startIndex,
    endIndex: leg.endIndex,
    startDate: leg.startDate ?? null,
    endDate: leg.endDate ?? null,
    spanBars: leg.spanBars ?? 0,
    isValid: leg.isValid,
    rejection,
  };
}

function candidateRecord(zone: RankedPOI, rank: number, symbol: string, timeframe: string) {
  return {
    candidateId: zone.localConfluence?.candidateId ??
      canonicalCandidateId(zone.poi, { symbol, timeframe }),
    rank,
    type: zone.poi.type,
    high: zone.poi.high,
    low: zone.poi.low,
    fibLevel: zone.fibLevel,
    fibDepth: zone.fibDepth,
    fibScore: zone.fibScore,
    srConfirmed: zone.srConfirmed,
    ltfRefined: zone.ltfRefined,
    htfConfluenceScore: zone.htfConfluenceScore,
    htfLayers: zone.htfLayers ?? [],
    totalScore: zone.totalScore,
  };
}

/** Build one slot record. Pure and observation-only. */
export function buildTimeframeEvidence(
  input: SlotInput,
  context: { symbol: string; direction: "bullish" | "bearish" },
  options?: ZoneEngineOptions,
  limits: EvidenceLimits = DEFAULT_EVIDENCE_LIMITS,
): SlotEvidence {
  const { slot, timeframe, candles, result } = input;
  const available = candles.length >= 20 && result !== null;
  const truncated = { legs: 0, pois: 0, candidates: 0 };

  if (!available) {
    return {
      slot,
      timeframe,
      available: false,
      skippedReason: candles.length < 20
        ? `Insufficient candles (${candles.length} < 20)`
        : "Slot not evaluated in this cycle",
      candleCount: candles.length,
      reason: result?.reason ?? "not_evaluated",
      impulses: [],
      pois: [],
      candidates: [],
      truncated: null,
    };
  }

  const legCandidates = collectImpulseLegCandidates(candles, context.direction, timeframe);
  let impulses = legCandidates.map((c) => legRecord(c.leg, c.selected, c.rejection));
  if (impulses.length > limits.maxLegsPerSlot) {
    truncated.legs = impulses.length - limits.maxLegsPerSlot;
    impulses = impulses.slice(0, limits.maxLegsPerSlot);
  }

  const selectedLeg = result!.impulse;
  let pois: SlotEvidence["pois"] = [];
  if (selectedLeg) {
    const mapped = mapImpulsePOIs(candles, selectedLeg, {
      originOBRetest: options?.originOBRetest,
      zoneLifecycleV2: options?.zoneLifecycleV2,
      evidenceContext: options?.evidenceContext
        ? { ...options.evidenceContext, timeframe }
        : { symbol: context.symbol, timeframe },
    });
    const measured = measureImpulsePOIQualification(candles, selectedLeg, mapped, options);
    pois = measured.map((m) => ({
      candidateId: canonicalCandidateId(m.poi, { symbol: context.symbol, timeframe }),
      type: m.poi.type,
      high: m.poi.high,
      low: m.poi.low,
      direction: m.poi.direction,
      candleIndex: m.poi.candleIndex,
      isOriginOB: Boolean(m.poi.isOriginOB),
      ageBars: m.ageBars,
      bodyRatio: m.bodyRatio,
      displacementATRMultiple: m.displacementATRMultiple,
      accepted: m.accepted,
      rejection: m.rejection,
    }));
    // Trim rejected first, keeping accepted POIs.
    if (pois.length > limits.maxPOIsPerSlot) {
      truncated.pois = pois.length - limits.maxPOIsPerSlot;
      const accepted = pois.filter((p) => p.accepted);
      const rejected = pois.filter((p) => !p.accepted);
      pois = [...accepted, ...rejected].slice(0, limits.maxPOIsPerSlot);
    }
  }

  const ranked = [...result!.allZones].sort((a, b) =>
    b.totalScore - a.totalScore || b.fibDepth - a.fibDepth
  );
  let candidates = ranked.map((zone, i) =>
    candidateRecord(zone, i + 1, context.symbol, timeframe)
  );
  if (candidates.length > limits.maxCandidatesPerSlot) {
    truncated.candidates = candidates.length - limits.maxCandidatesPerSlot;
    candidates = candidates.slice(0, limits.maxCandidatesPerSlot);
  }

  const anyTruncation = truncated.legs + truncated.pois + truncated.candidates > 0;
  return {
    slot,
    timeframe,
    available: true,
    skippedReason: null,
    candleCount: candles.length,
    reason: result!.reason,
    impulses,
    pois,
    candidates,
    truncated: anyTruncation ? truncated : null,
  };
}

export interface EvidenceRow extends Record<string, unknown> {
  user_id: string;
  bot_id: string;
  scan_cycle_id: string;
  symbol: string;
  direction: string;
  evidence_source: EvidenceSource;
  pending_order_id: string;
  confirmation_attempt: number;
}

/** Build the full row (header + slots) for one symbol/direction in one cycle. */
export function buildScanEvidenceRow(
  multiTFResult: MultiTFZoneResult,
  slots: {
    top: { timeframe: string; candles: Candle[] };
    mid: { timeframe: string; candles: Candle[] };
    low: { timeframe: string; candles: Candle[] };
  },
  context: ScanEvidenceContext,
  options?: ZoneEngineOptions,
): EvidenceRow {
  const limits = { ...DEFAULT_EVIDENCE_LIMITS, ...(context.limits ?? {}) };
  const slotEvidence: SlotEvidence[] = [
    buildTimeframeEvidence(
      { slot: "top", timeframe: slots.top.timeframe, candles: slots.top.candles, result: multiTFResult.dailyResult ?? null },
      context,
      options,
      limits,
    ),
    buildTimeframeEvidence(
      { slot: "mid", timeframe: slots.mid.timeframe, candles: slots.mid.candles, result: multiTFResult.h4Result ?? null },
      context,
      options,
      limits,
    ),
    buildTimeframeEvidence(
      { slot: "low", timeframe: slots.low.timeframe, candles: slots.low.candles, result: multiTFResult.h1Result ?? null },
      context,
      options,
      limits,
    ),
  ];

  let payloadTruncated = slotEvidence.some((s) => s.truncated !== null);
  const truncationDetail: Record<string, unknown> = {};
  for (const s of slotEvidence) {
    if (s.truncated) truncationDetail[s.slot] = s.truncated;
  }

  let row: EvidenceRow = {
    user_id: context.userId,
    bot_id: context.botId,
    scan_cycle_id: context.scanCycleId,
    symbol: context.symbol,
    direction: context.direction,
    observed_at: context.observedAt,
    evaluated_at: context.evaluatedAt ?? context.observedAt,
    trading_style: context.tradingStyle,
    style_policy_version: context.stylePolicyVersion,
    style_base_policy_hash: context.styleBasePolicyHash,
    style_policy_hash: context.stylePolicyHash,
    contract_version: ZONE_TF_EVIDENCE_CONTRACT_VERSION,
    selected_timeframe: multiTFResult.selectedTF,
    final_reason: multiTFResult.reason,
    evidence_source: context.evidenceSource ?? "live_scan",
    replay_run_id: context.replayRunId ?? null,
    replay_provenance: context.replayProvenance ?? null,
    parent_evidence_id: context.parentEvidenceId ?? null,
    pending_order_id: context.pendingOrderId ?? NIL_UUID,
    confirmation_attempt: context.confirmationAttempt ?? 0,
    slots: slotEvidence,
    engine_options: pickEngineOptions(options),
    payload_truncated: payloadTruncated,
    truncation_detail: payloadTruncated ? truncationDetail : null,
  };

  // Byte ceiling: drop rejected POIs, then lowest-ranked candidates, then legs.
  if (rowBytes(row) > limits.maxRowBytes) {
    for (const s of slotEvidence) {
      const before = s.pois.length;
      s.pois = s.pois.filter((p) => p.accepted);
      const dropped = before - s.pois.length;
      if (dropped > 0) {
        s.truncated = { ...(s.truncated ?? { legs: 0, pois: 0, candidates: 0 }) };
        s.truncated.pois += dropped;
      }
    }
    payloadTruncated = true;
  }
  if (rowBytes(row) > limits.maxRowBytes) {
    for (const s of slotEvidence) {
      const beforeC = s.candidates.length;
      s.candidates = s.candidates.slice(0, 3);
      const beforeL = s.impulses.length;
      s.impulses = s.impulses.filter((l) => l.selected).concat(
        s.impulses.filter((l) => !l.selected).slice(0, 2),
      );
      s.truncated = { ...(s.truncated ?? { legs: 0, pois: 0, candidates: 0 }) };
      s.truncated.candidates += Math.max(0, beforeC - s.candidates.length);
      s.truncated.legs += Math.max(0, beforeL - s.impulses.length);
    }
    payloadTruncated = true;
  }
  if (payloadTruncated) {
    const detail: Record<string, unknown> = {};
    for (const s of slotEvidence) if (s.truncated) detail[s.slot] = s.truncated;
    row = { ...row, payload_truncated: true, truncation_detail: detail };
  }
  return row;
}

export function rowBytes(row: unknown): number {
  return new TextEncoder().encode(JSON.stringify(row)).length;
}

/**
 * Split rows into bounded chunks: a chunk closes at whichever limit is hit
 * first — max row count or max serialized byte size. Never one unrestricted
 * request containing every enabled pair.
 */
export function chunkEvidenceRows<T>(
  rows: T[],
  limits: { maxRows: number; maxBytes: number } = DEFAULT_CHUNK_LIMITS,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const row of rows) {
    const size = rowBytes(row);
    const wouldExceed = current.length >= limits.maxRows ||
      (current.length > 0 && currentBytes + size > limits.maxBytes);
    if (wouldExceed) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(row);
    currentBytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export const EVIDENCE_CONFLICT_TARGET =
  "user_id,bot_id,scan_cycle_id,symbol,direction,contract_version,evidence_source,pending_order_id,confirmation_attempt";

/**
 * Persist evidence rows in bounded, awaited chunks. Failures are reported to
 * the caller as a count and never thrown into the scan path.
 */
export async function persistZoneTimeframeEvidence(
  supabase: any,
  rows: EvidenceRow[],
  opts?: {
    limits?: { maxRows: number; maxBytes: number };
    onError?: (err: unknown, chunkSize: number) => void;
  },
): Promise<{ written: number; failedChunks: number }> {
  if (!rows.length) return { written: 0, failedChunks: 0 };
  const chunks = chunkEvidenceRows(rows, opts?.limits ?? DEFAULT_CHUNK_LIMITS);
  let written = 0;
  let failedChunks = 0;
  for (const chunk of chunks) {
    try {
      const { error } = await supabase
        .from("zone_timeframe_evidence")
        .upsert(chunk, {
          onConflict: EVIDENCE_CONFLICT_TARGET,
          ignoreDuplicates: true,
        });
      if (error) throw new Error(error.message);
      written += chunk.length;
    } catch (err) {
      failedChunks++;
      opts?.onError?.(err, chunk.length);
    }
  }
  return { written, failedChunks };
}

/**
 * Next confirmation attempt number for a pending order within a scan cycle.
 * Every confirmation attempt persists as its own immutable row; a later
 * attempt is never collapsed into an earlier one.
 */
export async function nextConfirmationAttempt(
  supabase: any,
  key: {
    userId: string;
    botId: string;
    scanCycleId: string;
    symbol: string;
    direction: string;
    pendingOrderId: string;
  },
): Promise<number> {
  const { data, error } = await supabase
    .from("zone_timeframe_evidence")
    .select("confirmation_attempt")
    .eq("user_id", key.userId)
    .eq("bot_id", key.botId)
    .eq("scan_cycle_id", key.scanCycleId)
    .eq("symbol", key.symbol)
    .eq("direction", key.direction)
    .eq("pending_order_id", key.pendingOrderId)
    .eq("evidence_source", "confirmation")
    .order("confirmation_attempt", { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) return 1;
  return Number(data[0].confirmation_attempt ?? 0) + 1;
}

/** Compact, indefinitely-retained summary written before raw payload pruning. */
export interface ConfirmationObservation {
  timeframe: string;
  candleCount: number;
  confirmationMethod: string;
  confirmationPassed: boolean;
  reason: string;
  chochTier: number | null;
  chochType: string | null;
  indicatorsPassed: number | null;
  indicatorsRequired: number | null;
  hasRefinedZone: boolean;
  zoneHigh: number | null;
  zoneLow: number | null;
  currentPrice: number | null;
}

/**
 * Confirmation-attempt evidence row. Immutable child of the frozen parent scan
 * evidence: every attempt is its own row keyed by pending_order_id and
 * confirmation_attempt, so a later attempt never overwrites an earlier one.
 * Observation only.
 */
export function buildConfirmationEvidenceRow(
  context: ScanEvidenceContext & {
    pendingOrderId: string;
    confirmationAttempt: number;
  },
  observation: ConfirmationObservation,
): EvidenceRow {
  return {
    user_id: context.userId,
    bot_id: context.botId,
    scan_cycle_id: context.scanCycleId,
    symbol: context.symbol,
    direction: context.direction,
    observed_at: context.observedAt,
    evaluated_at: context.evaluatedAt ?? context.observedAt,
    trading_style: context.tradingStyle,
    style_policy_version: context.stylePolicyVersion,
    style_base_policy_hash: context.styleBasePolicyHash,
    style_policy_hash: context.stylePolicyHash,
    contract_version: ZONE_TF_EVIDENCE_CONTRACT_VERSION,
    selected_timeframe: observation.timeframe,
    final_reason: observation.reason,
    evidence_source: "confirmation",
    replay_run_id: context.replayRunId ?? null,
    replay_provenance: context.replayProvenance ?? null,
    parent_evidence_id: context.parentEvidenceId ?? null,
    pending_order_id: context.pendingOrderId,
    confirmation_attempt: context.confirmationAttempt,
    slots: [{
      slot: "low",
      timeframe: observation.timeframe,
      available: observation.candleCount > 0,
      skippedReason: null,
      candleCount: observation.candleCount,
      reason: observation.reason,
      confirmation: observation,
      impulses: [],
      pois: [],
      candidates: [],
      truncated: null,
    }],
    engine_options: {},
    payload_truncated: false,
    truncation_detail: null,
  };
}

/** Most recent live-scan evidence row for a symbol/direction (frozen parent). */
export async function findParentEvidenceId(
  supabase: any,
  key: {
    userId: string;
    botId: string;
    symbol: string;
    direction: string;
    before?: string;
  },
): Promise<string | null> {
  let query = supabase
    .from("zone_timeframe_evidence")
    .select("id")
    .eq("user_id", key.userId)
    .eq("bot_id", key.botId)
    .eq("symbol", key.symbol)
    .eq("direction", key.direction)
    .eq("evidence_source", "live_scan")
    .order("observed_at", { ascending: false })
    .limit(1);
  if (key.before) query = query.lte("observed_at", key.before);
  const { data, error } = await query;
  if (error || !data || data.length === 0) return null;
  return data[0].id as string;
}

export function buildCompactSummary(row: EvidenceRow): Record<string, unknown> {
  const slots = (row.slots as SlotEvidence[]) ?? [];
  const rejectionCounts: Record<string, number> = {};
  for (const slot of slots) {
    for (const poi of slot.pois) {
      if (poi.rejection) {
        rejectionCounts[poi.rejection.code] = (rejectionCounts[poi.rejection.code] ?? 0) + 1;
      }
    }
  }
  const winner = slots
    .flatMap((s) => s.candidates)
    .sort((a, b) => b.totalScore - a.totalScore)[0];
  return {
    selected_timeframe: row.selected_timeframe ?? null,
    winner_candidate_id: winner?.candidateId ?? null,
    rejection_code_counts: rejectionCounts,
    final_reason: row.final_reason ?? null,
    evidence_hash: evidenceHash(row),
  };
}

export function evidenceHash(row: unknown): string {
  const text = JSON.stringify(row);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, "0");
}

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
  type ImpulsePOI,
  type MultiTFZoneResult,
  type RankedPOI,
  type TFSlotLabels,
  type ZoneEngineOptions,
  type ZoneEngineResult,
} from "./impulseZoneEngine.ts";
import { canonicalCandidateId } from "./zoneCandidateIdentity.ts";
import { buildEntityId } from "./conceptEvidence.ts";
import { CANONICAL_IMPULSE_DETECTOR_VERSION } from "./canonicalImpulseDetector.ts";

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
  "zoneLifecycleV2.enabled",
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
  maxCandidatesPerSlot: 3,
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
  canonicalImpulse: {
    detectorVersion: string;
    matchesLegacy: boolean;
    selectionKey: string | null;
    metrics: {
      rangeAbsolute: number;
      atrNormalizedSize: number | null;
      displacementPercentile: number | null;
      strongestDirectionalBodyRatio: number | null;
      bodyStrengthPercentile: number | null;
      bosSignificanceATR: number | null;
      recencyBars: number;
      sweepOrigin: boolean;
      sweptLevel: number | null;
      structureIntact: boolean;
    } | null;
  } | null;
  rejections: Array<{
    stage: "impulse" | "mapping" | "qualification" | "fib" | "bounds" | "quality" | "ranking";
    code: string;
    measured: number | null;
    threshold: number | null;
    comparator: string | null;
    explanation: string;
  }>;
  impulses: Array<{
    impulseId: string;
    selected: boolean;
    direction: string;
    high: number;
    low: number;
    bosPrice: number;
    breakType: "bos" | "choch" | null;
    breakPrinted: boolean;
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
    impulseId: string;
    type: string;
    high: number;
    low: number;
    direction: string;
    candleIndex: number;
    formationTime: string | null;
    lifecycle: string | null;
    isOriginOB: boolean;
    ageBars: number;
    bodyRatio: number | null;
    displacementRange: number | null;
    displacementATRMultiple: number | null;
    fibLevel: number | null;
    fibDepth: number | null;
    distancePips: number | null;
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
  evidenceId?: string;
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
  stylePolicySnapshot?: Record<string, unknown> | null;
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
  identity: { symbol: string; timeframe: string },
) {
  const sourceCandleStart = leg.startDate ?? `idx:${leg.startIndex}`;
  const sourceCandleEnd = leg.endDate ?? `idx:${leg.endIndex}`;
  return {
    impulseId: buildEntityId({
      concept: "impulse",
      detector: { name: "impulseZone.findImpulseLeg", version: "1" },
      symbol: identity.symbol,
      timeframe: identity.timeframe,
      sourceCandleStart,
      sourceCandleEnd,
      direction: leg.direction,
      bounds: { low: leg.low, high: leg.high },
      level: leg.bosPrice,
      discriminator: `${leg.startIndex}:${leg.endIndex}`,
    }),
    selected,
    direction: leg.direction,
    high: leg.high,
    low: leg.low,
    bosPrice: leg.bosPrice,
    breakType: leg.breakType ?? null,
    breakPrinted: Number.isFinite(leg.bosPrice),
    startIndex: leg.startIndex,
    endIndex: leg.endIndex,
    startDate: leg.startDate ?? null,
    endDate: leg.endDate ?? null,
    spanBars: leg.spanBars ?? 0,
    isValid: leg.isValid,
    rejection,
  };
}

function terminalRejections(
  result: ZoneEngineResult,
  options?: ZoneEngineOptions,
): SlotEvidence["rejections"] {
  const reason = result.reason || "";
  const rejection = (
    stage: SlotEvidence["rejections"][number]["stage"],
    code: string,
    explanation: string,
    measured: number | null = null,
    threshold: number | null = null,
    comparator: string | null = null,
  ): SlotEvidence["rejections"] => [{
    stage,
    code,
    measured,
    threshold,
    comparator,
    explanation,
  }];

  if (!result.impulse) {
    return rejection(
      "impulse",
      "no_valid_impulse",
      reason || "No valid structural impulse was selected",
    );
  }
  if (reason.includes("no POIs")) {
    return rejection(
      "mapping",
      "no_poi_inside_selected_impulse",
      reason,
    );
  }
  if (reason.includes("qualification rejected all")) {
    return rejection(
      "qualification",
      "all_pois_failed_qualification",
      reason,
    );
  }
  if (reason.includes("none align with key Fib levels")) {
    return rejection(
      "fib",
      "no_poi_in_fib_admission_range",
      reason,
      null,
      options?.fibMaxRetracement ?? 0.786,
      "<=",
    );
  }
  if (reason.includes("none overlap with Daily zone")) {
    return rejection(
      "bounds",
      "no_zone_overlap_with_parent_bounds",
      reason,
    );
  }
  if (reason.includes("none scored high enough")) {
    return rejection(
      "ranking",
      "fib_score_below_minimum",
      reason,
      null,
      1,
      ">=",
    );
  }
  if (reason.includes("below Bot Config minimum")) {
    const measured = Number(reason.match(/quality ([\d.]+)%/)?.[1] ?? NaN);
    const threshold = Number(
      reason.match(/minimum ([\d.]+)%/)?.[1] ??
        options?.minQualityScore ??
        NaN,
    );
    return rejection(
      "quality",
      "zone_quality_below_minimum",
      reason,
      Number.isFinite(measured) ? measured : null,
      Number.isFinite(threshold) ? threshold : null,
      "<",
    );
  }
  return [];
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
      canonicalImpulse: null,
      rejections: [],
      impulses: [],
      pois: [],
      candidates: [],
      truncated: null,
    };
  }

  const selectedLeg = result!.impulse;
  const selectedImpulseRecord = selectedLeg
    ? legRecord(
      selectedLeg,
      true,
      null,
      { symbol: context.symbol, timeframe },
    )
    : null;
  const legCandidates = result!.evidence?.impulses ??
    collectImpulseLegCandidates(candles, context.direction, timeframe);
  let impulses = legCandidates.map((candidate) => {
    const record = legRecord(candidate.leg, false, candidate.rejection, {
      symbol: context.symbol,
      timeframe,
    });
    record.selected =
      record.impulseId === selectedImpulseRecord?.impulseId;
    return record;
  });
  // The engine result is authoritative. If a future refactor makes the
  // observation enumerator diverge, retain the exact selected leg instead of
  // silently claiming that no leg was selected.
  if (
    selectedImpulseRecord &&
    !impulses.some((impulse) =>
      impulse.impulseId === selectedImpulseRecord.impulseId
    )
  ) {
    impulses.unshift(selectedImpulseRecord);
  }
  if (selectedImpulseRecord) {
    impulses = [
      ...impulses.filter((impulse) => impulse.selected),
      ...impulses.filter((impulse) => !impulse.selected),
    ];
  }
  if (impulses.length > limits.maxLegsPerSlot) {
    truncated.legs = impulses.length - limits.maxLegsPerSlot;
    impulses = impulses.slice(0, limits.maxLegsPerSlot);
  }

  let pois: SlotEvidence["pois"] = [];
  if (selectedLeg) {
    const selectedImpulseId = selectedImpulseRecord!.impulseId;
    const mapped = result!.evidence?.mappedPOIs ??
      mapImpulsePOIs(candles, selectedLeg, {
        originOBRetest: options?.originOBRetest,
        zoneLifecycleV2: options?.zoneLifecycleV2,
        evidenceContext: options?.evidenceContext
          ? { ...options.evidenceContext, timeframe }
          : { symbol: context.symbol, timeframe },
      });
    const measured = result!.evidence?.qualificationMeasurements ??
      measureImpulsePOIQualification(
        candles,
        selectedLeg,
        mapped,
        options,
      );
    const candidateIdFor = (poi: ImpulsePOI) =>
      canonicalCandidateId(poi, { symbol: context.symbol, timeframe });
    const rankedByCandidate = new Map(
      (result!.evidence?.rankedZones ?? result!.allZones).map((zone) => [
        candidateIdFor(zone.poi),
        zone,
      ]),
    );
    const currentPrice = result!.evidence?.currentPrice;
    const pipSize = options?.pipSize ?? 0.0001;
    pois = measured.map((m) => ({
      candidateId: candidateIdFor(m.poi),
      impulseId: selectedImpulseId,
      type: m.poi.type,
      high: m.poi.high,
      low: m.poi.low,
      direction: m.poi.direction,
      candleIndex: m.poi.candleIndex,
      formationTime:
        m.poi.evidence?.sourceCandleStart ??
        candles[m.poi.candleIndex]?.datetime ??
        null,
      lifecycle: m.poi.evidence?.lifecycle ?? null,
      isOriginOB: Boolean(m.poi.isOriginOB),
      ageBars: m.ageBars,
      bodyRatio: m.bodyRatio,
      displacementRange: m.displacementRange,
      displacementATRMultiple: m.displacementATRMultiple,
      fibLevel: rankedByCandidate.get(candidateIdFor(m.poi))?.fibLevel ??
        null,
      fibDepth: rankedByCandidate.get(candidateIdFor(m.poi))?.fibDepth ??
        null,
      distancePips: Number.isFinite(currentPrice)
        ? (
          currentPrice! >= Math.min(m.poi.low, m.poi.high) &&
            currentPrice! <= Math.max(m.poi.low, m.poi.high)
            ? 0
            : Math.min(
              Math.abs(currentPrice! - m.poi.low),
              Math.abs(currentPrice! - m.poi.high),
            ) / pipSize
        )
        : null,
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
    canonicalImpulse: result!.evidence?.canonicalImpulse
      ? {
        detectorVersion:
          result!.evidence.canonicalImpulse.detectorVersion,
        matchesLegacy:
          result!.evidence.canonicalMatchesLegacy === true,
        selectionKey:
          result!.evidence.canonicalImpulse.selectionKey,
        metrics: result!.evidence.canonicalImpulse.metrics,
      }
      : null,
    rejections: terminalRejections(result!, options),
    impulses,
    pois,
    candidates,
    truncated: anyTruncation ? truncated : null,
  };
}

export interface EvidenceRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  bot_id: string;
  scan_cycle_id: string;
  symbol: string;
  direction: string;
  evidence_source: EvidenceSource;
  pending_order_id: string;
  confirmation_attempt: number;
  event_linked?: boolean;
  canonical_detector_version?: string | null;
  canonical_parity?: boolean | null;
}

/**
 * Add retention/link annotations after a pair decision has completed.
 * These fields are never read by strategy code.
 */
export function annotateEvidenceLifecycle(
  row: EvidenceRow,
  detail: Record<string, any> | null | undefined,
): EvidenceRow {
  const status = String(detail?.status || "");
  row.event_linked =
    status.startsWith("staged_") ||
    status.startsWith("zone_setup_") ||
    status.startsWith("trade_placed");
  row.linked_setup_id = detail?.linkedSetupId || null;
  row.linked_trade_id = detail?.positionId || null;
  const shadow = detail?.impulseZone?.bestZone?.shadowRanking || null;
  row.has_disagreement = Boolean(
    shadow && Number(shadow.legacyRank) !== Number(shadow.shadowRank),
  );
  return row;
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
  const canonicalSlots = slotEvidence.filter((slot) => slot.canonicalImpulse);

  let payloadTruncated = slotEvidence.some((s) => s.truncated !== null);
  const truncationDetail: Record<string, unknown> = {};
  for (const s of slotEvidence) {
    if (s.truncated) truncationDetail[s.slot] = s.truncated;
  }

  let row: EvidenceRow = {
    id: context.evidenceId ?? crypto.randomUUID(),
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
    style_policy_snapshot: context.stylePolicySnapshot ?? null,
    contract_version: ZONE_TF_EVIDENCE_CONTRACT_VERSION,
    selected_timeframe: multiTFResult.selectedTF,
    final_reason: multiTFResult.reason,
    evidence_source: context.evidenceSource ?? "live_scan",
    replay_run_id: context.replayRunId ?? null,
    replay_provenance: context.replayProvenance ?? null,
    parent_evidence_id: context.parentEvidenceId ?? null,
    pending_order_id: context.pendingOrderId ?? NIL_UUID,
    confirmation_attempt: context.confirmationAttempt ?? 0,
    canonical_detector_version: canonicalSlots.length > 0
      ? CANONICAL_IMPULSE_DETECTOR_VERSION
      : null,
    canonical_parity: canonicalSlots.length > 0
      ? canonicalSlots.every((slot) => slot.canonicalImpulse?.matchesLegacy === true)
      : null,
    event_linked: false,
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
 * Atomically allocate the next confirmation attempt for a pending order.
 * Every attempt persists as its own immutable row across edge invocations.
 */
export async function nextConfirmationAttempt(
  supabase: any,
  key: {
    userId: string;
    botId: string;
    symbol: string;
    direction: string;
    pendingOrderId: string;
  },
): Promise<number> {
  const { data: allocated, error: allocationError } = await supabase.rpc(
    "allocate_zone_confirmation_evidence_attempt",
    {
      p_user_id: key.userId,
      p_bot_id: key.botId,
      p_pending_order_id: key.pendingOrderId,
    },
  );
  if (allocationError) {
    throw new Error(
      `confirmation evidence attempt allocation failed: ${allocationError.message}`,
    );
  }
  const attempt = Number(allocated);
  if (!Number.isFinite(attempt) || attempt < 1) {
    throw new Error("confirmation evidence attempt allocator returned an invalid value");
  }
  return attempt;
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
    id: context.evidenceId ?? crypto.randomUUID(),
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
    style_policy_snapshot: context.stylePolicySnapshot ?? null,
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
      canonicalImpulse: null,
      rejections: [],
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
    for (const rejection of slot.rejections ?? []) {
      rejectionCounts[rejection.code] =
        (rejectionCounts[rejection.code] ?? 0) + 1;
    }
    for (const poi of slot.pois) {
      if (poi.rejection) {
        rejectionCounts[poi.rejection.code] = (rejectionCounts[poi.rejection.code] ?? 0) + 1;
      }
    }
  }
  const selectedSlot = slots.find((slot) =>
    slot.timeframe === row.selected_timeframe
  );
  const winner = selectedSlot?.candidates.find((candidate) =>
    candidate.rank === 1
  ) ??
    slots
      .flatMap((slot) => slot.candidates)
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

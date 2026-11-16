/* eslint-disable @typescript-eslint/no-explicit-any */
export type EvidenceRecord = Record<string, any>;

function asRecord(value: unknown): EvidenceRecord | null {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value as EvidenceRecord;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as EvidenceRecord
      : null;
  } catch {
    return null;
  }
}

function firstRecord(...values: unknown[]): EvidenceRecord | null {
  for (const value of values) {
    const record = asRecord(value);
    if (record) return record;
  }
  return null;
}

export interface PositionEntryEvidence {
  signal: EvidenceRecord;
  zoneStory: EvidenceRecord | null;
  zoneStorySource: "position" | "pending_order" | "signal_reason" | "frozen_context" | null;
  impulseZone: EvidenceRecord | null;
  originatingZone: EvidenceRecord | null;
  directionVerdict: EvidenceRecord | null;
  thesisValidation: EvidenceRecord | null;
  finalAuthorization: EvidenceRecord | null;
  decisionContext: EvidenceRecord | null;
  entryConfirmation: EvidenceRecord | null;
  canonicalDealingRange: EvidenceRecord | null;
  frozenContext: EvidenceRecord | null;
  stylePolicy: EvidenceRecord | null;
}

/**
 * Reads evidence captured when a position opened. It deliberately does not
 * recalculate anything from current candles: that would describe today's
 * market rather than the decision that created this trade.
 */
export function getPositionEntryEvidence(position: EvidenceRecord): PositionEntryEvidence {
  const signal = asRecord(position.signalReason ?? position.signal_reason) ?? {};
  const frozen = firstRecord(position.frozenStrategyContext, position.frozen_strategy_context, signal.frozenStrategyContext);
  const decision = firstRecord(
    position.decisionContext,
    position.decision_context,
    position.finalAuthorization?.decisionContext,
    position.final_authorization?.decisionContext,
    frozen?.decisionContext,
    signal.decisionContext,
  );

  let zoneStorySource: PositionEntryEvidence["zoneStorySource"] = null;
  let zoneStory = firstRecord(position.zoneStoryAtEntry, position.zone_story_at_entry);
  if (zoneStory) zoneStorySource = "position";
  if (!zoneStory) {
    zoneStory = firstRecord(position.zoneStoryAtFill, position.zone_story_at_fill, position.zoneStoryAtCreation, position.zone_story_at_creation);
    if (zoneStory) zoneStorySource = "pending_order";
  }
  if (!zoneStory) {
    zoneStory = firstRecord(signal.unifiedZone, signal.zoneStory);
    if (zoneStory) zoneStorySource = "signal_reason";
  }
  if (!zoneStory) {
    zoneStory = firstRecord(
      frozen?.zoneStory,
      frozen?.unifiedZone,
      frozen?.scenarioZoneStory?.zoneStory,
      frozen?.crossTimeframeContext?.zoneStory,
    );
    if (zoneStory) zoneStorySource = "frozen_context";
  }

  return {
    signal,
    zoneStory,
    zoneStorySource,
    impulseZone: firstRecord(signal.impulseZone, frozen?.impulseZone, frozen?.crossTimeframeContext?.impulseZone),
    originatingZone: firstRecord(position.originatingZone, position.originating_zone, frozen?.originatingZone, frozen?.scenarioZoneStory?.originatingZone, signal.originatingZone),
    directionVerdict: firstRecord(position.directionVerdict, position.direction_verdict, decision?.directionVerdict, frozen?.directionVerdict, signal.directionVerdict),
    thesisValidation: firstRecord(position.thesisValidation, position.thesis_validation, decision?.thesisValidity, frozen?.thesisValidity, signal.thesisValidation),
    finalAuthorization: firstRecord(position.finalAuthorization, position.final_authorization, signal.finalAuthorization),
    decisionContext: decision,
    entryConfirmation: firstRecord(position.entryConfirmation, position.entry_confirmation, decision?.entryConfirmation, signal.confirmation),
    canonicalDealingRange: firstRecord(position.canonicalDealingRange, position.canonical_dealing_range, frozen?.crossTimeframeContext?.canonicalDealingRange),
    frozenContext: frozen,
    stylePolicy: firstRecord(position.stylePolicy, position.style_policy, decision?.stylePolicy, frozen?.stylePolicy),
  };
}


/**
 * Phase 4 cross-timeframe zone lineage.
 *
 * Observation-only. Relationships explain parent/child context but do not
 * select, block, score, size, or execute a trade.
 */

export const CROSS_TF_ZONE_LINEAGE_VERSION = "cross-tf-zone-lineage.v1";

export type CrossTimeframeZoneRelationship =
  | "qualified_nested"
  | "context_only"
  | "standalone_lower_tf"
  | "timeframe_conflict"
  | "no_parent_context";

export interface CrossTimeframeZoneCandidate {
  candidateId: string;
  timeframe: string;
  direction: "bullish" | "bearish";
  low: number;
  high: number;
  atr: number;
}

export interface CrossTimeframeZoneLineage {
  contractVersion: typeof CROSS_TF_ZONE_LINEAGE_VERSION;
  enforcement: "observe_only";
  candidateId: string;
  candidateTimeframe: string;
  parentCandidateId: string | null;
  parentTimeframe: string | null;
  relationship: CrossTimeframeZoneRelationship;
  directionAligned: boolean | null;
  overlapAmount: number;
  overlapPercentOfChild: number;
  parentDistance: number | null;
  parentDistanceATR: number | null;
  explanation: string;
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function overlap(input: {
  child: CrossTimeframeZoneCandidate;
  parent: CrossTimeframeZoneCandidate;
}): {
  amount: number;
  percentOfChild: number;
  distance: number;
} {
  const childLow = Math.min(input.child.low, input.child.high);
  const childHigh = Math.max(input.child.low, input.child.high);
  const parentLow = Math.min(input.parent.low, input.parent.high);
  const parentHigh = Math.max(input.parent.low, input.parent.high);
  const amount = Math.max(
    0,
    Math.min(childHigh, parentHigh) - Math.max(childLow, parentLow),
  );
  const childWidth = Math.max(0, childHigh - childLow);
  const distance = amount > 0
    ? 0
    : childHigh < parentLow
    ? parentLow - childHigh
    : childLow - parentHigh;
  return {
    amount,
    percentOfChild: childWidth > 0 ? (amount / childWidth) * 100 : 0,
    distance: Math.max(0, distance),
  };
}

export function buildCrossTimeframeZoneLineage(input: {
  candidates: readonly CrossTimeframeZoneCandidate[];
  hierarchy: {
    top: string;
    mid: string;
    low: string;
  };
}): Map<string, CrossTimeframeZoneLineage> {
  const order = [
    normalized(input.hierarchy.top),
    normalized(input.hierarchy.mid),
    normalized(input.hierarchy.low),
  ];
  const output = new Map<string, CrossTimeframeZoneLineage>();

  for (const child of input.candidates) {
    const childIndex = order.indexOf(normalized(child.timeframe));
    if (childIndex <= 0) {
      output.set(child.candidateId, {
        contractVersion: CROSS_TF_ZONE_LINEAGE_VERSION,
        enforcement: "observe_only",
        candidateId: child.candidateId,
        candidateTimeframe: child.timeframe,
        parentCandidateId: null,
        parentTimeframe: null,
        relationship: "no_parent_context",
        directionAligned: null,
        overlapAmount: 0,
        overlapPercentOfChild: 0,
        parentDistance: null,
        parentDistanceATR: null,
        explanation: childIndex === 0
          ? "Candidate is on the highest configured timeframe"
          : "Candidate timeframe is outside the configured hierarchy",
      });
      continue;
    }

    const higherTimeframes = order.slice(0, childIndex).reverse();
    const parents = higherTimeframes.flatMap((timeframe) =>
      input.candidates.filter((candidate) =>
        normalized(candidate.timeframe) === timeframe
      )
    );
    if (parents.length === 0) {
      output.set(child.candidateId, {
        contractVersion: CROSS_TF_ZONE_LINEAGE_VERSION,
        enforcement: "observe_only",
        candidateId: child.candidateId,
        candidateTimeframe: child.timeframe,
        parentCandidateId: null,
        parentTimeframe: null,
        relationship: "standalone_lower_tf",
        directionAligned: null,
        overlapAmount: 0,
        overlapPercentOfChild: 0,
        parentDistance: null,
        parentDistanceATR: null,
        explanation:
          "Lower-timeframe candidate has no candidate on a configured higher timeframe",
      });
      continue;
    }

    const evaluated = parents.map((parent) => ({
      parent,
      measurement: overlap({ child, parent }),
      directionAligned: parent.direction === child.direction,
      hierarchyDistance: Math.abs(
        order.indexOf(normalized(parent.timeframe)) - childIndex,
      ),
    })).sort((a, b) =>
      Number(b.directionAligned) - Number(a.directionAligned) ||
      Number(b.measurement.amount > 0) - Number(a.measurement.amount > 0) ||
      a.hierarchyDistance - b.hierarchyDistance ||
      b.measurement.percentOfChild - a.measurement.percentOfChild ||
      a.parent.candidateId.localeCompare(b.parent.candidateId)
    );
    const best = evaluated[0];
    const relationship: CrossTimeframeZoneRelationship = !best.directionAligned
      ? "timeframe_conflict"
      : best.measurement.amount > 0
      ? "qualified_nested"
      : "context_only";
    const parentDistanceATR = best.parent.atr > 0
      ? best.measurement.distance / best.parent.atr
      : null;
    const explanation = relationship === "qualified_nested"
      ? `${child.timeframe} candidate overlaps ${best.parent.timeframe} parent by ${
        best.measurement.percentOfChild.toFixed(1)
      }% of child width`
      : relationship === "context_only"
      ? `${best.parent.timeframe} direction agrees but its zone does not overlap the ${child.timeframe} candidate`
      : `${child.timeframe} direction conflicts with the nearest ${best.parent.timeframe} parent candidate`;

    output.set(child.candidateId, {
      contractVersion: CROSS_TF_ZONE_LINEAGE_VERSION,
      enforcement: "observe_only",
      candidateId: child.candidateId,
      candidateTimeframe: child.timeframe,
      parentCandidateId: best.parent.candidateId,
      parentTimeframe: best.parent.timeframe,
      relationship,
      directionAligned: best.directionAligned,
      overlapAmount: best.measurement.amount,
      overlapPercentOfChild: Number(
        best.measurement.percentOfChild.toFixed(2),
      ),
      parentDistance: best.measurement.distance,
      parentDistanceATR: parentDistanceATR === null
        ? null
        : Number(parentDistanceATR.toFixed(6)),
      explanation,
    });
  }
  return output;
}

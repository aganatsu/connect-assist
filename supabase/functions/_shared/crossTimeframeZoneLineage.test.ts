import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCrossTimeframeZoneLineage,
  type CrossTimeframeZoneCandidate,
} from "./crossTimeframeZoneLineage.ts";

const hierarchy = { top: "1h", mid: "15min", low: "5min" };

function candidate(
  id: string,
  timeframe: string,
  low: number,
  high: number,
  direction: "bullish" | "bearish" = "bullish",
): CrossTimeframeZoneCandidate {
  return {
    candidateId: id,
    timeframe,
    direction,
    low,
    high,
    atr: 0.002,
  };
}

Deno.test("lineage classifies nested, context-only, and highest-timeframe candidates", () => {
  const result = buildCrossTimeframeZoneLineage({
    hierarchy,
    candidates: [
      candidate("parent", "1h", 1.1, 1.11),
      candidate("nested", "15min", 1.102, 1.105),
      candidate("context", "5min", 1.12, 1.121),
    ],
  });
  assertEquals(result.get("parent")?.relationship, "no_parent_context");
  assertEquals(result.get("nested")?.relationship, "qualified_nested");
  assertEquals(result.get("nested")?.parentCandidateId, "parent");
  assertEquals(result.get("nested")?.overlapPercentOfChild, 100);
  assertEquals(result.get("context")?.relationship, "context_only");
});

Deno.test("lineage identifies standalone lower-timeframe candidates", () => {
  const result = buildCrossTimeframeZoneLineage({
    hierarchy,
    candidates: [candidate("standalone", "5min", 1.1, 1.101)],
  });
  assertEquals(
    result.get("standalone")?.relationship,
    "standalone_lower_tf",
  );
});

Deno.test("lineage records direction conflict instead of presenting false nesting", () => {
  const result = buildCrossTimeframeZoneLineage({
    hierarchy,
    candidates: [
      candidate("bear-parent", "1h", 1.1, 1.11, "bearish"),
      candidate("bull-child", "15min", 1.102, 1.105, "bullish"),
    ],
  });
  assertEquals(
    result.get("bull-child")?.relationship,
    "timeframe_conflict",
  );
  assertEquals(result.get("bull-child")?.directionAligned, false);
});

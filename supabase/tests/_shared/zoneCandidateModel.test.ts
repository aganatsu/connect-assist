import {
  assertEquals,
  assertGreater,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Candle } from "./smcAnalysis.ts";
import {
  classifyZoneCandidateLifecycle,
  rankZoneCandidateModels,
  type ZoneCandidateModelInput,
} from "./zoneCandidateModel.ts";

function candle(
  open: number,
  high: number,
  low: number,
  close: number,
  index: number,
): Candle {
  return {
    datetime: `2026-08-01T${String(index).padStart(2, "0")}:00:00Z`,
    open,
    high,
    low,
    close,
  };
}

Deno.test("candidate lifecycle distinguishes fresh, held, partial, and violated", () => {
  const zone = { low: 1.1, high: 1.101, direction: "bullish" as const };
  assertEquals(
    classifyZoneCandidateLifecycle({
      zone,
      candlesAfterFormation: [
        candle(1.102, 1.103, 1.1015, 1.1025, 1),
      ],
    }).state,
    "fresh",
  );
  assertEquals(
    classifyZoneCandidateLifecycle({
      zone,
      candlesAfterFormation: [
        candle(1.102, 1.1022, 1.1005, 1.1014, 1),
      ],
    }).state,
    "tapped_and_held",
  );
  assertEquals(
    classifyZoneCandidateLifecycle({
      zone,
      candlesAfterFormation: [
        candle(1.102, 1.1022, 1.1005, 1.1007, 1),
      ],
    }).state,
    "partially_mitigated",
  );
  assertEquals(
    classifyZoneCandidateLifecycle({
      zone,
      candlesAfterFormation: [
        candle(1.1005, 1.1008, 1.0995, 1.0998, 1),
      ],
    }).state,
    "violated",
  );
});

function candidate(
  id: string,
  overrides: Partial<ZoneCandidateModelInput>,
): ZoneCandidateModelInput {
  return {
    candidateId: id,
    zone: { low: 1.1, high: 1.101, direction: "bullish" },
    currentPrice: 1.102,
    atr: 0.004,
    localConfluenceScore: 2,
    liquiditySweepQualified: false,
    impulseSweepOrigin: false,
    lifecycle: classifyZoneCandidateLifecycle({
      zone: { low: 1.1, high: 1.101, direction: "bullish" },
      candlesAfterFormation: [],
    }),
    displacementPercentile: 50,
    htfLayerCount: 1,
    fibScore: 1,
    fibDepth: 0.618,
    ...overrides,
  };
}

Deno.test("candidate model ranks proximity, local evidence, sweep, retest and displacement", () => {
  const held = classifyZoneCandidateLifecycle({
    zone: { low: 1.1, high: 1.101, direction: "bullish" },
    candlesAfterFormation: [
      candle(1.102, 1.1022, 1.1005, 1.1014, 1),
    ],
  });
  const ranked = rankZoneCandidateModels([
    candidate("far", { currentPrice: 1.12 }),
    candidate("local-held", {
      currentPrice: 1.1005,
      localConfluenceScore: 4,
      liquiditySweepQualified: true,
      impulseSweepOrigin: true,
      lifecycle: held,
      displacementPercentile: 90,
      htfLayerCount: 3,
    }),
    candidate("middle", { currentPrice: 1.104 }),
    candidate("fourth", { currentPrice: 1.108 }),
  ]);

  assertEquals(ranked.get("local-held")?.rank, 1);
  assertEquals(ranked.get("local-held")?.topCandidate, true);
  assertEquals(ranked.get("fourth")?.topCandidate, false);
  assertGreater(
    ranked.get("local-held")?.totalScore ?? 0,
    ranked.get("far")?.totalScore ?? 0,
  );
});

Deno.test("violated zones remain observable but cannot win", () => {
  const violated = classifyZoneCandidateLifecycle({
    zone: { low: 1.1, high: 1.101, direction: "bullish" },
    candlesAfterFormation: [
      candle(1.1005, 1.1008, 1.0995, 1.0998, 1),
    ],
  });
  const ranked = rankZoneCandidateModels([
    candidate("violated", {
      localConfluenceScore: 5,
      displacementPercentile: 100,
      lifecycle: violated,
    }),
    candidate("valid", {}),
  ]);
  assertEquals(ranked.get("violated")?.eligible, false);
  assertEquals(ranked.get("valid")?.rank, 1);
});

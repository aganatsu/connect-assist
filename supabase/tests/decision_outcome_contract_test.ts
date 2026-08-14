import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildDecisionOutcomeSnapshot, outcomeCandlePlanForStyle, outcomeCandleRequest, outcomeWindowForStyle } from "../functions/_shared/decisionOutcomeContract.ts";

Deno.test("style-specific outcome windows are deterministic", () => {
  assertEquals(outcomeWindowForStyle("scalper"), 8);
  assertEquals(outcomeWindowForStyle("day_trader"), 24);
  assertEquals(outcomeWindowForStyle("swing_trader"), 72);
});

Deno.test("outcome candle resolution matches the frozen trading style", () => {
  assertEquals(outcomeCandlePlanForStyle("scalper"), { interval: "1min", intervalMinutes: 1 });
  assertEquals(outcomeCandlePlanForStyle("day_trader"), { interval: "5min", intervalMinutes: 5 });
  assertEquals(outcomeCandlePlanForStyle("swing_trader"), { interval: "1h", intervalMinutes: 60 });
});

Deno.test("outcome candle requests cover the exact frozen historical window", () => {
  assertEquals(outcomeCandleRequest("scalper", "2026-08-14T10:00:00.000Z", 8, "2026-08-14T12:00:00.000Z"), {
    interval: "1min", intervalMinutes: 1, limit: 154,
    startAt: "2026-08-14T09:30:00.000Z", endAt: "2026-08-14T12:00:00.000Z",
  });
  assertEquals(outcomeCandleRequest("day_trader", "2026-08-01T10:00:00.000Z", 24, "2026-08-03T10:00:00.000Z"), {
    interval: "5min", intervalMinutes: 5, limit: 322,
    startAt: "2026-08-01T07:30:00.000Z", endAt: "2026-08-02T10:00:00.000Z",
  });
});

Deno.test("snapshot separates authority from legacy diagnostics", () => {
  const snapshot = buildDecisionOutcomeSnapshot({
    rawDetail: { stylePolicy: { style: "day_trader" }, canonicalScannerState: { contractVersion: "canonical-scanner-state.v1", stage: "blocked" } },
    confluenceScore: 73,
    tier1Count: 3,
    tier1Factors: ["Market Structure"],
  });
  assertEquals(snapshot.compatibility, "complete");
  assertEquals(snapshot.tradingStyle, "day_trader");
  assertEquals(snapshot.legacyDiagnostics.confluenceScore, 73);
});

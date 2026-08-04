import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  confirmationEvidenceLines,
  confirmationMethodLabel,
  crossTimeframeAuthorityLine,
  diagnosticScoreLine,
  directionVerdictLines,
  durationLabel,
  impulseTimeframeLabel,
  parseSignalReason,
  rMultiple,
  styleLadderLines,
  tgLine,
  tradeAuthorityLines,
  watchlistOriginLines,
  zoneEvidenceLines,
} from "../../functions/_shared/telegramDetail.ts";

Deno.test("parseSignalReason handles text, object and garbage", () => {
  assertEquals(parseSignalReason('{"a":1}').a, 1);
  assertEquals(parseSignalReason({ a: 2 }).a, 2);
  assertEquals(parseSignalReason("not json"), {});
  assertEquals(parseSignalReason(null), {});
});

Deno.test("tgLine skips empty and non-finite values", () => {
  assertEquals(tgLine("A", null), "");
  assertEquals(tgLine("A", undefined), "");
  assertEquals(tgLine("A", "  "), "");
  assertEquals(tgLine("A", NaN), "");
  assertEquals(tgLine("A", 1), "<b>A:</b> 1\n");
});

Deno.test("impulse timeframe label maps engine codes", () => {
  assertEquals(impulseTimeframeLabel({ impulseZone: { selectedTF: "D" } }), "Daily");
  assertEquals(impulseTimeframeLabel({ impulseZone: { selectedTF: "1h" } }), "1H");
  assertEquals(impulseTimeframeLabel({}), null);
});

Deno.test("zoneEvidenceLines renders the impulse story and degrades safely", () => {
  assertEquals(zoneEvidenceLines({}), "");
  const out = zoneEvidenceLines({
    impulseZone: {
      selectedTF: "1H",
      bestZone: { type: "ob", fibLevel: 0.705, htfLayers: ["4H_FVG"], totalScore: 8.25, ltfRefined: true, ltfType: "fvg" },
      impulse: { direction: "bullish", endDate: "2026-08-01T04:00:00Z", spanBars: 7 },
    },
  });
  assertStringIncludes(out, "Impulse TF:</b> 1H");
  assertStringIncludes(out, "OB @ fib 0.705");
  assertStringIncludes(out, "4H FVG");
  assertStringIncludes(out, "Zone evidence (diagnostic):</b> 8.3 · does not authorize");
  assertStringIncludes(out, "LTF Refined");
});

Deno.test("direction verdict and authority lines", () => {
  assertEquals(directionVerdictLines(null), "");
  assertStringIncludes(
    directionVerdictLines({ verdict: "long", confidence: 72, agreement: 0.8 }),
    "LONG · 72% conf · 80% agreement",
  );
  assertEquals(crossTimeframeAuthorityLine(null), "");
  assertStringIncludes(
    crossTimeframeAuthorityLine({ effectiveMode: "observe", requestedMode: "enforce" }),
    "observe (requested enforce)",
  );
});

Deno.test("style ladder uses explicit roles when provided", () => {
  const out = styleLadderLines({ frozenStrategyContext: { style: "scalper" } }, { bias: "1h", structure: "15m", setup: "5m" });
  assertStringIncludes(out, "Style:</b> scalper");
  assertStringIncludes(out, "1H bias → 15M structure → 5M setup");
  assertEquals(styleLadderLines({}), "");
});

Deno.test("watchlist origin lines", () => {
  assertEquals(watchlistOriginLines({}), "");
  assertStringIncludes(
    watchlistOriginLines({ watchlistOrigin: { cyclesWatched: 4, initialScore: 61.2 } }),
    "4 cycles · from 61.2%",
  );
});

Deno.test("entry confirmation labels include reversal candles and actual pattern", () => {
  assertEquals(confirmationMethodLabel("choch"), "MSS / CHoCH / reversal candle");
  assertEquals(confirmationMethodLabel("choch_and_indicators", 3), "MSS / CHoCH / reversal candle + indicators (3/4)");
  const out = confirmationEvidenceLines({
    type: "bullish_reversal_pattern", displacement: 0.72,
    supportingSignals: ["pattern:Morning Star", "pattern_strength:strong"],
  });
  assertStringIncludes(out, "Morning Star · displacement 0.72");
});

Deno.test("trade authority excludes legacy scores and labels diagnostics", () => {
  const out = tradeAuthorityLines({
    singleOwnershipDecision: {
      decision: "allow",
      authorities: {
        zoneStory: { valid: true, entryReady: true },
        canonicalLocation: { required: true, allowed: true },
        confirmation: { required: true, passed: true },
        thesis: { required: true, valid: true },
        safety: { complete: true, checks: [] },
      },
    },
    singleOwnershipEnforcement: { affectsAuthorization: true },
  });
  assertStringIncludes(out, "ALLOW · ENFORCED");
  assertStringIncludes(out, "Zone Story:</b> valid · entry ready");
  assertStringIncludes(out, "Operational Safety:</b> passed");
  assertEquals(out.includes("score"), false);
  assertStringIncludes(diagnosticScoreLine(8.5), "legacy score 8.5 · does not authorize");
});

Deno.test("rMultiple respects direction and rejects bad input", () => {
  assertEquals(rMultiple(1.1, 1.09, 1.12, "long")?.toFixed(2), "2.00");
  assertEquals(rMultiple(1.1, 1.11, 1.08, "short")?.toFixed(2), "2.00");
  assertEquals(rMultiple(1.1, 1.1, 1.12, "long"), null);
  assertEquals(rMultiple(null, 1, 2, "long"), null);
});

Deno.test("durationLabel formats minutes, hours and days", () => {
  const base = "2026-08-01T00:00:00Z";
  assertEquals(durationLabel(base, "2026-08-01T00:45:00Z"), "45m");
  assertEquals(durationLabel(base, "2026-08-01T02:14:00Z"), "2h 14m");
  assertEquals(durationLabel(base, "2026-08-03T03:00:00Z"), "2d 3h");
  assertEquals(durationLabel(null), null);
});

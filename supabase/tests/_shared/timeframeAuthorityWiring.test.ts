import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const [scanner, backtest, directionEngine] = await Promise.all([
  Deno.readTextFile("./supabase/functions/bot-scanner/index.ts"),
  Deno.readTextFile("./supabase/functions/backtest-engine/index.ts"),
  Deno.readTextFile("./supabase/functions/_shared/directionEngine.ts"),
]);

Deno.test("live and backtest resolve one policy timeframe authority", () => {
  for (
    const [surface, source] of [
      ["live scanner", scanner],
      ["backtest", backtest],
    ] as const
  ) {
    assertStringIncludes(
      source,
      "const timeframeAuthority = resolveTimeframeAuthority(",
      `${surface} must resolve the persisted policy roles`,
    );
    assertStringIncludes(
      source,
      "bindTimeframeCandles(",
      `${surface} must bind candle arrays by authoritative role`,
    );
    assertStringIncludes(
      source,
      "buildStyleDecisionEvidence(",
      `${surface} direction evidence must come from the authority`,
    );
    assertStringIncludes(
      source,
      "timeframeAuthority,",
      `${surface} must pass the resolved authority into direction evidence`,
    );
    assertStringIncludes(
      source,
      "zoneTimeframeLabels(",
      `${surface} zone labels must come from the authority`,
    );
  }
});

Deno.test("scalper backtest fetches real 15m structure candles", () => {
  assertStringIncludes(backtest, "needsDedicatedM15");
  assertStringIncludes(
    backtest,
    'fetchHistoricalCandles(\n            symbol,\n            "15m"',
  );
  assertStringIncludes(
    backtest,
    '{ timeframe: "15m", candles: relevantM15.slice(-200) }',
  );
  assert(
    !backtest.includes("1H as mid-TF proxy"),
    "backtest must not substitute 1H candles for the scalper 15m role",
  );
});

Deno.test("direction labels derive from the style-policy role contract", () => {
  assertStringIncludes(
    directionEngine,
    'import { STYLE_TIMEFRAME_ROLES } from "../../functions/_shared/stylePolicy.ts"',
  );
  assertStringIncludes(
    directionEngine,
    "const roles = STYLE_TIMEFRAME_ROLES[style]",
  );
  assert(
    !directionEngine.includes(
      'scalper: { biasTFLabel: "1H", structureTFLabel: "15m"',
    ),
    "direction engine must not retain a duplicate executable style map",
  );
});

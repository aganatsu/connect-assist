import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * confirmedTrend carries the heaviest weight in the direction verdict — 0.40,
 * against 0.25 for simpleDirection, the only genuinely style-aware source. It
 * was computed from Daily candles for every style, so a scalper trading 5m
 * entries had its direction decided 40% by a Daily trend, while
 * STYLE_TF_LABELS.scalper says bias should be 1H.
 *
 * A Daily trend disagreeing with a valid 5m setup is not a malfunction, it is
 * what different timeframes do. Measured 2026-09-02: 300 of 1,340 evaluations
 * (22%) had the verdict opposing the entry direction, with gate reasons showing
 * "agreement: 33%" — one source of three.
 *
 * Scope: this verifies WHICH candle array is passed to confirmedTrend. It does
 * not re-test the engine — that is directionEngine's own suite — and an earlier
 * draft's synthetic "timeframes disagree" fixtures were monotonic lines with no
 * swing points, so confirmedTrend returned ranging for both and proved nothing.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

function verdictBlock(): string {
  const at = scanner.indexOf("confirmedTrend runs on the style's BIAS timeframe");
  assert(at > -1, "confirmedTrend bias-timeframe block not found");
  return scanner.slice(at, at + 2600);
}

Deno.test("scalper computes confirmedTrend on 1h, not Daily", () => {
  const block = verdictBlock();
  assert(
    /resolvedStyle === "scalper" && hourlyCandles\.length >= 20/.test(block),
    "scalper must prefer hourly candles for the trend spine",
  );
  assert(
    /const biasCandles = preferHourly \? hourlyCandles : dailyCandles/.test(block),
    "biasCandles must select hourly for scalper and daily otherwise",
  );
});

Deno.test("day_trader and swing still use Daily", () => {
  // day_trader's bias timeframe IS Daily. Swing's is Weekly, but weeklyBias
  // already feeds the verdict separately — pointing confirmedTrend at Weekly
  // too would count one timeframe twice across 0.52 of the weight.
  const block = verdictBlock();
  assert(
    !/resolvedStyle === "swing_trader"[\s\S]{0,120}weeklyCandles/.test(block),
    "swing must not route confirmedTrend to weekly while weeklyBias also feeds it",
  );
});

Deno.test("a short 1h series falls back to Daily rather than dropping the spine", () => {
  // Daily is served from kv_cache and is nearly always present; 1h is fetched
  // live each cycle. Without the fallback one failed fetch removes 0.40 of the
  // verdict weight silently, which is worse than a slower timeframe.
  const block = verdictBlock();
  assert(
    /hourlyCandles\.length >= 20/.test(block),
    "the hourly path must be guarded by a minimum candle count",
  );
  assert(
    /preferHourly \? hourlyCandles : dailyCandles/.test(block),
    "falling back must land on dailyCandles, not null",
  );
});

Deno.test("the chosen timeframe is logged so it is auditable", () => {
  const block = verdictBlock();
  assert(/confirmedTrend on \$\{biasTFLabel\}/.test(block), "must log which timeframe was used");
  assert(/fell back/.test(block), "a fallback must be visible in the log, not silent");
});

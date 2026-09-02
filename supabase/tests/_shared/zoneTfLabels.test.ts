import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * The zone engine's three candle slots are positional. bot-scanner fills them
 * with different timeframes per style:
 *
 *   scalper      top=1H    mid=15m   low=5m
 *   day_trader   top=D     mid=4H    low=1H
 *   swing        top=W     mid=D     low=4H
 *
 * selectedTF used to be hardcoded to "D" | "4H" | "1H" — the slot names, not
 * the timeframes — and ZoneStoryPanel rendered "D" as the literal string
 * "Daily". So a scalper looking at "Zone Story via D" was reading a 1H zone
 * described as a Daily one. Correct only for day_trader, where the slot names
 * happen to coincide with the real timeframes, which is presumably why it
 * survived: the labels were written when day_trader was the only style.
 *
 * Ported from 59a7b8b7 (PR #75, "use style-aware TF labels in zone engine
 * instead of hardcoded D/4H/1H"), removed by the 2026-09-01 revert.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const panel = await Deno.readTextFile(
  new URL("../../../src/components/ZoneStoryPanel.tsx", import.meta.url),
);

Deno.test("each style declares its own slot labels", () => {
  const expected: Array<[string, string]> = [
    ["scalper", '{ top: "1H", mid: "15m", low: "5m" }'],
    ["swing", '{ top: "W", mid: "D", low: "4H" }'],
    ["day_trader", '{ top: "D", mid: "4H", low: "1H" }'],
  ];
  for (const [style, literal] of expected) {
    assert(
      scanner.includes(literal),
      `${style} slot labels missing — expected ${literal}`,
    );
  }
});

Deno.test("the labels match the candle arrays actually passed", () => {
  // The label is only true if the slot really holds that timeframe. Scalper
  // fills top with hourlyCandles, mid with m15Candles, low with the 5m entry
  // candles; if that assignment changes, the label silently starts lying again.
  const at = scanner.indexOf('zoneTFLabels = { top: "1H", mid: "15m", low: "5m" }');
  assert(at > -1, "scalper labels not found");
  // Assignments follow the label declaration, not precede it.
  const block = scanner.slice(at, at + 700);
  assert(/zoneH1Candles = candles;/.test(block), "scalper low slot should be the 5m entry candles");
  assert(/zoneH4Candles = m15Candles;/.test(block), "scalper mid slot should be 15m");
  assert(/zoneDailyCandles = hourlyCandles/.test(block), "scalper top slot should be 1H");
});

Deno.test("labels are threaded into the zone engine", () => {
  assert(
    /findUnifiedZone\([\s\S]{0,1400}zoneTFLabels,/.test(scanner),
    "zoneTFLabels must be passed to findUnifiedZone or the engine falls back to defaults",
  );
});

Deno.test("the panel renders the label instead of hardcoding Daily", () => {
  assert(
    !/selectedTF === "D" \? "Daily"/.test(panel),
    'ZoneStoryPanel must not translate "D" to "Daily" — the slot is not a timeframe',
  );
  assert(
    /\{unifiedData\.selectedTF \?\? "—"\}/.test(panel),
    "the panel should render whatever label the engine reported",
  );
});

Deno.test("setup grade comes from score, not from which slot won", () => {
  // A+/B+ used to be inferred from selectedTF, which conflated "highest slot"
  // with "best setup". tfBonus grades the zone itself.
  assert(
    /scoreBreakdown\.tfBonus >= 2\.0 \? " \(A\+ setup\)"/.test(panel),
    "A+ grade should derive from tfBonus",
  );
});

Deno.test("selectedTF is no longer typed as a fixed slot union", () => {
  assert(
    !/selectedTF: "D" \| "4H" \| "1H" \| null/.test(panel),
    "the panel type must allow any style's labels",
  );
  assertEquals(/selectedTF: string \| null/.test(panel), true);
});

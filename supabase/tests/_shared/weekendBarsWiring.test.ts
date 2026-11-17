/**
 * WEEKEND_BARS_PREREG_V1 — source pins on bot-scanner's wiring of the FX weekend drop.
 */
import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const src = Deno.readTextFileSync(new URL("../../functions/bot-scanner/index.ts", import.meta.url));

Deno.test("default on; only an explicit false restores weekend bars", () => {
  assertStringIncludes(src, "const dropWk = (pairConfig as any).dropFxWeekendBars !== false;");
  assertStringIncludes(src, "dropFxWeekendBars: raw.dropFxWeekendBars !== false,");
});

Deno.test("every SMC analysis series goes through realBars; weekly does not", () => {
  for (const tf of ['entryInterval, rawCandles', '"1d", fetched[1]', '"4h", fetched[2]', '"1h", rawHourly', '"15m", fetched[3 + h4Offset]']) {
    assertStringIncludes(src, `realBars(pair, ${tf}`);
  }
  assert(!/realBars\([^)]*"1w"/.test(src), "weekly must not be filtered");
});

Deno.test("fetchCandles still returns the last `limit` raw bars to every other consumer", () => {
  assertStringIncludes(src, "return result.candles.slice(-limit);");
  assertStringIncludes(src, "writeLiveStructureBars(supabase, pair, rawHourly,");
  assertStringIncludes(src, "writeLiveStructureBars5m(supabase, pair, rawCandles,");
});

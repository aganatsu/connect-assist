import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { aggregateMT5Candles, parseMT5History } from "../functions/_shared/mt5History.ts";

Deno.test("MT5 tab history parses, deduplicates and aggregates", () => {
  const rows = ["<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>"];
  for (let i = 0; i < 30; i++) rows.push(`2026.01.02\t00:${String(i).padStart(2,"0")}:00\t1.${i}00\t1.${i}20\t1.${i}00\t1.${i}10\t10`);
  const parsed = parseMT5History(rows.join("\n"));
  assertEquals(parsed.candles.length, 30);
  assertEquals(parsed.delimiter, "tab");
  const m15 = aggregateMT5Candles(parsed.candles, "15m");
  assertEquals(m15.length, 2);
  assertEquals(m15[0].open, parsed.candles[0].open);
  assertEquals(m15[0].close, parsed.candles[14].close);
  assertEquals(m15[0].volume, 150);
  const shifted = parseMT5History(rows.join("\n"), 120);
  assertEquals(shifted.candles[0].datetime, "2026-01-01T22:00:00.000Z");
});

/**
 * SCALPER15_PREREG_V1 — corpus layout, shared by the fetcher and the runner. No provider
 * import here, so the runner can read the cache without loading an API key.
 */

import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { tradeableAt } from "./scalper15Engine.ts";

export const SYMBOLS = ["EUR/USD", "USD/JPY", "GBP/USD", "AUD/USD", "USD/CAD", "USD/CHF", "NZD/USD"];

/** Fetch end (exclusive day). Decisions run to 2026-11-04. */
export const TO = "2026-11-05";

/** Spans start before the first decision so every lookback (480×15m, 1440×5m, 1H swings) is full. */
export const TF_SPEC: Array<{ tf: string; iv: string; from: string; chunkDays: number }> = [
  { tf: "1m", iv: "1min", from: "2026-03-28", chunkDays: 3 },
  { tf: "5m", iv: "5min", from: "2026-03-01", chunkDays: 16 },
  { tf: "15m", iv: "15min", from: "2026-02-01", chunkDays: 50 },
  { tf: "1h", iv: "1h", from: "2025-10-01", chunkDays: 200 },
];

export const CACHE = new URL("./.cache/scalper15/", import.meta.url);
try { Deno.mkdirSync(CACHE, { recursive: true }); } catch { /* exists */ }
export const cacheFile = (sym: string, tf: string) => new URL(`${sym.replace("/", "")}_${tf}.json`, CACHE);

/** Cached bars with the weekend FX tape removed. Empty if not fetched. */
export function loadTf(sym: string, tf: string): Candle[] {
  try {
    const bars: Candle[] = JSON.parse(Deno.readTextFileSync(cacheFile(sym, tf)));
    return bars.filter((b) => tradeableAt(Date.parse(b.datetime)));
  } catch { return []; }
}

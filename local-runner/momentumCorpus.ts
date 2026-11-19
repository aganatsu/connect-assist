/** MOMENTUM_BOS_PREREG_V1 — corpus layout, shared by the fetcher and the runner (no API key needed to read). */

import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { tradeableAt } from "./scalper15Engine.ts";

export const SYMBOLS = ["EUR/USD", "USD/JPY", "GBP/USD", "AUD/USD", "USD/CAD", "USD/CHF", "NZD/USD"];
export const FROM = "2023-11-01";
export const TO = "2026-01-01";

export const CACHE = new URL("./.cache/momentum/", import.meta.url);
try { Deno.mkdirSync(CACHE, { recursive: true }); } catch { /* exists */ }
export const cacheFile = (sym: string, tf: string) => new URL(`${sym.replace("/", "")}_${tf}.json`, CACHE);

/** Cached bars with the weekend FX tape removed. Empty if not fetched. */
export function loadTf(sym: string, tf: string): Candle[] {
  try {
    const bars: Candle[] = JSON.parse(Deno.readTextFileSync(cacheFile(sym, tf)));
    return bars.filter((b) => tradeableAt(Date.parse(b.datetime)));
  } catch { return []; }
}

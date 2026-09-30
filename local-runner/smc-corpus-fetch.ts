/**
 * SMC_IMPULSE_ZONE_CORPUS_BACKTEST_V1 — corpus builder. READ-ONLY, cached.
 *
 * Fetches the fixed FX corpus at every timeframe the production scalper path
 * consumes, plus 1m for execution ordering. Windows are frozen here, before
 * any result is seen.
 *
 *   PRIMARY    90 days  2026-06-27 .. 2026-09-25
 *   SECONDARY 180 days  2026-03-29 .. 2026-09-25
 *
 * Both are cut from ONE fetch so the primary is a strict suffix of the
 * secondary and neither can be re-chosen after seeing P&L.
 *
 *   deno run --allow-net --allow-read --allow-write --allow-env \
 *     local-runner/smc-corpus-fetch.ts
 */

import { series } from "./ipo-stock-datacheck.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";

export const SYMBOLS = ["EUR/USD", "USD/JPY", "GBP/USD", "AUD/USD",
                        "USD/CAD", "USD/CHF", "NZD/USD"];

/** The 8 production-eligible instruments (bot_configs config_json.instruments). */
export const PRODUCTION_UNIVERSE = ["EUR/USD", "GBP/USD", "USD/JPY", "BTC/USD",
                                    "ETH/USD", "CHF/JPY", "NZD/CAD", "NZD/CHF"];

/** Instruments still needing a corpus. */
export const NEW_SYMBOLS = ["BTC/USD", "ETH/USD", "CHF/JPY", "NZD/CAD", "NZD/CHF"];

/**
 * TwelveData returns a CONTINUOUS 24/7 tape for spot FX: the cached EUR/USD 1m
 * corpus is 28.2% Saturday/Sunday bars, with no gap at all across the Friday
 * close (3,241 bars in a Fri-20:00 to Mon-02:00 window where continuous 1m is
 * 3,240). Those bars move — 99.9% have high != low — at about 40% of weekday
 * range. Spot FX is shut then, so they cannot be traded.
 *
 * Crypto genuinely IS 24/7, so the filter is asset-class aware, not global.
 */
export const isCrypto = (sym: string) => sym === "BTC/USD" || sym === "ETH/USD";
export const tradeableAt = (sym: string, tMs: number): boolean => {
  if (isCrypto(sym)) return true;
  const d = new Date(tMs).getUTCDay();          // 0 Sun .. 6 Sat
  if (d === 6) return false;                     // Saturday: shut
  if (d === 0) return new Date(tMs).getUTCHours() >= 22;  // Sun open ~22:00 UTC
  if (d === 5) return new Date(tMs).getUTCHours() < 22;   // Fri close ~22:00 UTC
  return true;
};

export const WINDOWS = {
  primary:   { from: "2026-06-27", to: "2026-09-25", days: 90 },
  secondary: { from: "2026-03-29", to: "2026-09-25", days: 180 },
} as const;

/**
 * Fetch spans EXCEED the decision window on purpose: at the first decision
 * point the engine still needs its full production lookback behind it — 260
 * daily bars and 52 weekly bars reach back a year — and starting the corpus at
 * the window edge would silently hand the engine a short history.
 */
export const TF_SPEC: Array<{ tf: string; iv: string; from: string; chunkDays: number }> = [
  { tf: "1m",  iv: "1min",   from: "2026-03-29", chunkDays: 3 },
  { tf: "5m",  iv: "5min",   from: "2026-03-01", chunkDays: 16 },
  { tf: "15m", iv: "15min",  from: "2026-02-01", chunkDays: 50 },
  { tf: "1h",  iv: "1h",     from: "2025-10-01", chunkDays: 200 },
  { tf: "4h",  iv: "4h",     from: "2025-01-01", chunkDays: 800 },
  { tf: "1d",  iv: "1day",   from: "2024-06-01", chunkDays: 900 },
  { tf: "1w",  iv: "1week",  from: "2023-01-01", chunkDays: 1500 },
];

const TO = "2026-09-25";
const CACHE = new URL("./.cache/smc/", import.meta.url);
try { Deno.mkdirSync(CACHE, { recursive: true }); } catch { /* exists */ }

const key = (s: string, tf: string) => `${s.replace("/", "")}_${tf}.json`;

export function loadCorpus(sym: string, tf: string): Candle[] {
  try { return JSON.parse(Deno.readTextFileSync(new URL(key(sym, tf), CACHE))); }
  catch { return []; }
}

if (import.meta.main) {
  for (const sym of SYMBOLS) {
    for (const { tf, iv, from, chunkDays } of TF_SPEC) {
      const f = new URL(key(sym, tf), CACHE);
      try { Deno.readTextFileSync(f); console.log(`${sym} ${tf}: cached`); continue; }
      catch { /* fetch */ }

      const out: Candle[] = [];
      let cur = Date.parse(from);
      const end = Date.parse(TO);
      while (cur <= end) {
        const a = new Date(cur).toISOString().slice(0, 10);
        const bMs = Math.min(cur + chunkDays * 86_400_000, end + 86_400_000);
        const b = new Date(bMs).toISOString().slice(0, 10);
        try { out.push(...await series(sym, iv, a, b)); }
        catch (e) { console.log(`  ${sym} ${tf} ${a}: ${(e as Error).message.slice(0, 70)}`); }
        cur = bMs;
      }
      // Duplicates are dropped by instant, never merged: two rows for one
      // instant mean the provider revised a bar, and averaging them would
      // invent a candle that never traded.
      const seen = new Set<string>();
      const clean = out
        .filter((c) => !seen.has(c.datetime) && seen.add(c.datetime))
        .sort((x, y) => Date.parse(x.datetime) - Date.parse(y.datetime));
      Deno.writeTextFileSync(f, JSON.stringify(clean));
      console.log(`${sym} ${tf}: ${clean.length} bars ` +
        `(${out.length - clean.length} dupes dropped) ` +
        `${clean[0]?.datetime.slice(0, 10)}..${clean[clean.length - 1]?.datetime.slice(0, 10)}`);
    }
  }
  console.log("\ncorpus complete");
}

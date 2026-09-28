/**
 * Live-tape check for the entry-time stamper. READ-ONLY — no DB writes.
 *
 * WHY THIS EXISTS. `stampEntryMinute` fails SILENTLY by design: if no minute in
 * the bar reaches the entry it returns the position unchanged, and the row is
 * honestly marked bar-precision. That is right for a feed disagreement — and
 * indistinguishable from the 1m and HTF feeds being on different clocks, which
 * has already happened in this repo (TwelveData timestamps were exchange-local
 * and an appended `Z` hid the offset).
 *
 * If the two feeds disagreed about time, `minutesInBar` would return [] for
 * every bar, every stamp would no-op, and the only symptom would be that all
 * new rows stayed amber. This checks the alignment directly against the live
 * provider, using the production functions, before waiting a week to find out.
 *
 *   deno run --allow-net --allow-read --allow-env local-runner/ipo-stamp-livecheck.ts
 */

import {
  firstEntryMinute, minutesInBar,
} from "../supabase/functions/_shared/ipoCausalOrdering.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";

function apiKey(): string {
  const env = Deno.env.get("TWELVE_DATA_API_KEY");
  if (env) return env;
  for (const line of Deno.readTextFileSync(
    new URL("./.env.local", import.meta.url)).split("\n")) {
    const [k, ...rest] = line.split("=");
    if (k.trim() === "TWELVE_DATA_API_KEY") {
      return rest.join("=").trim().replace(/^["']|["']$/g, "");
    }
  }
  throw new Error("TWELVE_DATA_API_KEY missing");
}

async function series(symbol: string, interval: string, size: number): Promise<Candle[]> {
  const p = new URLSearchParams({
    symbol, interval, outputsize: String(size), apikey: apiKey(), timezone: "UTC",
  });
  const body = await (await fetch(`https://api.twelvedata.com/time_series?${p}`)).json();
  if (!body.values) throw new Error(`no values for ${symbol} ${interval}: ${body.message ?? ""}`);
  return (body.values as Array<Record<string, string>>)
    .map((v) => ({
      datetime: v.datetime.includes("T") ? v.datetime : v.datetime.replace(" ", "T") + "Z",
      open: +v.open, high: +v.high, low: +v.low, close: +v.close, volume: 0,
    } as Candle))
    .sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));
}

const H1 = 3_600_000;

for (const symbol of ["BTC/USD", "EUR/USD", "USD/JPY"]) {
  console.log(`\n=== ${symbol} ===`);
  const hours = await series(symbol, "1h", 5);
  const mins = await series(symbol, "1min", 400);

  // The last CLOSED hour: the newest bar is still forming.
  const bar = hours[hours.length - 2];
  const inBar = minutesInBar(mins, bar, H1);
  console.log(`  bar        ${bar.datetime}  H ${bar.high}  L ${bar.low}`);
  console.log(`  minutes in bar: ${inBar.length}   ${inBar.length === 60 ? "OK" : "<-- CLOCKS DISAGREE"}`);
  if (inBar.length === 0) {
    console.log("  !! every stamp would silently no-op for this symbol");
    continue;
  }
  console.log(`  first      ${inBar[0].datetime}`);
  console.log(`  last       ${inBar[inBar.length - 1].datetime}`);

  // A long entry at the bar's midpoint must be reachable, and the minute it
  // resolves to must lie inside the bar.
  const mid = (bar.high + bar.low) / 2;
  const hit = firstEntryMinute(mins, bar, H1, "long", mid);
  const from = Date.parse(bar.datetime);
  const inside = hit !== null
    && Date.parse(hit.datetime) >= from && Date.parse(hit.datetime) < from + H1;
  console.log(`  entry @ mid ${mid.toFixed(5)} -> ${hit?.datetime ?? "NO MINUTE"}` +
              `  ${inside ? "inside the bar OK" : "<-- OUT OF BAR"}`);

  // And the HTF bar's own low must be reachable by some minute, or the two
  // feeds disagree about price as well as time.
  const lowHit = firstEntryMinute(mins, bar, H1, "long", bar.low);
  console.log(`  entry @ bar low -> ${lowHit?.datetime ?? "NO MINUTE  <-- FEEDS DISAGREE"}`);
}

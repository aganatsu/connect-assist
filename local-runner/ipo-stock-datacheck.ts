/**
 * IPO_STOCK_BASELINE_V1 — DATA VALIDITY probe. READ-ONLY, no DB writes.
 *
 * Decides whether the equities data can meet the causal standard the forex
 * baseline was accepted under, BEFORE any profitability is computed. The spec
 * says stop if corporate-action handling is unclear, 1m execution data is
 * incomplete, survivorship contaminates the universe, or same-bar ordering
 * cannot be resolved. This measures each of those.
 *
 * Uses the PRODUCTION `minutesInBar` so the bucketing is the one the runner
 * would actually use — an hour-of-day slice straddles two bars, because US
 * equity hourly bars start at 09:30, not on the hour.
 *
 *   deno run --allow-net --allow-read --allow-env local-runner/ipo-stock-datacheck.ts
 */

import { minutesInBar } from "../supabase/functions/_shared/ipoCausalOrdering.ts";
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
const KEY = apiKey();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Exchange-local (America/New_York) wall time, tagged as such and converted to
 * a real instant. The provider returns naive local strings; appending `Z` is
 * the exact bug that broke every CHoCH window in this repo once already.
 */
function nyToInstant(s: string): string {
  const [d, t] = s.split(" ");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, mi] = (t ?? "00:00:00").split(":").map(Number);
  // EDT/EST: resolve by probing the offset UTC would need for this local time.
  for (const off of [4, 5]) {
    const guess = Date.UTC(Y, M - 1, D, h + off, mi);
    const back = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York", hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date(guess));
    const g = Object.fromEntries(back.map((p) => [p.type, p.value]));
    if (+g.year === Y && +g.month === M && +g.day === D
        && +g.hour === h && +g.minute === mi) return new Date(guess).toISOString();
  }
  return new Date(Date.UTC(Y, M - 1, D, h + 4, mi)).toISOString();
}

/**
 * Proactive pacing. Measured: one `time_series` call costs 2 credits against a
 * 55/minute ceiling on the `grow` plan, so ~27 requests per minute. Waiting
 * 2.3s up front is far cheaper than discovering the ceiling — a reactive
 * backoff alone spent ~2 minutes per request because every call arrived over
 * the limit and slept, and the fetch made almost no progress.
 */
const MIN_GAP_MS = 2_300;
let lastCall = 0;
async function pace() {
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

export async function series(
  symbol: string, interval: string, start: string, end: string,
): Promise<Candle[]> {
  const p = new URLSearchParams({
    symbol, interval, start_date: start, end_date: end,
    timezone: "America/New_York", outputsize: "5000", apikey: KEY,
  });
  for (let attempt = 0; attempt < 6; attempt++) {
    await pace();
    const body = await (await fetch(`https://api.twelvedata.com/time_series?${p}`)).json();
    if (body.values) {
      return (body.values as Array<Record<string, string>>)
        .map((v) => ({
          datetime: nyToInstant(v.datetime),
          open: +v.open, high: +v.high, low: +v.low, close: +v.close,
          volume: +(v.volume ?? 0),
        } as Candle))
        .sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));
    }
    const msg = String(body.message ?? "");
    if (/API credits/i.test(msg)) { await sleep(20_000); continue; }
    if (/No data is available/i.test(msg)) return [];
    throw new Error(`${symbol} ${interval}: ${msg.slice(0, 120)}`);
  }
  throw new Error(`${symbol} ${interval}: credit backoff exhausted`);
}

const H1 = 3_600_000;

if (import.meta.main) {
  console.log("=== 1h vs 1m consistency, using production minutesInBar ===");
  console.log("(each case is the trading day BEFORE a large split)\n");

  for (const [sym, day, note] of [
    ["NVDA", "2024-06-05", "before 10:1"],
    ["AMZN", "2022-06-02", "before 20:1"],
    ["TSLA", "2022-08-23", "before 3:1"],
    ["AAPL", "2025-03-03", "no split nearby (control)"],
  ]) {
    const nxt = new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);
    const hours = (await series(sym, "1h", day, nxt)).filter((b) => b.datetime.slice(0, 10) <= day || true);
    const mins = await series(sym, "1min", day, nxt);
    const dayHours = hours.filter((b) => b.datetime >= nyToInstant(`${day} 09:30:00`)
                                      && b.datetime < nyToInstant(`${day} 16:00:00`));
    console.log(`${sym} ${day} (${note}): ${dayHours.length} 1h bars, ${mins.length} 1m bars`);
    let worst = 0, missing = 0;
    for (const bar of dayHours) {
      const ins = minutesInBar(mins, bar, H1);
      if (ins.length === 0) { missing++; continue; }
      const mh = Math.max(...ins.map((m) => m.high));
      const ml = Math.min(...ins.map((m) => m.low));
      // The tape must never exceed the bar it belongs to.
      const over = Math.max(mh - bar.high, bar.low - ml);
      const pct = over / bar.low * 100;
      worst = Math.max(worst, pct);
      const t = new Date(bar.datetime).toLocaleTimeString("en-US",
        { timeZone: "America/New_York", hour12: false });
      console.log(`   ${t}  ${ins.length.toString().padStart(2)}m  ` +
        `bar ${bar.high.toFixed(2)}/${bar.low.toFixed(2)}  ` +
        `tape ${mh.toFixed(2)}/${ml.toFixed(2)}  overshoot ${pct.toFixed(3)}%`);
    }
    console.log(`   worst tape-outside-bar: ${worst.toFixed(3)}%  ` +
      `${worst < 0.05 ? "CONSISTENT" : "INCONSISTENT"}` +
      `${missing ? `  (${missing} bars had no minutes)` : ""}\n`);
  }
}

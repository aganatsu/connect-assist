/**
 * IPO_TTM_SQUEEZE_TELEMETRY_V1 — strategy-timeframe corpus, rebuilt.
 *
 * The frozen IPO_BASELINE_1H_4H_CAUSAL_V1 run read its 1H/4H series from
 * /tmp/ipo-tf-data, which macOS has since cleared, and the script that wrote
 * those files was never committed. This rebuilds them into a PERSISTENT cache
 * (local-runner/.cache, gitignored) so the study is reproducible.
 *
 * It also fetches the same 1H/30min series ipo-bos-fetch.ts used, because the
 * frozen decision span started at the first 1m bar, which was paged back to
 * the first of the last 1,800 of those bars (ipo-m1-fetch.ts: `fromMs`). That
 * anchor is what the reconstruction needs, and it costs 12 requests instead
 * of the ~220 a full 1m re-fetch would.
 *
 * WHY SO FEW REQUESTS. The TwelveData key is shared with production, and the
 * live scanner's per-minute budget is already tight. 36 requests at the
 * original 12/min pacing is three minutes of light load.
 *
 *   deno run --allow-net --allow-read --allow-write local-runner/ipo-ttm-fetch.ts
 */

import { WINDOWS } from "./ipo-bos-fetch.ts";

export const CACHE = new URL("./.cache/ipo-ttm/", import.meta.url);

/** Instrument-window ends, identical to ipo-tf-baseline.ts SPECS. */
export const SPECS = [
  { inst: "EUR/USD", end: "2022-07-01", m1: "EURUSD_2022-04-01" },
  { inst: "EUR/USD", end: "2025-04-01", m1: "EURUSD_2025-01-01" },
  { inst: "EUR/USD", end: "2025-07-01", m1: "EURUSD_2025-04-01" },
  { inst: "EUR/USD", end: "2025-11-01", m1: "EURUSD_2025-08-01" },
  { inst: "BTC/USD", end: "2022-07-01", m1: "BTCUSD_2022-04-01" },
  { inst: "BTC/USD", end: "2025-04-01", m1: "BTCUSD_2025-01-01" },
  { inst: "BTC/USD", end: "2025-07-01", m1: "BTCUSD_2025-04-01" },
  { inst: "BTC/USD", end: "2025-11-01", m1: "BTCUSD_2025-08-01" },
  { inst: "USD/JPY", end: "2022-11-01", m1: "USDJPY_2022-08-01" },
  { inst: "USD/JPY", end: "2025-04-01", m1: "USDJPY_2025-01-01" },
  { inst: "USD/JPY", end: "2025-07-01", m1: "USDJPY_2025-04-01" },
  { inst: "USD/JPY", end: "2025-11-01", m1: "USDJPY_2025-08-01" },
];

interface Candle { datetime: string; open: number; high: number; low: number; close: number }

function loadKey(): string {
  for (const line of Deno.readTextFileSync(new URL("./.env.local", import.meta.url)).split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const [k, ...rest] = t.split("=");
    if (k.trim() === "TWELVE_DATA_API_KEY") return rest.join("=").trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("TWELVE_DATA_API_KEY missing");
}

/** Identical mapping to ipo-bos-fetch / ipo-m1-fetch: UTC, ISO with Z. */
const map = (v: Record<string, string>[]): Candle[] =>
  v.map((x) => ({
    datetime: `${x.datetime.replace(" ", "T")}Z`,
    open: +x.open, high: +x.high, low: +x.low, close: +x.close,
  })).filter((c) => Number.isFinite(c.open) && Number.isFinite(c.close))
    .sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchSeries(key: string, symbol: string, interval: string, end: string): Promise<Candle[]> {
  const p = new URLSearchParams({
    symbol, interval, outputsize: "5000", timezone: "UTC",
    format: "JSON", order: "DESC", end_date: `${end} 00:00:00`, apikey: key,
  });
  const body = await (await fetch(`https://api.twelvedata.com/time_series?${p}`)).json();
  if (body.status === "error") throw new Error(`provider error ${body.code ?? ""} for ${symbol} ${interval} ${end}`);
  return map((body.values ?? []) as Record<string, string>[]);
}

if (import.meta.main) {
  const key = loadKey();
  await Deno.mkdir(CACHE, { recursive: true });
  const jobs: Array<{ file: string; symbol: string; interval: string; end: string }> = [];
  for (const s of SPECS) for (const tf of ["1h", "4h"]) {
    jobs.push({ file: `${s.inst.replace("/", "")}_${s.end}_${tf}.json`, symbol: s.inst, interval: tf, end: s.end });
  }
  for (const w of WINDOWS) {
    jobs.push({ file: `bos_${w.id}_${w.tf}.json`, symbol: w.instrument, interval: w.tf, end: w.to });
  }
  let fetched = 0;
  for (const j of jobs) {
    const path = new URL(j.file, CACHE);
    try { await Deno.stat(path); console.log(`  cached  ${j.file}`); continue; } catch { /* fetch */ }
    const bars = await fetchSeries(key, j.symbol, j.interval, j.end);
    await Deno.writeTextFile(path, JSON.stringify(bars));
    fetched++;
    console.log(`  fetched ${j.file.padEnd(34)} ${String(bars.length).padStart(5)} bars  ${bars[0]?.datetime} -> ${bars[bars.length - 1]?.datetime}`);
    await sleep(5_000);   // 12/min, the original pacing
  }
  console.log(`\n${fetched} fetched, ${jobs.length - fetched} cached`);
}

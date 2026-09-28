/**
 * IPO_FAILED_RETEST_V1 — 1-minute execution data.
 *
 * §7 makes 1m ordering mandatory: the strategy timeframe cannot say whether a
 * stop or a target came first inside one bar, and the previous BOS experiment
 * was explicitly not trusted for profitability because of that.
 *
 * Measured before building: 1m is available on this plan back to at least 2022
 * for all three instruments, ~3.5 days per 5000-bar page via `end_date` paging.
 *
 * Fetches contiguous 1m coverage spanning each window's strategy-timeframe
 * span, so any trade inside that window can be resolved. Coverage gaps are
 * recorded rather than interpolated — a gap means "cannot resolve", not
 * "nothing happened".
 *
 * Usage:
 *   deno run --allow-net --allow-read --allow-write --allow-env local-runner/ipo-m1-fetch.ts
 */

import { WINDOWS } from "./ipo-bos-fetch.ts";

const CACHE = "/tmp/ipo-bos-data";
const OUT = "/tmp/ipo-m1-data";
const MAX_BARS = 1800;
const RATE = 12;

interface Candle { datetime: string; open: number; high: number; low: number; close: number }

function loadKey(): string {
  for (const line of Deno.readTextFileSync("local-runner/.env.local").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const [k, ...rest] = t.split("=");
    if (k.trim() === "TWELVE_DATA_API_KEY") return rest.join("=").trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("TWELVE_DATA_API_KEY missing");
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const map = (v: Record<string, string>[]): Candle[] =>
  v.map((x) => ({
    datetime: `${x.datetime.replace(" ", "T")}Z`,
    open: +x.open, high: +x.high, low: +x.low, close: +x.close,
  })).filter((c) => Number.isFinite(c.open) && Number.isFinite(c.close));

if (import.meta.main) {
  const key = loadKey();
  await Deno.mkdir(OUT, { recursive: true });
  const report: Record<string, unknown>[] = [];

  for (const w of WINDOWS) {
    const path = `${OUT}/${w.id}_1min.json`;
    try {
      const ex = JSON.parse(await Deno.readTextFile(path)) as Candle[];
      if (ex.length > 5000) {
        console.log(`  ${w.id.padEnd(20)} cached ${ex.length} 1m bars`);
        report.push({ window: w.id, bars: ex.length, cached: true });
        continue;
      }
    } catch { /* not cached */ }

    // The strategy-timeframe span this window actually decides over.
    const htf = (JSON.parse(await Deno.readTextFile(`${CACHE}/${w.id}_${w.tf}.json`)) as Candle[]).slice(-MAX_BARS);
    const fromMs = Date.parse(htf[0].datetime);
    const toMs = Date.parse(htf[htf.length - 1].datetime) + 4 * 3_600_000;  // tail for late exits

    const byTime = new Map<string, Candle>();
    let endDate: string | null = new Date(toMs).toISOString().replace("T", " ").slice(0, 19);
    let pages = 0;
    while (pages < 40) {
      const p = new URLSearchParams({
        symbol: w.instrument, interval: "1min", outputsize: "5000", timezone: "UTC",
        format: "JSON", order: "DESC", end_date: endDate!, apikey: key,
      });
      const body = await (await fetch(`https://api.twelvedata.com/time_series?${p}`)).json();
      if (body.status === "error") { console.error(`  ${w.id} page ${pages}: provider error ${String(body.code ?? "")}`); break; }
      const page = map((body.values ?? []) as Record<string, string>[]);
      if (!page.length) break;
      for (const c of page) byTime.set(c.datetime, c);
      pages++;
      const oldest = Date.parse(page[page.length - 1].datetime);
      if (oldest <= fromMs) break;
      const next = new Date(oldest - 60_000).toISOString().replace("T", " ").slice(0, 19);
      if (next === endDate) break;
      endDate = next;
      await sleep(Math.ceil(60_000 / RATE));
    }

    const bars = [...byTime.values()].sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));
    await Deno.writeTextFile(path, JSON.stringify(bars));
    const covered = bars.length && Date.parse(bars[0].datetime) <= fromMs;
    console.log(`  ${w.id.padEnd(20)} ${String(bars.length).padStart(7)} 1m bars, ${pages} pages, ${bars[0]?.datetime} -> ${bars[bars.length-1]?.datetime} ${covered ? "" : "  ** SHORT OF WINDOW START **"}`);
    report.push({ window: w.id, instrument: w.instrument, bars: bars.length, pages,
      first: bars[0]?.datetime ?? null, last: bars[bars.length-1]?.datetime ?? null,
      coversWindowStart: !!covered });
    await sleep(Math.ceil(60_000 / RATE));
  }
  await Deno.writeTextFile(`${OUT}/coverage.json`, JSON.stringify(report, null, 2));
  console.log(`\ncoverage -> ${OUT}/coverage.json`);
}

/**
 * IPO_BASELINE_1H_4H_CAUSAL_V2 — the 1-minute corpus, rebuilt exactly as V1 paged it.
 *
 * V1 (ipo-tf-baseline.ts) took its decision span from the 1m file written by
 * ipo-m1-fetch.ts: decision start = the OLDEST bar of the LAST backward page.
 * Those files are gone, and the start is unrecoverable unless the paging is
 * repeated exactly — so this repeats it exactly:
 *
 *   strategy series = the window's ipo-bos-fetch series, last 1,800 bars
 *   fromMs = first of those bars;  toMs = last + 4h
 *   page 1 ends at toMs; each next page ends 1 minute before the previous
 *   page's oldest bar; stop once a page reaches fromMs (max 40 pages)
 *
 * Identical requests return identical pages while the provider's history is
 * unchanged, which the V1 parity check in ipo-baseline-causal-v2.ts verifies.
 * The pages also give V2 complete 1m coverage of every decision span.
 *
 * Differences from the original, none of which can move a page boundary:
 * a provider error is retried after 65s instead of ending the window, and
 * progress is saved after every page so an interrupted run resumes mid-chain.
 *
 * The key is shared with the production scanner: 2.5 requests/min.
 *
 *   deno run --allow-net --allow-read --allow-write local-runner/ipo-v2-m1-fetch.ts
 */

import { WINDOWS } from "./ipo-bos-fetch.ts";

export const V2_M1_CACHE = new URL("./.cache/ipo-v2-m1/", import.meta.url);
const BOS_CACHE = new URL("./.cache/ipo-ttm/", import.meta.url);
const MAX_BARS = 1800;
const RATE = 2.5;

export interface Candle { datetime: string; open: number; high: number; low: number; close: number }
export interface WindowFile { id: string; fromMs: number; toMs: number; pages: Array<{ endDate: string; oldest: string; newest: string; n: number }>; complete: boolean; bars: Candle[] }

export const windowFile = (id: string) => new URL(`${id}_1min.json`, V2_M1_CACHE);
export function loadWindow(id: string): WindowFile | null {
  try { return JSON.parse(Deno.readTextFileSync(windowFile(id))) as WindowFile; } catch { return null; }
}

/** The span ipo-m1-fetch.ts aimed at for a window. */
export function windowSpan(w: { id: string; tf: string }): { fromMs: number; toMs: number } {
  const htf = (JSON.parse(Deno.readTextFileSync(new URL(`bos_${w.id}_${w.tf}.json`, BOS_CACHE))) as Candle[]).slice(-MAX_BARS);
  return { fromMs: Date.parse(htf[0].datetime), toMs: Date.parse(htf[htf.length - 1].datetime) + 4 * 3_600_000 };
}

function loadKey(): string {
  for (const line of Deno.readTextFileSync(new URL("./.env.local", import.meta.url)).split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const [k, ...rest] = t.split("=");
    if (k.trim() === "TWELVE_DATA_API_KEY") return rest.join("=").trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("TWELVE_DATA_API_KEY missing");
}
const td = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Identical mapping to ipo-m1-fetch.ts. */
const map = (v: Record<string, string>[]): Candle[] =>
  v.map((x) => ({
    datetime: `${x.datetime.replace(" ", "T")}Z`,
    open: +x.open, high: +x.high, low: +x.low, close: +x.close,
  })).filter((c) => Number.isFinite(c.open) && Number.isFinite(c.close));

if (import.meta.main) {
  const key = loadKey();
  await Deno.mkdir(V2_M1_CACHE, { recursive: true });
  let total = 0;
  for (const w of WINDOWS) {
    const { fromMs, toMs } = windowSpan(w);
    const wf: WindowFile = loadWindow(w.id) ?? { id: w.id, fromMs, toMs, pages: [], complete: false, bars: [] };
    if (wf.complete) { console.log(`${w.id}: cached, ${wf.bars.length} bars, ${wf.pages.length} pages`); continue; }
    const byTime = new Map(wf.bars.map((c) => [c.datetime, c]));
    let endDate: string | null = wf.pages.length
      ? td(Date.parse(wf.pages[wf.pages.length - 1].oldest) - 60_000)
      : td(toMs);
    while (wf.pages.length < 40) {
      let body: Record<string, unknown> = {};
      for (let attempt = 0; attempt < 5; attempt++) {
        const p = new URLSearchParams({
          symbol: w.instrument, interval: "1min", outputsize: "5000", timezone: "UTC",
          format: "JSON", order: "DESC", end_date: endDate!, apikey: key,
        });
        body = await (await fetch(`https://api.twelvedata.com/time_series?${p}`)).json();
        if (body.status !== "error") break;
        console.error(`  ${w.id} provider error ${String(body.code ?? "")}, waiting 65s`);
        await sleep(65_000);
      }
      if (body.status === "error") throw new Error(`${w.id}: provider kept refusing`);
      total++;
      const page = map((body.values ?? []) as Record<string, string>[]);
      if (!page.length) { wf.complete = true; break; }
      for (const c of page) byTime.set(c.datetime, c);
      const oldest = page[page.length - 1].datetime;
      wf.pages.push({ endDate: endDate!, oldest, newest: page[0].datetime, n: page.length });
      wf.bars = [...byTime.values()].sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));
      const next = td(Date.parse(oldest) - 60_000);
      const done = Date.parse(oldest) <= fromMs || next === endDate;
      if (done) wf.complete = true;
      await Deno.writeTextFile(windowFile(w.id), JSON.stringify(wf));
      console.log(`  ${w.id} page ${wf.pages.length}: ${oldest} -> ${page[0].datetime}`);
      await sleep(Math.ceil(60_000 / RATE));
      if (done) break;
      endDate = next;
    }
    if (!wf.complete) { wf.complete = true; await Deno.writeTextFile(windowFile(w.id), JSON.stringify(wf)); }
    console.log(`${w.id}: ${wf.bars.length} bars, ${wf.pages.length} pages, decision start ${wf.bars[0]?.datetime}`);
  }
  console.log(`done, ${total} requests`);
}

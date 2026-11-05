/**
 * TREND_PREREG_V1 — daily bars for the 9 pre-registered instruments (docs/TREND_PREREG_V1.md).
 *
 * One request per instrument: TwelveData returns up to 5,000 daily bars, which reaches back
 * past the 2014 warm-up for all nine. The key is shared with production, so requests are
 * paced at 8s (well under the scanner's per-minute budget) and cached in local-runner/.cache
 * (gitignored) so the study never fetches twice.
 *
 *   deno run --allow-net --allow-read --allow-write local-runner/trend-fetch.ts
 *
 * Needs TWELVE_DATA_API_KEY in local-runner/.env.local, the same file the IPO fetchers read.
 */

export const CACHE = new URL("./.cache/trend/", import.meta.url);
export const INSTRUMENTS = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "NZD/USD", "USD/CAD", "USD/CHF", "XAU/USD", "BTC/USD"];
export const END_DATE = "2026-11-01";
export const cacheFile = (inst: string) => new URL(`${inst.replace("/", "")}_1day.json`, CACHE);

interface Candle { t: string; o: number; h: number; l: number; c: number }

function loadKey(): string {
  for (const line of Deno.readTextFileSync(new URL("./.env.local", import.meta.url)).split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const [k, ...rest] = t.split("=");
    if (k.trim() === "TWELVE_DATA_API_KEY") return rest.join("=").trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("TWELVE_DATA_API_KEY missing from local-runner/.env.local");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchDaily(key: string, symbol: string): Promise<Candle[]> {
  const p = new URLSearchParams({
    symbol, interval: "1day", outputsize: "5000", timezone: "UTC",
    format: "JSON", order: "DESC", end_date: `${END_DATE} 00:00:00`, apikey: key,
  });
  const body = await (await fetch(`https://api.twelvedata.com/time_series?${p}`)).json();
  if (body.status === "error") throw new Error(`provider error ${body.code ?? ""} for ${symbol}: ${body.message ?? ""}`);
  return ((body.values ?? []) as Record<string, string>[])
    .map((x) => ({ t: `${x.datetime.slice(0, 10)}T00:00:00Z`, o: +x.open, h: +x.high, l: +x.low, c: +x.close }))
    .filter((c) => [c.o, c.h, c.l, c.c].every(Number.isFinite))
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

if (import.meta.main) {
  const key = loadKey();
  await Deno.mkdir(CACHE, { recursive: true });
  let fetched = 0;
  for (const inst of INSTRUMENTS) {
    const path = cacheFile(inst);
    try { await Deno.stat(path); console.log(`  cached  ${inst}`); continue; } catch { /* fetch */ }
    if (fetched > 0) await sleep(8_000);
    const bars = await fetchDaily(key, inst);
    await Deno.writeTextFile(path, JSON.stringify(bars));
    fetched++;
    console.log(`  fetched ${inst.padEnd(8)} ${String(bars.length).padStart(5)} bars  ${bars[0]?.t.slice(0, 10)} -> ${bars.at(-1)?.t.slice(0, 10)}`);
  }
  console.log(`\n${fetched} fetched, ${INSTRUMENTS.length - fetched} cached`);
}

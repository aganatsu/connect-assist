/**
 * IPO_24_TRADE_CAUSAL_AUDIT_V1 — 1-minute tape for the forward-paper period.
 *
 * The paper runner resolves intrabar ordering from TwelveData 1m but does not
 * persist the minutes it read. This fetches one contiguous 1m range per paper
 * instrument covering the audited trades (2026-09-24 -> 2026-10-03), paging
 * backward until the range start is reached. Strategy-timeframe bars are NOT
 * fetched: the audit replays the engine's own persisted bar series.
 *
 * The key is shared with the production scanner, so the pace is 2 requests/min
 * (~9 requests in total). Cached in local-runner/.cache/ipo-24-audit/ (gitignored).
 *
 *   deno run --allow-net --allow-read --allow-write local-runner/ipo-24-audit-fetch.ts
 */

export const AUDIT_CACHE = new URL("./.cache/ipo-24-audit/", import.meta.url);
export const RANGE_FROM = Date.parse("2026-09-24T00:00:00Z");
export const RANGE_TO = Date.parse("2026-10-03T11:00:00Z");
export const SYMBOLS = ["USD/JPY", "EUR/USD", "BTC/USD"] as const;
const RATE = 2;

export interface Candle { datetime: string; open: number; high: number; low: number; close: number }
export const m1File = (sym: string) => new URL(`${sym.replace("/", "")}_1min.json`, AUDIT_CACHE);

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

if (import.meta.main) {
  const key = loadKey();
  await Deno.mkdir(AUDIT_CACHE, { recursive: true });
  let total = 0;
  for (const sym of SYMBOLS) {
    const byTime = new Map<string, Candle>();
    let end = RANGE_TO;
    while (end > RANGE_FROM) {
      let body: Record<string, unknown> = {};
      for (let attempt = 0; attempt < 4; attempt++) {
        const p = new URLSearchParams({ symbol: sym, interval: "1min", outputsize: "5000", timezone: "UTC",
          format: "JSON", order: "DESC", end_date: td(end), apikey: key });
        body = await (await fetch(`https://api.twelvedata.com/time_series?${p}`)).json();
        if (body.status !== "error") break;
        console.error(`  ${sym} provider error ${String(body.code ?? "")}, waiting 65s`);
        await sleep(65_000);
      }
      if (body.status === "error") throw new Error(`${sym}: provider kept refusing`);
      total++;
      const page = ((body.values ?? []) as Record<string, string>[]).map((x) => ({
        datetime: `${x.datetime.replace(" ", "T")}Z`, open: +x.open, high: +x.high, low: +x.low, close: +x.close,
      })).filter((c) => Number.isFinite(c.open) && Number.isFinite(c.close));
      if (!page.length) break;
      for (const c of page) byTime.set(c.datetime, c);
      const oldest = Date.parse(page[page.length - 1].datetime);
      console.log(`  ${sym}: ${page[page.length - 1].datetime} -> ${page[0].datetime}`);
      end = oldest - 60_000;
      await sleep(Math.ceil(60_000 / RATE));
    }
    const bars = [...byTime.values()].sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));
    await Deno.writeTextFile(m1File(sym), JSON.stringify(bars));
    console.log(`${sym}: ${bars.length} bars ${bars[0]?.datetime} -> ${bars.at(-1)?.datetime}`);
  }
  console.log(`done, ${total} requests`);
}

/**
 * STAGE 3 — historical candle acquisition for the causal profitability baseline.
 *
 * READ-ONLY against production. Writes nothing to the database and touches no
 * strategy code. Its only side effect is a local cache under /tmp/stage3-data.
 *
 * WHY IT PAGES BACKWARDS. Twelve Data on this plan ignores `start_date` — a
 * request for 2024 returns the most recent 5000 bars regardless. `end_date`
 * does work, so history is walked backwards one 5000-bar page at a time, each
 * page ending where the previous one began. Measured, not assumed: a 5min
 * request with end_date=2026-06-01 returned 2026-05-14 → 2026-06-01.
 *
 * WHY IT IS THROTTLED. The plan allows 55 credits/minute and the LIVE paper
 * scanner shares it, spending ~31 per five-minute cycle. Bursting would make
 * the scanner's fetches get refused, which silently costs real (paper) trades —
 * the exact failure mode recorded as "scanner starved by API credit budget".
 * The default rate leaves the scanner more headroom than it currently uses.
 *
 * The API key is read from local-runner/.env.local, which is gitignored. It is
 * never logged, never echoed, never written to the cache.
 *
 * Usage:
 *   deno run --allow-net --allow-read --allow-write --allow-env \
 *     local-runner/stage3-fetch.ts --days 90 [--symbols EUR/USD,GBP/USD] [--rate 15]
 */

const CACHE_DIR = "/tmp/stage3-data";

/** Canonical → Twelve Data interval. Mirrors `twelveDataInterval` in production. */
const TD: Record<string, string> = {
  "5m": "5min", "15m": "15min", "1h": "1h", "4h": "4h", "1d": "1day", "1w": "1week",
};
const BAR_MS: Record<string, number> = {
  "5m": 300_000, "15m": 900_000, "1h": 3_600_000,
  "4h": 14_400_000, "1d": 86_400_000, "1w": 604_800_000,
};

/**
 * Production DEPTH per interval, from bot-scanner's CANDLE_LIMITS. The replay
 * must hand the engine the same number of bars production would have, so each
 * series needs this much warm-up BEFORE the first decision point.
 */
const DEPTH: Record<string, number> = {
  "5m": 300, "15m": 300, "1h": 300, "4h": 800, "1d": 300, "1w": 300,
};

export interface Candle {
  datetime: string;
  open: number; high: number; low: number; close: number;
  volume?: number;
}

function loadKey(): string {
  const txt = Deno.readTextFileSync("local-runner/.env.local");
  for (const line of txt.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const [k, ...rest] = t.split("=");
    if (k.trim() === "TWELVE_DATA_API_KEY") {
      return rest.join("=").trim().replace(/^["']|["']$/g, "");
    }
  }
  throw new Error("TWELVE_DATA_API_KEY missing from local-runner/.env.local");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Same mapping production applies to a Twelve Data row — including appending
 * "Z", which is only correct because the request asks for timezone=UTC. The two
 * belong together; the replay must produce byte-identical datetime strings or
 * it is not replaying the same input.
 */
function mapValues(values: Record<string, string>[]): Candle[] {
  return values.map((v) => ({
    datetime: v.datetime.length === 10
      ? `${v.datetime}T00:00:00Z`
      : `${v.datetime.replace(" ", "T")}Z`,
    open: Number(v.open), high: Number(v.high), low: Number(v.low), close: Number(v.close),
    volume: v.volume != null ? Number(v.volume) : undefined,
  })).filter((c) =>
    Number.isFinite(c.open) && Number.isFinite(c.high) &&
    Number.isFinite(c.low) && Number.isFinite(c.close)
  );
}

export async function fetchSeries(
  key: string, symbol: string, canon: string, fromMs: number, rate: number,
): Promise<Candle[]> {
  const interval = TD[canon];
  const byTime = new Map<string, Candle>();
  let endDate: string | null = null;
  let pages = 0;
  const gapMs = Math.ceil(60_000 / rate);

  while (true) {
    const p = new URLSearchParams({
      symbol, interval, outputsize: "5000", timezone: "UTC",
      format: "JSON", order: "DESC", apikey: key,
    });
    if (endDate) p.set("end_date", endDate);

    const res = await fetch(`https://api.twelvedata.com/time_series?${p}`);
    const body = await res.json();
    if (body.status === "error") {
      // The message can echo the request; never print it verbatim in case a
      // future provider change starts including the key.
      throw new Error(`provider error for ${symbol} ${interval}: ${String(body.code ?? "")}`);
    }
    const vals = (body.values ?? []) as Record<string, string>[];
    if (!vals.length) break;

    const page = mapValues(vals);
    for (const c of page) byTime.set(c.datetime, c);
    pages++;

    // DESC order: last element is the oldest in this page.
    const oldest = page[page.length - 1];
    const oldestMs = Date.parse(oldest.datetime);
    if (oldestMs <= fromMs) break;
    if (page.length < 4500) break;   // provider ran out of history

    // Next page ends one bar before this page's oldest, so pages abut without
    // overlapping into an infinite loop on a repeated boundary bar.
    const nextEnd = new Date(oldestMs - BAR_MS[canon]);
    const iso = nextEnd.toISOString().replace("T", " ").slice(0, 19);
    if (iso === endDate) break;
    endDate = iso;
    await sleep(gapMs);
  }

  const out = [...byTime.values()].sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));
  console.log(`    ${canon.padEnd(4)} ${String(out.length).padStart(7)} bars  ${pages} page(s)  ${out[0]?.datetime ?? "-"} → ${out[out.length-1]?.datetime ?? "-"}`);
  return out;
}

if (import.meta.main) {
  const a = Deno.args;
  const arg = (n: string, d: string) => { const i = a.indexOf(n); return i >= 0 ? a[i+1] : d; };
  const days = Number(arg("--days", "90"));
  const rate = Number(arg("--rate", "15"));
  const symbols = arg("--symbols",
    "EUR/USD,GBP/USD,USD/JPY,USD/CAD,USD/CHF,AUD/USD,NZD/USD").split(",");

  const key = loadKey();
  await Deno.mkdir(CACHE_DIR, { recursive: true });

  const nowMs = Date.now();
  const decisionStart = nowMs - days * 86_400_000;
  console.log(`Stage 3 fetch — ${days}d decision window, ${symbols.length} symbols, <=${rate} req/min`);
  console.log(`decision period starts ${new Date(decisionStart).toISOString()}\n`);

  const coverage: Record<string, Record<string, unknown>> = {};
  for (const sym of symbols) {
    console.log(`  ${sym}`);
    coverage[sym] = {};
    for (const canon of Object.keys(TD)) {
      // Warm-up: DEPTH bars before the first decision, so the engine sees a
      // full-length array at t0 exactly as production would.
      const fromMs = decisionStart - DEPTH[canon] * BAR_MS[canon];
      const series = await fetchSeries(key, sym, canon, fromMs, rate);
      const path = `${CACHE_DIR}/${sym.replace("/", "")}_${canon}.json`;
      await Deno.writeTextFile(path, JSON.stringify(series));
      coverage[sym][canon] = {
        bars: series.length,
        first: series[0]?.datetime ?? null,
        last: series[series.length - 1]?.datetime ?? null,
        warmupSatisfied: series.length > 0 && Date.parse(series[0].datetime) <= fromMs,
      };
      await sleep(Math.ceil(60_000 / rate));
    }
  }
  await Deno.writeTextFile(`${CACHE_DIR}/coverage.json`,
    JSON.stringify({ days, decisionStart: new Date(decisionStart).toISOString(), coverage }, null, 2));
  console.log(`\ncoverage written to ${CACHE_DIR}/coverage.json`);
}

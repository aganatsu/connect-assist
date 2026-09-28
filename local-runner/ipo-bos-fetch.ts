/**
 * IPO_BOS_REQUIRED_V1 — corpus fetch.
 *
 * READ-ONLY against production. Caches to /tmp/ipo-bos-data.
 *
 * WINDOWS. The frozen spec §11 says the causal baseline replayed "15 untouched
 * validation windows" but does not enumerate them anywhere in the repo. The
 * only enumerated list is the freeze doc §15 (2026-09-21 volatility
 * validation), which is what is used here:
 *
 *   BTC/USD 1H, EUR/USD 1H : 2022-04..06, 2025-01..03, 2025-04..06, 2025-08..10
 *   USD/JPY 30M            : 2022-08..10, 2025-01..03, 2025-04..06, 2025-08..10
 *
 * That is 12 windows, and ~12 calendar months per instrument against the ~10
 * months the baseline's trades/month implies — close, but NOT proven to be the
 * same corpus. The experiment does not depend on it being the same: CONTROL and
 * EXPERIMENT run on identical bars, which is what makes the comparison valid.
 * The published baseline is used only as a corroboration reference.
 *
 * Each window fits in one 5000-bar page via `end_date` paging, measured: a 1H
 * request ending 2022-07-01 reaches back to 2021-09, and a 30M request ending
 * 2022-11-01 reaches 2022-06.
 *
 * WARM-UP. The engine needs history before the first decision bar —
 * LiveVolatility cannot resolve a bucket below MIN_HISTORY_BARS (250), and the
 * contraction stack reads back further. Each window therefore fetches a full
 * page ending at the window end and the decision range is marked separately, so
 * bars before `from` are warm-up only and produce no trades.
 */

const CACHE = "/tmp/ipo-bos-data";

export interface Window { id: string; instrument: string; tf: string; from: string; to: string }

/** Freeze doc §15. Three months each, none reused from earlier IPO work. */
export const WINDOWS: Window[] = [
  ...["2022-04-01/2022-07-01", "2025-01-01/2025-04-01", "2025-04-01/2025-07-01", "2025-08-01/2025-11-01"]
    .flatMap((r) => {
      const [from, to] = r.split("/");
      return [
        { id: `EURUSD_${from}`, instrument: "EUR/USD", tf: "1h", from, to },
        { id: `BTCUSD_${from}`, instrument: "BTC/USD", tf: "1h", from, to },
      ];
    }),
  ...["2022-08-01/2022-11-01", "2025-01-01/2025-04-01", "2025-04-01/2025-07-01", "2025-08-01/2025-11-01"]
    .map((r) => {
      const [from, to] = r.split("/");
      return { id: `USDJPY_${from}`, instrument: "USD/JPY", tf: "30min", from, to };
    }),
];

export interface Candle {
  datetime: string; open: number; high: number; low: number; close: number; volume?: number;
}

function loadKey(): string {
  for (const line of Deno.readTextFileSync("local-runner/.env.local").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const [k, ...rest] = t.split("=");
    if (k.trim() === "TWELVE_DATA_API_KEY") return rest.join("=").trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("TWELVE_DATA_API_KEY missing from local-runner/.env.local");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Same mapping production applies — append Z, valid only because timezone=UTC. */
function mapValues(vals: Record<string, string>[]): Candle[] {
  return vals.map((v) => ({
    datetime: v.datetime.length === 10 ? `${v.datetime}T00:00:00Z` : `${v.datetime.replace(" ", "T")}Z`,
    open: Number(v.open), high: Number(v.high), low: Number(v.low), close: Number(v.close),
    volume: v.volume != null ? Number(v.volume) : undefined,
  })).filter((c) =>
    Number.isFinite(c.open) && Number.isFinite(c.high) &&
    Number.isFinite(c.low) && Number.isFinite(c.close)
  );
}

if (import.meta.main) {
  const key = loadKey();
  await Deno.mkdir(CACHE, { recursive: true });
  const rate = 12;
  const report: Record<string, unknown>[] = [];

  for (const w of WINDOWS) {
    const path = `${CACHE}/${w.id}_${w.tf}.json`;
    try {
      const existing = JSON.parse(await Deno.readTextFile(path)) as Candle[];
      if (existing.length > 1000) {
        console.log(`  ${w.id.padEnd(20)} cached ${existing.length} bars`);
        report.push({ ...w, bars: existing.length, cached: true });
        continue;
      }
    } catch { /* not cached */ }

    const p = new URLSearchParams({
      symbol: w.instrument, interval: w.tf, outputsize: "5000", timezone: "UTC",
      format: "JSON", order: "DESC", end_date: `${w.to} 00:00:00`, apikey: key,
    });
    const body = await (await fetch(`https://api.twelvedata.com/time_series?${p}`)).json();
    if (body.status === "error") throw new Error(`${w.id}: provider error ${String(body.code ?? "")}`);
    const all = mapValues((body.values ?? []) as Record<string, string>[])
      .sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));

    const fromMs = Date.parse(`${w.from}T00:00:00Z`);
    const inWindow = all.filter((c) => Date.parse(c.datetime) >= fromMs);
    const warmup = all.length - inWindow.length;
    await Deno.writeTextFile(path, JSON.stringify(all));
    console.log(
      `  ${w.id.padEnd(20)} ${String(all.length).padStart(5)} bars ` +
      `(${warmup} warm-up + ${inWindow.length} decision)  ${all[0]?.datetime} -> ${all[all.length-1]?.datetime}`,
    );
    report.push({ ...w, bars: all.length, warmup, decision: inWindow.length, cached: false });
    await sleep(Math.ceil(60_000 / rate));
  }
  await Deno.writeTextFile(`${CACHE}/manifest.json`, JSON.stringify(report, null, 2));
  console.log(`\nmanifest -> ${CACHE}/manifest.json`);
}

// Phase 3 dataset download (spec §12.1a, P3a) — DRY RUN by default; `--execute` performs the TwelveData requests.
// Batch requests (one provider call per timeframe/range, all six pairs, one credit per symbol), UTC, closed bars only.
// Output (immutable, read-only files): <out>/raw/*.json (provider responses), <out>/dataset.json (engine input), <out>/manifest.json
// (provider, request parameters without the key, retrieval timestamps, per-series and dataset sha256).
//   deno run --allow-read --allow-write --allow-net scripts/v2/phase3_download.ts --out ~/strategy-v2/datasets/phase3 [--execute]
import { isExpected, tradingDayStart } from "../../supabase/functions/_shared/v2/calendar.ts";
import { PAIRS, STEP_MS, type TF } from "../../supabase/functions/_shared/v2/spec.ts";

const args = Deno.args;
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const EXECUTE = args.includes("--execute");
const OUT = arg("--out") ?? `${Deno.env.get("HOME")}/strategy-v2/datasets/phase3`;

// §0.12 / §12.1a: M = start of the window's first NY trading day; window end = end of the last complete NY trading week before retrieval.
// V2.0.2 used --window-start 2026-09-28 --end 2026-10-09T21:00:00Z. V2.1 out-of-sample: --window-start 2026-10-12, end ≥ 2026-10-23T21:00:00Z.
const M = tradingDayStart(arg("--window-start") ?? "2026-10-12");
const END = Date.parse(arg("--end") ?? "2026-10-23T21:00:00Z");          // Fri 2026-10-23 17:00 NY (10 eligible days)
if (EXECUTE && Date.now() < END) throw new Error(`window end ${new Date(END).toISOString()} has not passed yet — the week is not complete`);
// warm-up: 320 expected 1H bars before M (200-bar window at the qualification of a leg up to 120 bars old), rounded down to a trading-day start
let w = M, n = 0;
while (n < 320) { w -= 3_600_000; if (isExpected(w)) n++; }
const dayOf = (ms: number) => { const d = new Date(ms - 4 * 3_600_000); return d.toISOString().slice(0, 10); };
const START = tradingDayStart(dayOf(w + 7 * 3_600_000));

const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const count = (tf: TF, a: number, b: number) => { let c = 0; for (let x = a; x < b; x += STEP_MS[tf]) if (isExpected(x)) c++; return c; };
const INTERVAL: Record<TF, string> = { "5m": "5min", "15m": "15min", "1h": "1h" };
// ranges per timeframe, each ≤ 5,000 expected bars per symbol (TwelveData outputsize limit)
// TwelveData also returns bars stamped in closed time (weekends) and, past 5,000 rows, silently keeps only the latest 5,000 —
// so every range stays ≤ 3,000 expected bars (headroom for weekend rows) and a full 5,000-row answer aborts the download.
const plan: { tf: TF; from: number; to: number }[] = [{ tf: "1h", from: START, to: END }, { tf: "15m", from: START, to: END }];
for (let a = START; a < END;) {                                    // 5m in chunks of ≤ 2,880 expected bars (two trading weeks), split at M
  let b = a, n5 = 0;
  while (b < END && n5 < 2880 && !(b === M && a !== M)) { if (isExpected(b)) n5++; b += STEP_MS["5m"]; }
  plan.push({ tf: "5m", from: a, to: b });
  a = b;
}
for (const r of plan) if (count(r.tf, r.from, r.to) > 3000) throw new Error(`${r.tf} range exceeds 3,000 expected bars`);

console.log(`Phase 3 download plan — dataset [${new Date(START).toISOString()}, ${new Date(END).toISOString()}), M = ${new Date(M).toISOString()}`);
for (const r of plan) console.log(`  ${r.tf.padEnd(3)} ${fmt(r.from)} → ${fmt(r.to)} UTC  ${count(r.tf, r.from, r.to)} expected bars/symbol × 6 symbols = 6 credits`);
console.log(`  total ${plan.length} provider calls, ${plan.length * 6} credits, ≥ 65 s apart`);
if (!EXECUTE) { console.log("dry run — nothing fetched (add --execute)"); Deno.exit(0); }

// ── execute
const envPath = `${Deno.env.get("HOME")}/Projects/connect-assist/local-runner/.env.local`;
const env = Object.fromEntries((await Deno.readTextFile(envPath)).split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
  .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
const KEY = env.TWELVE_DATA_API_KEY;
if (!KEY) throw new Error("TWELVE_DATA_API_KEY not found");
try { await Deno.stat(OUT); throw new Error(`${OUT} exists — a new download is a new dataset; choose a new --out`); } catch (e) { if (!(e instanceof Deno.errors.NotFound)) throw e; }
await Deno.mkdir(`${OUT}/raw`, { recursive: true });

const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const dataset = { start: START, end: END, bars: Object.fromEntries(PAIRS.map((p) => [p, { "5m": [], "15m": [], "1h": [] }])) } as {
  start: number; end: number; bars: Record<string, Record<TF, { t: number; o: number; h: number; l: number; c: number }[]>>;
};
const manifest: Record<string, unknown> = { provider: "TwelveData", spec: arg("--spec") ?? "STRATEGY_SPEC_V2.1_FROZEN.md", label: "PHASE3_FINAL_PROVIDER_BARS", start: START, end: END, measuredStart: M, calls: [] as unknown[] };
for (const [i, r] of plan.entries()) {
  if (i > 0) await new Promise((res) => setTimeout(res, 65_000));
  const params = { symbol: PAIRS.join(","), interval: INTERVAL[r.tf], start_date: fmt(r.from), end_date: fmt(r.to - STEP_MS[r.tf]), timezone: "UTC", order: "ASC", outputsize: "5000" };
  const url = `https://api.twelvedata.com/time_series?${new URLSearchParams({ ...params, apikey: KEY })}`;
  const retrievedAt = new Date().toISOString();
  const res = await fetch(url);
  const text = await res.text();
  const body = JSON.parse(text);
  const file = `raw/${String(i + 1).padStart(2, "0")}-${r.tf}-${fmt(r.from).slice(0, 10)}.json`;
  await Deno.writeTextFile(`${OUT}/${file}`, text);
  const perSeries: Record<string, unknown> = {};
  for (const p of PAIRS) {
    const s = body[p];
    if (!s || s.status !== "ok" || !Array.isArray(s.values)) throw new Error(`${r.tf} ${p}: provider status ${s?.status ?? res.status} ${s?.message ?? ""} — batch unusable, dataset aborted`);
    if (s.values.length >= 5000) throw new Error(`${r.tf} ${p}: 5,000 rows returned — possible truncation, dataset aborted`);
    const bars = s.values.map((v: Record<string, string>) => ({ t: Date.parse(v.datetime.replace(" ", "T") + "Z"), o: +v.open, h: +v.high, l: +v.low, c: +v.close }))
      .filter((b: { t: number }) => b.t >= r.from && b.t < r.to);
    dataset.bars[p][r.tf].push(...bars);
    perSeries[p] = { rows: s.values.length, kept: bars.length, sha256: await sha(JSON.stringify(s.values)) };
  }
  (manifest.calls as unknown[]).push({ file, params, retrievedAt, httpStatus: res.status, sha256: await sha(text), perSeries });
  console.log(`call ${i + 1}/${plan.length} ${r.tf} ok`);
}
const dsText = JSON.stringify(dataset);
manifest.datasetSha256 = await sha(dsText);
await Deno.writeTextFile(`${OUT}/dataset.json`, dsText);
await Deno.writeTextFile(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 1));
for await (const e of Deno.readDir(`${OUT}/raw`)) await Deno.chmod(`${OUT}/raw/${e.name}`, 0o444);
await Deno.chmod(`${OUT}/dataset.json`, 0o444); await Deno.chmod(`${OUT}/manifest.json`, 0o444);
console.log(`dataset sha256 ${manifest.datasetSha256}`);

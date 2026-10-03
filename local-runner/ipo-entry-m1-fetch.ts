/**
 * IPO_ENTRY_QUALITY_TELEMETRY_V1 — 1-minute corpus, rebuilt around the trades.
 *
 * The frozen baseline's 1m files lived in /tmp/ipo-m1-data and are gone. The
 * entry-quality study needs 1m bars only where the trades are: from four
 * hours before each touch bar (pre-entry context) to two hours after each
 * exit (post-entry excursion). Zone visits BEFORE the touch bar are counted
 * on the cached strategy-timeframe bars, so the months between an IPO candle
 * and its touch are not fetched.
 *
 * Each needed span is checked against the cache and a coverage manifest
 * (`firstProblem`); only a missing tail, a missing head or an UNPROVEN gap
 * triggers a page, which then records the range it covered. A weekday gap
 * inside a manifest range is the provider having no bars, not a fetch hole.
 * The 2026-10-02 build took 214 requests (incl. the coverage pass).
 *
 * WHY SO SLOW. The TwelveData key is shared with the production scanner, whose
 * per-minute credit budget is already tight. The build drew three 429s at
 * 5 and 3 requests/min alongside the scanner; the coverage pass ran at 2/min.
 * The cache and manifest are written after every page, so a run resumes.
 *
 *   deno run --allow-net --allow-read --allow-write --allow-env local-runner/ipo-entry-m1-fetch.ts [--plan]
 *   IPO_M1_RATE=2 ... to pace below the default 3/min
 */

export const M1_CACHE = new URL("./.cache/ipo-m1/", import.meta.url);
export const EXPORT = new URL("../docs/exports/ipo_1h_4h_combined_clean.csv", import.meta.url);
const DEFAULT_RATE = 3;   // requests per minute; IPO_M1_RATE overrides (the coverage pass ran at 2)
const PRE_MS = 4 * 3_600_000;
const POST_MS = 2 * 3_600_000;

export interface Candle { datetime: string; open: number; high: number; low: number; close: number }

export function readCsv(url: URL): Record<string, string>[] {
  const lines = Deno.readTextFileSync(url).trim().split("\n");
  const h = lines[0].split(",");
  return lines.slice(1).map((l) => Object.fromEntries(l.split(",").map((v, i) => [h[i], v])));
}

const TF_MS: Record<string, number> = { "1h": 3_600_000, "4h": 14_400_000 };

/**
 * The instant a frozen trade ends. TARGET: the target minute. S2: the CLOSE of
 * the S2 bar — the export's exit_time for S2 rows is that bar's OPEN.
 */
export function exitInstant(r: Record<string, string>): number {
  return r.exit_reason === "TARGET"
    ? Date.parse(r.m1_target_time)
    : Date.parse(r.s2_invalidation_time) + TF_MS[r.ipo_timeframe];
}

/** Per instrument, the merged [from, to] ms spans the study reads. */
export function neededSpans(rows: Record<string, string>[]): Map<string, [number, number][]> {
  const by = new Map<string, [number, number][]>();
  for (const r of rows) {
    const s: [number, number] = [Date.parse(r.touch_time) - PRE_MS, exitInstant(r) + POST_MS];
    by.set(r.instrument, [...(by.get(r.instrument) ?? []), s]);
  }
  for (const [k, sp] of by) by.set(k, mergeSpans(sp));
  return by;
}
function mergeSpans(sp: [number, number][]): [number, number][] {
  const u: [number, number][] = [];
  for (const s of [...sp].sort((a, b) => a[0] - b[0])) {
    const l = u[u.length - 1];
    if (l && s[0] <= l[1] + 60_000) l[1] = Math.max(l[1], s[1]); else u.push([s[0], s[1]]);
  }
  return u;
}

export const cacheFile = (inst: string) => new URL(`${inst.replace("/", "")}_1min.json`, M1_CACHE);
/** Ranges a fetched page is known to cover completely: [oldest bar, requested end]. */
export const manifestFile = (inst: string) => new URL(`${inst.replace("/", "")}_coverage.json`, M1_CACHE);

export function loadM1(inst: string): Candle[] {
  try { return JSON.parse(Deno.readTextFileSync(cacheFile(inst))) as Candle[]; } catch { return []; }
}
export function loadManifest(inst: string): [number, number][] {
  try { return JSON.parse(Deno.readTextFileSync(manifestFile(inst))) as [number, number][]; } catch { return []; }
}

// 1m OHLC repair and sanity, fixed before any feature was computed.
//
// REPAIR. The provider's EUR/USD 1m feed for Dec 2024 - Mar 2025 has ~1,150
// bars whose open or close lies outside the bar's own high-low (precision
// loss: 1.0497 -> "1.05", even "1.1"). High and low are consistent in every
// such bar, so open/close are clamped into [low, high]; any residual error is
// then bounded by the bar's own range.
//
// GLITCH. An isolated spike — a high (low) more than 20x the typical range
// beyond the bar's own body and both neighbours' closes/opens, with neither
// neighbour reaching within 10x of it — is a data error (the 2023 BTC feed had
// lows of ~2.58 at ~26,000, ~900x). A glitch inside any window a trade reads
// fails the gate. "Typical" is the larger of the instrument's median 1m range
// and the median of the surrounding +/-30 bars: scaled by the global median
// alone, the first run flagged 10 REAL events (BTC 2025-01-20 and the
// 2025-10-10 crash, the USD/JPY 2025-02-07 payrolls minute), all 0.9-12x
// their local range.
export const SPIKE_X = 20, SPIKE_NEIGHBOUR_X = 10;

export function sanitizeM1(raw: Candle[]): { bars: Candle[]; clamped: Uint8Array; glitch: Uint8Array } {
  const clamped = new Uint8Array(raw.length);
  const bars = raw.map((b, i) => {
    const lo = Math.min(b.low, b.high), hi = Math.max(b.low, b.high);
    const o = Math.min(hi, Math.max(lo, b.open)), c = Math.min(hi, Math.max(lo, b.close));
    if (o !== b.open || c !== b.close || lo !== b.low) clamped[i] = 1;
    return { datetime: b.datetime, open: o, high: hi, low: lo, close: c };
  });
  const rs = bars.map((b) => b.high - b.low).filter((x) => x > 0).sort((a, b) => a - b);
  const med = rs[Math.floor(rs.length / 2)] ?? 0;
  const glitch = new Uint8Array(bars.length);
  const spike = (i: number, base: number) => {
    const b = bars[i], p = bars[i - 1] ?? b, n = bars[i + 1] ?? b;
    const up = b.high - Math.max(b.open, b.close, p.close, n.open) > SPIKE_X * base && b.high - Math.max(p.high, n.high) > SPIKE_NEIGHBOUR_X * base;
    const dn = Math.min(b.open, b.close, p.close, n.open) - b.low > SPIKE_X * base && Math.min(p.low, n.low) - b.low > SPIKE_NEIGHBOUR_X * base;
    return up || dn;
  };
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].low <= 0) { glitch[i] = 1; continue; }
    if (!spike(i, med)) continue;                       // base >= med, so this is a necessary condition
    const local = bars.slice(Math.max(0, i - 30), i + 31).map((x) => x.high - x.low).sort((a, b) => a - b);
    if (spike(i, Math.max(med, local[Math.floor(local.length / 2)]))) glitch[i] = 1;
  }
  return { bars, clamped, glitch };
}

// ── coverage: a missing stretch is either market closure or a hole ─────────
export const MAX_SILENT_GAP_MS = 60 * 60_000;

/** FX weekend closure: last bar Friday from 20:00 UTC, next bar Sunday from 19:00 or Monday before 01:00. */
function fxWeekend(prev: number, next: number): boolean {
  const p = new Date(prev), n = new Date(next);
  const pOk = p.getUTCDay() === 5 && p.getUTCHours() >= 20;
  const nOk = (n.getUTCDay() === 0 && n.getUTCHours() >= 19) || (n.getUTCDay() === 1 && n.getUTCHours() < 1);
  return pOk && nOk && next - prev < 60 * 3_600_000;
}
const inManifest = (man: [number, number][], a: number, b: number) => man.some(([x, y]) => x <= a && b <= y);

/**
 * A gap between consecutive bars is acceptable when it is short, an FX
 * weekend, or inside a range a fetched page covered (so the provider simply
 * has no bars there). Anything else may be a fetch hole.
 */
export function gapOk(prev: number, next: number, fx: boolean, man: [number, number][]): boolean {
  return next - prev <= MAX_SILENT_GAP_MS || (fx && fxWeekend(prev, next)) || inManifest(man, prev, next);
}

/**
 * The first problem in [a, b], newest first, as the end_date that would fix it:
 * a missing tail, an unverified gap, or a missing head. null when complete.
 */
export function firstProblem(t: number[], a: number, b: number, fx: boolean, man: [number, number][]): number | null {
  const lowerBound = (x: number) => { let lo = 0, hi = t.length; while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m; } return lo; };
  const bEnd = Math.min(b, Date.now());
  const j = lowerBound(bEnd + 1) - 1;                     // last bar <= b
  if (j < 0) return bEnd;
  // Tail: fine if the next bar follows acceptably, or a page covered up to b.
  const tailOk = (j + 1 < t.length && gapOk(t[j], t[j + 1], fx, man)) || gapOk(t[j], bEnd, fx, man);
  if (!tailOk) return bEnd;
  // Asking up to the bar AFTER a gap makes the page's range contain the gap.
  let i = j;
  for (; i > 0 && t[i] > a; i--) if (!gapOk(t[i - 1], t[i], fx, man)) return t[i];
  if (t[i] > a) return t[i];                              // nothing at or before a
  return null;
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

/** Identical mapping to ipo-m1-fetch.ts: UTC, ISO with Z. */
const map = (v: Record<string, string>[]): Candle[] =>
  v.map((x) => ({
    datetime: `${x.datetime.replace(" ", "T")}Z`,
    open: +x.open, high: +x.high, low: +x.low, close: +x.close,
  })).filter((c) => Number.isFinite(c.open) && Number.isFinite(c.close));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const td = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

if (import.meta.main) {
  const planOnly = Deno.args.includes("--plan");
  const RATE = Number(Deno.env.get("IPO_M1_RATE") ?? DEFAULT_RATE);
  const key = planOnly ? "" : loadKey();
  await Deno.mkdir(M1_CACHE, { recursive: true });
  const spans = neededSpans(readCsv(EXPORT));
  let total = 0;

  for (const [inst, segs] of spans) {
    const fx = inst !== "BTC/USD";
    const byTime = new Map(loadM1(inst).map((c) => [c.datetime, c]));
    let man = loadManifest(inst);
    const sorted = () => [...byTime.values()].sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));
    let bars = sorted(), t = bars.map((c) => Date.parse(c.datetime));
    let pages = 0, problems = 0;
    for (const [a, b] of [...segs].sort((x, y) => y[1] - x[1])) {
      let lastEnd: number | null = null;
      for (let guard = 0; guard < 60; guard++) {
        const end = firstProblem(t, a, b, fx, man);
        if (end === null) break;
        problems++;
        if (planOnly) break;
        // A fetch that did not resolve its problem would repeat forever: stop and report.
        if (end === lastEnd) { console.error(`  ${inst} unresolved at ${td(end)} — leaving it to the gate`); break; }
        lastEnd = end;
        let body: Record<string, unknown> = {};
        for (let attempt = 0; attempt < 4; attempt++) {
          const p = new URLSearchParams({
            symbol: inst, interval: "1min", outputsize: "5000", timezone: "UTC",
            format: "JSON", order: "DESC", end_date: td(end), apikey: key,
          });
          body = await (await fetch(`https://api.twelvedata.com/time_series?${p}`)).json();
          if (body.status !== "error") break;
          console.error(`  ${inst} provider error ${String(body.code ?? "")}, waiting 65s`);
          await sleep(65_000);
        }
        if (body.status === "error") throw new Error(`${inst}: provider kept refusing at ${td(end)}`);
        const page = map((body.values ?? []) as Record<string, string>[]);
        pages++; total++;
        // An empty page still proves the provider has nothing up to `end` from where we asked.
        const oldest = page.length ? Date.parse(page[page.length - 1].datetime) : end;
        man = mergeSpans([...man, [oldest, end]]);
        for (const c of page) byTime.set(c.datetime, c);
        bars = sorted(); t = bars.map((c) => Date.parse(c.datetime));
        await Deno.writeTextFile(cacheFile(inst), JSON.stringify(bars));
        await Deno.writeTextFile(manifestFile(inst), JSON.stringify(man));
        console.log(`  ${inst} page ${pages}: ${page.at(-1)?.datetime ?? "(empty)"} -> ${page[0]?.datetime ?? ""} (asked to ${td(end)})`);
        await sleep(Math.ceil(60_000 / RATE));
      }
    }
    console.log(`${inst}: ${bars.length} bars, ${planOnly ? `${problems} segments need a fetch` : `${pages} pages this run`}`);
  }
  console.log(`done, ${total} requests`);
}

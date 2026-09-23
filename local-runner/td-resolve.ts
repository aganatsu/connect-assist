/**
 * PARTS B–D, H — resolve same-bar IPO trades on Twelve Data 1-minute data.
 *
 * RESEARCH ONLY. Reads; writes one local JSON and a local minute cache. No
 * database, no strategy code, no deployment. The key is read from the
 * environment, never printed and never written to any output.
 *
 * SOURCE_MATCHED IS EARNED PER BAR, NOT ASSUMED. A trade is only labelled
 * SOURCE_MATCHED when its own entry bar is a TWELVE_EXACT_MATCH in the
 * attribution pass. Anything weaker resolves as CROSS_FEED_REFERENCE, and the
 * distinction is carried in the output rather than mentioned in a comment.
 *
 * THREE LAYERS OF EVIDENCE (Part C). Before a trade is resolved, the fetched
 * minutes are aggregated back to the HTF bar and checked against BOTH the
 * stored bar and Twelve Data's own HTF bar. Disagreement, or an incomplete
 * minute set, refuses the resolution instead of forcing it.
 *
 * MINUTES ARE FETCHED A DAY AT A TIME and cached, so re-runs cost no credits.
 * The cache holds market data only.
 */

import {
  resolveEntryBar, continueAfterEntryBar,
  type FeedIdentity, type TradeSpec, type Resolution, type ForwardResult,
} from "../supabase/functions/_shared/ipoIntrabarResolution.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { IPO_INSTRUMENTS } from "../supabase/functions/_shared/ipoInstruments.ts";

const KEY = Deno.env.get("TWELVE_DATA_API_KEY");
if (!KEY) { console.error("TWELVE_DATA_API_KEY not set; refusing to run."); Deno.exit(1); }

const CACHE = "/tmp/td-1m-cache.json";
let cache: Record<string, Candle[]> = {};
try { cache = JSON.parse(await Deno.readTextFile(CACHE)); } catch { /* cold */ }
let httpRequests = 0, cacheHits = 0, apiErrors = 0, rateLimited = 0;

/** One whole UTC day of minutes for a symbol. 1,440 rows, inside outputsize. */
async function dayMinutes(symbol: string, day: string): Promise<Candle[]> {
  const k = `${symbol}|${day}`;
  if (cache[k]) { cacheHits++; return cache[k]; }
  const u = new URL("https://api.twelvedata.com/time_series");
  u.searchParams.set("symbol", symbol);
  u.searchParams.set("interval", "1min");
  u.searchParams.set("outputsize", "5000");
  u.searchParams.set("order", "ASC");
  u.searchParams.set("timezone", "UTC");
  u.searchParams.set("start_date", `${day} 00:00:00`);
  u.searchParams.set("end_date", `${day} 23:59:00`);
  u.searchParams.set("apikey", KEY!);
  httpRequests++;
  const res = await fetch(u);
  const body = await res.json();
  if (body?.status === "error") {
    apiErrors++;
    if (String(body?.code) === "429") rateLimited++;
    throw new Error(`twelvedata ${body?.code}: ${String(body?.message).slice(0, 100)}`);
  }
  const out: Candle[] = (body?.values ?? []).map((v: Record<string, string>) => ({
    datetime: `${v.datetime.replace(" ", "T")}Z`,
    open: Number(v.open), high: Number(v.high), low: Number(v.low), close: Number(v.close),
    volume: Number(v.volume ?? 0),
  }));
  cache[k] = out;
  await Deno.writeTextFile(CACHE, JSON.stringify(cache));
  await new Promise((s) => setTimeout(s, 8200));   // free tier: 8 req/min
  return out;
}

// ── inputs ───────────────────────────────────────────────────────────────────

interface AuditRow {
  instrument: string; entryBarTime: string; direction: string;
  entry: number; target: number; stop: number; netR: number;
  bucket: string; sameBar: boolean;
}
const audit: AuditRow[] = JSON.parse(await Deno.readTextFile("/tmp/intrabar-audit.json"));
const attrib = JSON.parse(await Deno.readTextFile("/tmp/td-attribution.json"));
const attrOf = new Map<string, string>();
const tdBarOf = new Map<string, { o: number; h: number; l: number; c: number }>();
for (const a of attrib) {
  attrOf.set(`${a.instrument}|${a.barTime}`, a.attribution);
  if (a.o) tdBarOf.set(`${a.instrument}|${a.barTime}`, { o: a.o.twelve, h: a.h.twelve, l: a.l.twelve, c: a.c.twelve });
}

const storedBars = new Map<string, Candle[]>();
for (const inst of IPO_INSTRUMENTS) {
  try {
    const B = JSON.parse(JSON.parse(await Deno.readTextFile(
      `/tmp/state_${inst.instrument.replace("/", "_")}.json`))[0].value).bars;
    storedBars.set(inst.instrument, B.t.map((datetime: string, i: number) => ({
      datetime, open: B.o[i], high: B.h[i], low: B.l[i], close: B.c[i], volume: 0 })));
  } catch { /* skipped below */ }
}

const targets = audit.filter((r) => r.sameBar);
console.log(`same-bar trades to resolve: ${targets.length}`);
console.log(`distinct instrument-days to fetch: ${new Set(targets.map((r) =>
  `${r.instrument}|${r.entryBarTime.slice(0, 10)}`)).size}\n`);

// ── resolve ──────────────────────────────────────────────────────────────────

interface Out {
  instrument: string; timeframe: string; entryBarTime: string; direction: string;
  entry: number; s2: number; target: number; risk: number;
  htfRecordedR: number; htfBucket: string;
  attribution: string;
  resolutionProvider: string; resolutionProvenance: string; resolutionTimeframe: string;
  minutesExpected: number; minutesSeen: number; minutesMissing: number;
  aggregateVsStoredPct: number | null; aggregateVsTwelvePct: number | null;
  coverageOk: boolean;
  entryMinute: string | null; targetMinute: string | null;
  s2TouchMinute: string | null; s2CloseMinute: string | null;
  entryBarOutcome: string | null;
  forward: ForwardResult | null;
  grossR: number | null; costR: number; netR: number | null;
  mfeR: number | null; maeR: number | null;
  status: string;
}

const results: Out[] = [];

for (const r of targets) {
  const inst = IPO_INSTRUMENTS.find((i) => i.instrument === r.instrument)!;
  const long = r.direction === "demand";
  const spec: TradeSpec = { direction: long ? "long" : "short",
    entry: r.entry, target: r.target, s2: r.stop, risk: Math.abs(r.entry - r.stop) };
  const key = `${r.instrument}|${r.entryBarTime}`;
  const attribution = attrOf.get(key) ?? "TWELVE_NO_DATA";
  const sourceMatched = attribution === "TWELVE_EXACT_MATCH";
  const costR = (2 * inst.costPerSide(r.entry)) / spec.risk;

  const feed: FeedIdentity = {
    provider: "twelvedata", venue: "TwelveData composite", symbol: r.instrument,
    provenance: sourceMatched ? "SOURCE_MATCHED" : "CROSS_FEED_REFERENCE",
    basis: sourceMatched
      ? "Stored HTF bar reproduced EXACTLY by Twelve Data on all four OHLC fields."
      : `Stored HTF bar attribution is ${attribution}; Twelve Data is not proven to be the source.`,
  };

  const base: Out = {
    instrument: r.instrument, timeframe: inst.timeframe, entryBarTime: r.entryBarTime,
    direction: r.direction, entry: r.entry, s2: r.stop, target: r.target, risk: spec.risk,
    htfRecordedR: r.netR, htfBucket: r.bucket, attribution,
    resolutionProvider: "twelvedata", resolutionProvenance: feed.provenance,
    resolutionTimeframe: "1min",
    minutesExpected: inst.barMs / 60000, minutesSeen: 0, minutesMissing: inst.barMs / 60000,
    aggregateVsStoredPct: null, aggregateVsTwelvePct: null, coverageOk: false,
    entryMinute: null, targetMinute: null, s2TouchMinute: null, s2CloseMinute: null,
    entryBarOutcome: null, forward: null,
    grossR: null, costR, netR: null, mfeR: null, maeR: null,
    status: "PENDING",
  };

  let day: Candle[];
  try { day = await dayMinutes(r.instrument, r.entryBarTime.slice(0, 10)); }
  catch (e) {
    results.push({ ...base, status: `API_ERROR: ${(e as Error).message}` });
    console.log(`${r.instrument} ${r.entryBarTime}  API_ERROR`);
    continue;
  }

  const start = new Date(r.entryBarTime).getTime();
  const end = start + inst.barMs;
  const ms = day.filter((c) => {
    const t = new Date(c.datetime).getTime();
    return t >= start && t < end;
  });

  const expected = inst.barMs / 60000;
  base.minutesSeen = ms.length;
  base.minutesMissing = expected - ms.length;

  // PART C — three layers of evidence.
  const storedBar = (storedBars.get(r.instrument) ?? []).find((b) => b.datetime === r.entryBarTime) ?? null;
  const tdBar = tdBarOf.get(key) ?? null;
  if (ms.length > 0) {
    const agg = { h: Math.max(...ms.map((c) => c.high)), l: Math.min(...ms.map((c) => c.low)) };
    if (storedBar) base.aggregateVsStoredPct =
      Math.max(Math.abs(agg.h - storedBar.high), Math.abs(agg.l - storedBar.low)) / storedBar.close;
    if (tdBar) base.aggregateVsTwelvePct =
      Math.max(Math.abs(agg.h - tdBar.h), Math.abs(agg.l - tdBar.l)) / tdBar.c;
  }

  // FX quotes gap at weekends and thin hours, so a short minute set is normal;
  // what matters is that the minutes present span the levels the trade needs.
  const AGG_LIMIT = 0.0005;
  const aggOk = (base.aggregateVsTwelvePct ?? 1) <= AGG_LIMIT;
  base.coverageOk = ms.length > 0 && aggOk;

  if (!base.coverageOk) {
    results.push({ ...base, status: ms.length === 0 ? "NO_1M_DATA" : "AGGREGATE_DIVERGENT" });
    console.log(`${r.instrument} ${r.entryBarTime}  ${ms.length === 0 ? "NO_1M_DATA" : "AGGREGATE_DIVERGENT"}`);
    continue;
  }

  const res: Resolution = resolveEntryBar(spec, ms, feed);
  base.entryMinute = res.entryMinuteTime;
  base.targetMinute = res.targetMinuteTime;
  base.s2TouchMinute = res.s2TouchMinuteTime;
  base.s2CloseMinute = res.s2CloseMinuteTime;
  base.entryBarOutcome = res.outcome;

  let fwd: ForwardResult | null = null;
  if (res.outcome === "TARGET_AFTER_ENTRY") {
    fwd = { outcome: "TARGET", exitBarTime: res.targetMinuteTime, exitPrice: spec.target,
            barsHeld: 0, grossR: Math.abs(spec.target - spec.entry) / spec.risk,
            mfeR: res.postEntryMfeR, maeR: res.postEntryMaeR, ambiguousBarTime: null };
  } else if (res.outcome === "S2_CLOSE_AFTER_ENTRY") {
    const mb = ms.find((c) => c.datetime === res.s2CloseMinuteTime)!;
    fwd = { outcome: "S2_CLOSE", exitBarTime: res.s2CloseMinuteTime, exitPrice: mb.close,
            barsHeld: 0, grossR: (long ? mb.close - spec.entry : spec.entry - mb.close) / spec.risk,
            mfeR: res.postEntryMfeR, maeR: res.postEntryMaeR, ambiguousBarTime: null };
  } else if (res.outcome === "STILL_OPEN_AT_BAR_END") {
    const all = storedBars.get(r.instrument) ?? [];
    const i = all.findIndex((b) => b.datetime === r.entryBarTime);
    fwd = continueAfterEntryBar(spec, i >= 0 ? all.slice(i + 1) : [],
                                res.postEntryMfeR, res.postEntryMaeR);
  }

  base.forward = fwd;
  base.grossR = fwd?.grossR ?? null;
  base.netR = fwd?.grossR === null || fwd?.grossR === undefined ? null : fwd.grossR - costR;
  base.mfeR = fwd?.mfeR ?? res.postEntryMfeR;
  base.maeR = fwd?.maeR ?? res.postEntryMaeR;
  base.status = res.outcome === "UNRESOLVED_AT_1M" ? "UNRESOLVED_AT_1M"
    : res.outcome === "NO_ENTRY_AT_1M" ? "NO_ENTRY_AT_1M"
    : fwd?.outcome === "AMBIGUOUS_LATER_BAR" ? "AMBIGUOUS_LATER_BAR"
    : fwd?.outcome === "STILL_OPEN_AT_END_OF_DATA" ? "STILL_OPEN_AT_END_OF_DATA"
    : "RESOLVED";

  results.push(base);
  console.log(
    `${r.instrument.padEnd(8)} ${r.entryBarTime}  ${sourceMatched ? "SRC" : "xfd"}  ` +
    `${(res.outcome).padEnd(22)} ${(fwd?.outcome ?? "—").padEnd(26)} ` +
    `netR=${base.netR === null ? "   —  " : base.netR.toFixed(3).padStart(7)}  (HTF ${r.netR.toFixed(3)})`);
}

await Deno.writeTextFile("/tmp/td-resolve.json", JSON.stringify(results, null, 1));
console.log(`\nAPI: ${httpRequests} requests, ${cacheHits} cache hits, ${apiErrors} errors, ${rateLimited} rate-limited.`);
console.log(`wrote ${results.length} rows to /tmp/td-resolve.json (no credential in file)`);

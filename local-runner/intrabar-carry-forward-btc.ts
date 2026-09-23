/**
 * PART G — continue the BTC trades that survived their entry hour.
 *
 * RESEARCH ONLY. Reads Bitstamp's public API and the persisted engine bars;
 * writes one local JSON. No database, no strategy code, no deployment.
 *
 * Stage 1 left seven BTC trades as STILL_OPEN_AT_BAR_END. Their corrected state
 * is neither a win, a loss, 0R nor a cancellation — it is simply OPEN after the
 * entry bar. This script carries them forward through subsequent HTF bars under
 * the existing rules to find out what actually happened.
 *
 * PROVENANCE IS UNCHANGED AND STAYS UNCHANGED. The entry hour is resolved on
 * Bitstamp minutes (VENUE_SPECIFIC), and the continuation runs on the STORED
 * HTF bars, whose provider was discarded and remains HTF_SOURCE_UNKNOWN. These
 * rows are NOT source-matched and are not relabelled as such.
 *
 * WHY CONTINUATION MAY USE HTF BARS. The audit established the defect is
 * confined to the entry bar: every later bar is already evaluated causally.
 * One exception is handled rather than ignored — a later bar that reaches the
 * target AND closes beyond S2 has the same ordering problem, and is flagged
 * AMBIGUOUS_LATER_BAR instead of being resolved stop-first by convention.
 */

import {
  resolveEntryBar, continueAfterEntryBar,
  type FeedIdentity, type TradeSpec, type Resolution, type ForwardResult,
} from "../supabase/functions/_shared/ipoIntrabarResolution.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { IPO_INSTRUMENTS } from "../supabase/functions/_shared/ipoInstruments.ts";

const FEED: FeedIdentity = {
  provider: "bitstamp", venue: "Bitstamp", symbol: "btcusd",
  provenance: "VENUE_SPECIFIC",
  basis: "Entry hour resolved on Bitstamp 1m. Continuation uses the stored HTF " +
         "bars, whose provider was discarded; those remain HTF_SOURCE_UNKNOWN.",
};

const BTC = IPO_INSTRUMENTS.find((i) => i.instrument === "BTC/USD")!;
const CACHE = "/tmp/bitstamp-1m-cache.json";

/** Market data only. Never a credential — this script uses no key at all. */
let cache: Record<string, Candle[]> = {};
try { cache = JSON.parse(await Deno.readTextFile(CACHE)); } catch { /* cold */ }
let httpRequests = 0, cacheHits = 0, apiErrors = 0;

async function minutes(startSec: number): Promise<Candle[]> {
  const key = String(startSec);
  if (cache[key]) { cacheHits++; return cache[key]; }
  const url = `https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=60&limit=60&start=${startSec}`;
  httpRequests++;
  const res = await fetch(url);
  if (!res.ok) { apiErrors++; throw new Error(`bitstamp HTTP ${res.status}`); }
  const body = await res.json();
  const out: Candle[] = (body?.data?.ohlc ?? []).map((b: Record<string, string>) => ({
    datetime: new Date(Number(b.timestamp) * 1000).toISOString().replace(".000Z", "Z"),
    open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close),
    volume: Number(b.volume ?? 0),
  })).filter((c: Candle) => {
    const t = new Date(c.datetime).getTime() / 1000;
    return t >= startSec && t < startSec + 3600;
  });
  cache[key] = out;
  await new Promise((s) => setTimeout(s, 350));
  return out;
}

// ── inputs ───────────────────────────────────────────────────────────────────

const prior = JSON.parse(await Deno.readTextFile("/tmp/intrabar-bitstamp.json"));
const state = JSON.parse(JSON.parse(await Deno.readTextFile("/tmp/state_BTC_USD.json"))[0].value);
const B = state.bars;
const bars: Candle[] = B.t.map((datetime: string, i: number) => ({
  datetime, open: B.o[i], high: B.h[i], low: B.l[i], close: B.c[i], volume: 0,
}));

// ALL same-bar trades, not only the carry-forward set: the four that closed on
// S2 inside the entry hour also need a corrected R, and the two genuine wins
// belong in the same table so the BTC picture is complete rather than partial.
const carry = prior.filter((r: Record<string, unknown>) => r.resolution !== null);
console.log(`BTC same-bar trades to re-resolve: ${carry.length}\n`);

interface Out {
  entryBarTime: string; direction: string;
  entry: number; target: number; s2: number; risk: number;
  htfRecordedR: number;
  entryMinute: string | null;
  endOfEntryHour: string;
  forward: ForwardResult;
  costR: number;
  netR: number | null;
  minutesHeld: number | null;
  provenanceEntryHour: string;
  provenanceContinuation: string;
}

const results: Out[] = [];

for (const r of carry) {
  const long = r.direction === "demand";
  const spec: TradeSpec = {
    direction: long ? "long" : "short",
    entry: r.entry, target: r.target, s2: r.stop,
    risk: Math.abs(r.entry - r.stop),
  };
  const startSec = Math.floor(new Date(r.entryBarTime).getTime() / 1000);
  const ms = await minutes(startSec);
  const res = resolveEntryBar(spec, ms, FEED);

  // Resolve the entry hour first; only carry forward if it survived.
  let fwd: ForwardResult;
  if (res.outcome === "TARGET_AFTER_ENTRY") {
    fwd = { outcome: "TARGET", exitBarTime: res.targetMinuteTime, exitPrice: spec.target,
            barsHeld: 0, grossR: Math.abs(spec.target - spec.entry) / spec.risk,
            mfeR: res.postEntryMfeR, maeR: res.postEntryMaeR, ambiguousBarTime: null };
  } else if (res.outcome === "S2_CLOSE_AFTER_ENTRY") {
    // Exit price is the close of the invalidating MINUTE, not the HTF close.
    const mb = ms.find((c) => c.datetime === res.s2CloseMinuteTime)!;
    const gross = (long ? mb.close - spec.entry : spec.entry - mb.close) / spec.risk;
    fwd = { outcome: "S2_CLOSE", exitBarTime: res.s2CloseMinuteTime, exitPrice: mb.close,
            barsHeld: 0, grossR: gross,
            mfeR: res.postEntryMfeR, maeR: res.postEntryMaeR, ambiguousBarTime: null };
  } else if (res.outcome === "UNRESOLVED_AT_1M") {
    fwd = { outcome: "STILL_OPEN_AT_END_OF_DATA", exitBarTime: null, exitPrice: null,
            barsHeld: 0, grossR: null, mfeR: res.postEntryMfeR, maeR: res.postEntryMaeR,
            ambiguousBarTime: res.ambiguousMinuteTime };
  } else {
    const idx = bars.findIndex((b) => b.datetime === r.entryBarTime);
    const later = idx >= 0 ? bars.slice(idx + 1) : [];
    fwd = continueAfterEntryBar(spec, later, res.postEntryMfeR, res.postEntryMaeR);
  }

  // Cost is fixed at entry, exactly as the frozen engine does it.
  const costR = (2 * BTC.costPerSide(r.entry)) / spec.risk;
  const netR = fwd.grossR === null ? null : fwd.grossR - costR;

  const minutesHeld = res.entryMinuteTime && fwd.exitBarTime
    ? Math.round((new Date(fwd.exitBarTime).getTime()
                  - new Date(res.entryMinuteTime).getTime()) / 60000)
    : null;

  results.push({
    entryBarTime: r.entryBarTime, direction: r.direction,
    entry: r.entry, target: r.target, s2: r.stop, risk: spec.risk,
    htfRecordedR: r.netR,
    entryMinute: res.entryMinuteTime,
    endOfEntryHour: res.outcome,
    forward: fwd, costR, netR, minutesHeld,
    provenanceEntryHour: "VENUE_SPECIFIC/bitstamp-1m",
    provenanceContinuation: "HTF_SOURCE_UNKNOWN/stored-htf-bars",
  });

  console.log(
    `${r.entryBarTime}  ${r.direction.padEnd(7)} entry@${(res.entryMinuteTime ?? "—").slice(11, 16)}  ` +
    `-> ${fwd.outcome.padEnd(26)} exit=${(fwd.exitBarTime ?? "—").slice(0, 16).replace("T", " ")}  ` +
    `bars=${String(fwd.barsHeld).padStart(3)}  netR=${netR === null ? "   —  " : netR.toFixed(3).padStart(6)}  ` +
    `(HTF booked ${r.netR.toFixed(3)})`);
}

await Deno.writeTextFile(CACHE, JSON.stringify(cache));

// ── summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(92)}\nFORWARD CONTINUATION — 7 BTC trades that survived their entry hour\n${"=".repeat(92)}`);
const byOutcome: Record<string, Out[]> = {};
for (const r of results) (byOutcome[r.forward.outcome] ??= []).push(r);
for (const [k, v] of Object.entries(byOutcome)) {
  const known = v.filter((x) => x.netR !== null);
  const sum = known.reduce((a, x) => a + (x.netR ?? 0), 0);
  console.log(`${k.padEnd(28)} n=${String(v.length).padStart(2)}   corrected netR=${known.length ? sum.toFixed(3).padStart(8) : "     n/a"}   HTF booked=${v.reduce((a, x) => a + x.htfRecordedR, 0).toFixed(3).padStart(8)}`);
}

const resolved = results.filter((r) => r.netR !== null);
const htfOnResolved = resolved.reduce((a, r) => a + r.htfRecordedR, 0);
const corrected = resolved.reduce((a, r) => a + (r.netR ?? 0), 0);
console.log(`\nresolved: ${resolved.length}/${results.length}`);
console.log(`  HTF booked on those : ${htfOnResolved.toFixed(3)}R`);
console.log(`  corrected           : ${corrected.toFixed(3)}R`);
console.log(`  delta               : ${(corrected - htfOnResolved).toFixed(3)}R`);
console.log(`\nMFE/MAE after entry (R), corrected:`);
for (const r of results) {
  console.log(`  ${r.entryBarTime}  mfe=${r.forward.mfeR.toFixed(2)}  mae=${r.forward.maeR.toFixed(2)}` +
    `  bars=${r.forward.barsHeld}  mins=${r.minutesHeld ?? "—"}`);
}

console.log(`\nAPI: ${httpRequests} Bitstamp requests, ${cacheHits} cache hits, ${apiErrors} errors. No credential used.`);
await Deno.writeTextFile("/tmp/intrabar-carry-btc.json", JSON.stringify(results, null, 1));
console.log(`wrote ${results.length} rows to /tmp/intrabar-carry-btc.json`);

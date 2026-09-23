/**
 * VENUE-SPECIFIC reconstruction: BTC/USD entry bars re-resolved on Bitstamp 1m.
 *
 * RESEARCH ONLY. Reads; writes nothing but a local JSON report. Does not touch
 * the live engine, the paper runner, the baseline, or any database row.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. Bitstamp is the venue that was manually
 * validated, and its public OHLC API needs no credentials, so it is the one
 * tape available to this investigation. It is NOT the tape that produced the
 * stored HTF bars — those came from the MetaAPI/TwelveData/Polygon fallback
 * chain and the runner discarded which. So every result here is labelled
 * VENUE_SPECIFIC, never SOURCE_MATCHED, and the labels are not decoration:
 * resolving an unknown-provider HTF bar with a known venue's minutes is a
 * second opinion, and calling it a reconstruction of the original path would
 * swap one unproven assumption for another.
 *
 * A DIVERGENCE CHECK RUNS FIRST. Before any trade is re-resolved, the Bitstamp
 * minutes for each HTF bar are aggregated back up to one hour and compared with
 * the stored bar. If the two tapes disagree materially on the hour, the
 * minute-level answer for that hour is not trustworthy either, and the trade is
 * reported as FEED_DIVERGENT rather than resolved.
 *
 * Usage: deno run --allow-read --allow-write --allow-net \
 *          local-runner/intrabar-resolve-bitstamp.ts
 * Requires /tmp/intrabar-audit.json from local-runner/intrabar-audit.ts.
 */

import {
  resolveEntryBar, compareToHtf,
  type FeedIdentity, type TradeSpec, type Resolution,
} from "../supabase/functions/_shared/ipoIntrabarResolution.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";

const FEED: FeedIdentity = {
  provider: "bitstamp", venue: "Bitstamp", symbol: "btcusd",
  provenance: "VENUE_SPECIFIC",
  basis: "Bitstamp public OHLC API v2. The HTF bar's own provider was discarded by " +
         "ipo-paper-runner, so no source match can be claimed or ruled out.",
};

/** Material hourly disagreement between the two tapes, as a fraction of price. */
const DIVERGENCE_LIMIT = 0.002;   // 0.2%

interface AuditRow {
  instrument: string; entryIndex: number; exitIndex: number; entryBarTime: string;
  direction: string; entry: number; target: number; stop: number;
  netR: number; bucket: string; sameBar: boolean;
}

async function bitstampMinutes(startSec: number, count: number): Promise<Candle[]> {
  const url = `https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=60&limit=${count}&start=${startSec}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`bitstamp ${res.status}`);
  const body = await res.json();
  return (body?.data?.ohlc ?? []).map((b: Record<string, string>) => ({
    datetime: new Date(Number(b.timestamp) * 1000).toISOString().replace(".000Z", "Z"),
    open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close),
    volume: Number(b.volume ?? 0),
  }));
}

/** Rolls minutes back up to the hour, so the two tapes can be compared like for like. */
function aggregate(ms: readonly Candle[]): Candle | null {
  if (ms.length === 0) return null;
  return {
    datetime: ms[0].datetime, open: ms[0].open,
    high: Math.max(...ms.map((c) => c.high)),
    low: Math.min(...ms.map((c) => c.low)),
    close: ms[ms.length - 1].close, volume: 0,
  };
}

const audit: AuditRow[] = JSON.parse(await Deno.readTextFile("/tmp/intrabar-audit.json"));
const btcState = JSON.parse(JSON.parse(await Deno.readTextFile("/tmp/state_BTC_USD.json"))[0].value);
const B = btcState.bars;
const storedAt = (iso: string) => {
  const i = B.t.indexOf(iso);
  return i < 0 ? null : { open: B.o[i], high: B.h[i], low: B.l[i], close: B.c[i] };
};

const targets = audit.filter((r) => r.instrument === "BTC/USD" && r.sameBar);
console.log(`BTC same-bar trades to resolve: ${targets.length}\n`);

interface Out extends AuditRow {
  htfBar: { open: number; high: number; low: number; close: number } | null;
  bsBar: { open: number; high: number; low: number; close: number } | null;
  divergencePct: number | null;
  feedDivergent: boolean;
  resolution: Resolution | null;
  verdict: string;
  htfExitReason: string;
}

const results: Out[] = [];

for (const r of targets) {
  const startSec = Math.floor(new Date(r.entryBarTime).getTime() / 1000);
  let minutes: Candle[] = [];
  try { minutes = await bitstampMinutes(startSec, 60); }
  catch (e) { console.log(`  ${r.entryBarTime}  fetch failed: ${(e as Error).message}`); }
  // Keep only minutes inside the HTF hour. A minute past the boundary would be
  // lookahead of a different flavour.
  minutes = minutes.filter((c) => {
    const t = new Date(c.datetime).getTime() / 1000;
    return t >= startSec && t < startSec + 3600;
  });

  const stored = storedAt(r.entryBarTime);
  const agg = aggregate(minutes);
  const divergencePct = stored && agg
    ? Math.max(Math.abs(agg.high - stored.high), Math.abs(agg.low - stored.low)) / stored.close
    : null;
  const feedDivergent = divergencePct !== null && divergencePct > DIVERGENCE_LIMIT;

  // HTF exit reason: every same-bar trade in the audit exited on target except
  // where the close was beyond the stop.
  const long = r.direction === "demand";
  const closedBeyond = stored ? (long ? stored.close < r.stop : stored.close > r.stop) : false;
  const htfExitReason = closedBeyond ? "S2_CLOSE_INVALIDATION" : "TARGET_2R";

  let resolution: Resolution | null = null;
  let verdict = "FEED_DIVERGENT";
  if (!feedDivergent) {
    const spec: TradeSpec = {
      direction: long ? "long" : "short",
      entry: r.entry, target: r.target, s2: r.stop,
      risk: Math.abs(r.entry - r.stop),
    };
    resolution = resolveEntryBar(spec, minutes, FEED);
    verdict = compareToHtf(htfExitReason as "TARGET_2R" | "S2_CLOSE_INVALIDATION", resolution);
  }

  results.push({ ...r, htfBar: stored, bsBar: agg, divergencePct, feedDivergent,
                 resolution, verdict, htfExitReason });

  const d = divergencePct === null ? "  n/a" : `${(divergencePct * 100).toFixed(3)}%`;
  console.log(
    `${r.entryBarTime}  ${r.direction.padEnd(7)} htf=${htfExitReason.padEnd(22)} ` +
    `div=${d.padStart(7)}  1m=${(resolution?.outcome ?? "—").padEnd(22)} ${verdict}`);
  await new Promise((s) => setTimeout(s, 350));   // courtesy rate limit
}

// ── summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(90)}\nVENUE-SPECIFIC (Bitstamp) RESOLUTION OF BTC SAME-BAR TRADES\n${"=".repeat(90)}`);
const by = (v: string) => results.filter((r) => r.verdict === v);
for (const v of ["AGREES", "CONTRADICTED", "STILL_UNRESOLVED", "NO_1M_COVERAGE", "FEED_DIVERGENT"]) {
  const set = by(v);
  if (set.length === 0) continue;
  const r = set.reduce((a, x) => a + x.netR, 0);
  console.log(`${v.padEnd(18)} n=${String(set.length).padStart(3)}   HTF-recorded R=${r.toFixed(2).padStart(8)}`);
}
const contra = by("CONTRADICTED");
console.log(`\nHTF R booked on CONTRADICTED trades: ${contra.reduce((a, x) => a + x.netR, 0).toFixed(2)}`);
console.log("(not a replacement expectancy — a count of trades whose recorded outcome");
console.log(" a different venue's minutes do not support)");

console.log(`\n${"=".repeat(90)}\nFEED DIVERGENCE, Bitstamp hour vs stored HTF bar\n${"=".repeat(90)}`);
const divs = results.map((r) => r.divergencePct).filter((d): d is number => d !== null);
if (divs.length) {
  divs.sort((a, b) => a - b);
  const pct = (x: number) => `${(x * 100).toFixed(3)}%`;
  console.log(`n=${divs.length}  min=${pct(divs[0])}  median=${pct(divs[divs.length >> 1])}  max=${pct(divs[divs.length - 1])}`);
  console.log(`above the ${DIVERGENCE_LIMIT * 100}% limit: ${divs.filter((d) => d > DIVERGENCE_LIMIT).length}`);
}

await Deno.writeTextFile("/tmp/intrabar-bitstamp.json", JSON.stringify(results, null, 1));
console.log(`\nwrote ${results.length} rows to /tmp/intrabar-bitstamp.json`);

/**
 * FORENSIC MEASUREMENT — intrabar entry-order exposure across the IPO corpus.
 *
 * READ-ONLY. It loads the bars already persisted in `ipo_engine_state`, replays
 * them through the UNMODIFIED live engine, and classifies each resulting trade
 * by whether its outcome is causally supported by OHLC alone. It changes no
 * strategy code, writes nothing, and deploys nothing.
 *
 * THE QUESTION. When a trade enters and exits on the same bar, OHLC gives four
 * numbers and no ordering. Sometimes that is still enough to decide; often it
 * is not. The categories below separate those cases instead of condemning every
 * same-bar trade, which would overstate the damage as badly as ignoring it
 * understates it.
 *
 *   ORDER_PROVEN_OPEN     the bar OPENED at or beyond the entry level, so entry
 *                         occurred at the first tick and everything after it is
 *                         genuinely post-entry. The target is earned.
 *   ORDER_PROVEN_CLOSE    exited on the close (S2 invalidation). The close is by
 *                         definition the bar's last event, so it cannot precede
 *                         the entry.
 *   PRE_ENTRY_TARGET      the bar OPENED already beyond the target. The target
 *                         was satisfied before a single tick of entry could
 *                         trade. This is the BTC incident, and the outcome is
 *                         not merely unproven — it is positively contradicted.
 *   ORDER_UNRESOLVED      the bar opened between entry and target, reached both,
 *                         and OHLC cannot say which came first. Could be a real
 *                         win; could be the BTC case. Unknowable at this
 *                         resolution.
 *   MULTI_BAR             exited on a later bar. The entry bar's range still
 *                         inflates MFE but the OUTCOME is unaffected.
 *
 * Usage: deno run --allow-read --allow-net --allow-env local-runner/intrabar-audit.ts
 * with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set, or --from-files to read
 * the JSON dumps in /tmp.
 */

import { replay, type EngineConfig } from "../supabase/functions/_shared/ipoLiveEngine.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { IPO_INSTRUMENTS } from "../supabase/functions/_shared/ipoInstruments.ts";

type Bucket =
  | "ORDER_PROVEN_OPEN" | "ORDER_PROVEN_CLOSE" | "PRE_ENTRY_TARGET"
  | "ORDER_UNRESOLVED" | "MULTI_BAR";

interface Row {
  instrument: string;
  ipoIndex: number;
  entryIndex: number;
  exitIndex: number;
  entryBarTime: string;
  direction: string;
  entry: number;
  target: number;
  stop: number;
  netR: number;
  bucket: Bucket;
  sameBar: boolean;
  /** `hitTarget && closedBeyond` — what the engine flags today. */
  flaggedToday: boolean;
}

function classify(t: {
  direction: string; entry: number; target: number; stop: number;
  entryIndex: number; exitIndex: number; exitPrice: number;
}, bar: Candle): { bucket: Bucket; flaggedToday: boolean } {
  const long = t.direction === "demand";
  const hitTarget = long ? bar.high >= t.target : bar.low <= t.target;
  const closedBeyond = long ? bar.close < t.stop : bar.close > t.stop;
  const flaggedToday = hitTarget && closedBeyond;

  if (t.exitIndex !== t.entryIndex) return { bucket: "MULTI_BAR", flaggedToday: false };

  // Exited on the close: the close is the last event of the bar, so ordering is
  // not in question.
  if (closedBeyond) return { bucket: "ORDER_PROVEN_CLOSE", flaggedToday };

  // The bar opened already beyond the target — the target predates any entry.
  const openBeyondTarget = long ? bar.open >= t.target : bar.open <= t.target;
  if (openBeyondTarget) return { bucket: "PRE_ENTRY_TARGET", flaggedToday };

  // The bar opened at or beyond the entry level, so entry is the first tick.
  const openAtOrBeyondEntry = long ? bar.open <= t.entry : bar.open >= t.entry;
  if (openAtOrBeyondEntry) return { bucket: "ORDER_PROVEN_OPEN", flaggedToday };

  return { bucket: "ORDER_UNRESOLVED", flaggedToday };
}

function barsFromState(stateJson: string): Candle[] {
  const st = JSON.parse(stateJson);
  const b = st.bars;
  return b.t.map((datetime: string, i: number) => ({
    datetime, open: b.o[i], high: b.h[i], low: b.l[i], close: b.c[i],
    volume: b.v?.[i] ?? 0,
  }));
}

async function loadBars(symbol: string): Promise<Candle[]> {
  const file = `/tmp/state_${symbol.replace("/", "_")}.json`;
  const raw = await Deno.readTextFile(file);
  return barsFromState(JSON.parse(raw)[0].value);
}

const rows: Row[] = [];

for (const inst of IPO_INSTRUMENTS) {
  let bars: Candle[];
  try { bars = await loadBars(inst.instrument); }
  catch { console.log(`skip ${inst.instrument}: no local state dump`); continue; }

  const cfg: EngineConfig = {
    instrument: inst.instrument, timeframe: inst.timeframe,
    highVolOnly: inst.highVolOnly, costPerSide: inst.costPerSide,
  };
  const engine = replay(bars, cfg);

  for (const t of engine.trades) {
    const bar = bars[t.entryIndex];
    const { bucket, flaggedToday } = classify(
      { direction: t.direction, entry: t.entry, target: t.target, stop: t.stop,
        entryIndex: t.entryIndex, exitIndex: t.exitIndex!, exitPrice: t.exitPrice! },
      bar,
    );
    rows.push({
      instrument: inst.instrument, ipoIndex: t.ipoIndex,
      entryIndex: t.entryIndex, exitIndex: t.exitIndex!,
      entryBarTime: bar.datetime, direction: t.direction,
      entry: t.entry, target: t.target, stop: t.stop, netR: t.netR!,
      bucket, sameBar: t.exitIndex === t.entryIndex, flaggedToday,
    });
  }
  console.log(`${inst.instrument}: ${bars.length} bars -> ${engine.trades.length} trades`);
}

// ── report ───────────────────────────────────────────────────────────────────

const BUCKETS: Bucket[] = ["MULTI_BAR", "ORDER_PROVEN_OPEN", "ORDER_PROVEN_CLOSE",
                           "ORDER_UNRESOLVED", "PRE_ENTRY_TARGET"];

const pad = (s: string, n: number) => s.padEnd(n);
const num = (n: number, w = 6) => String(n).padStart(w);

console.log(`\n${"=".repeat(96)}\nCOUNTS BY BUCKET\n${"=".repeat(96)}`);
console.log(pad("instrument", 12) + BUCKETS.map((b) => num(0, 20).slice(0, 20 - b.length) + b).join(""));
for (const inst of [...new Set(rows.map((r) => r.instrument))].concat(["PORTFOLIO"])) {
  const set = inst === "PORTFOLIO" ? rows : rows.filter((r) => r.instrument === inst);
  const cells = BUCKETS.map((b) => num(set.filter((r) => r.bucket === b).length, 20));
  console.log(pad(inst, 12) + cells.join(""));
}

console.log(`\n${"=".repeat(96)}\nR IMPACT OF THE UNSUPPORTED BUCKETS\n${"=".repeat(96)}`);
const sum = (rs: Row[]) => rs.reduce((a, r) => a + r.netR, 0);
for (const inst of [...new Set(rows.map((r) => r.instrument))].concat(["PORTFOLIO"])) {
  const set = inst === "PORTFOLIO" ? rows : rows.filter((r) => r.instrument === inst);
  const pre = set.filter((r) => r.bucket === "PRE_ENTRY_TARGET");
  const unres = set.filter((r) => r.bucket === "ORDER_UNRESOLVED");
  console.log(
    `${pad(inst, 12)} n=${num(set.length, 4)}  totalR=${sum(set).toFixed(2).padStart(9)}` +
    `   PRE_ENTRY n=${num(pre.length, 3)} R=${sum(pre).toFixed(2).padStart(8)}` +
    `   UNRESOLVED n=${num(unres.length, 3)} R=${sum(unres).toFixed(2).padStart(8)}`);
}

console.log(`\n${"=".repeat(96)}\nTELEMETRY GAP: unsupported but NOT flagged today\n${"=".repeat(96)}`);
const unsupported = rows.filter((r) => r.bucket === "PRE_ENTRY_TARGET" || r.bucket === "ORDER_UNRESOLVED");
console.log(`unsupported same-bar target exits: ${unsupported.length}`);
console.log(`  of those, sameBarAmbiguous=true today: ${unsupported.filter((r) => r.flaggedToday).length}`);
console.log(`  of those, sameBarAmbiguous=false today: ${unsupported.filter((r) => !r.flaggedToday).length}`);

console.log(`\n${"=".repeat(96)}\nPRE_ENTRY_TARGET DETAIL (target predates any possible entry)\n${"=".repeat(96)}`);
for (const r of rows.filter((x) => x.bucket === "PRE_ENTRY_TARGET")) {
  console.log(`${pad(r.instrument, 9)} ${r.entryBarTime}  ${pad(r.direction, 7)} ` +
    `entry=${r.entry.toFixed(5)} target=${r.target.toFixed(5)} netR=${r.netR.toFixed(3)}`);
}

await Deno.writeTextFile("/tmp/intrabar-audit.json", JSON.stringify(rows, null, 1));
console.log(`\nwrote ${rows.length} classified trades to /tmp/intrabar-audit.json`);

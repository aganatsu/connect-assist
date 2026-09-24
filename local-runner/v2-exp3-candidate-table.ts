/**
 * IPO-CET-v2 EXPERIMENT 3 — PASS 2: baseline replay and per-bar candidate table
 * for the unseen windows.
 *
 * RESEARCH ONLY. No API, no database, no production change. Reads the cached
 * unseen-window bars written by v2-exp3-unseen-fetch.ts.
 *
 * TWO OUTPUTS, BOTH NEEDED.
 *
 *   1. `replay()` from the UNMODIFIED `ipoLiveEngine` over each unseen window.
 *      This is the frozen strategy's own answer on data it has never seen, and
 *      it is the baseline population. Nothing about it is reconstructed.
 *
 *   2. A per-bar candidate table: for EVERY bar, what the frozen lifecycle says
 *      about that bar's prefix. Experiment 2's sequencer replays any entry
 *      filter from this table in milliseconds and is asserted, field-for-field,
 *      to reproduce output (1) when its gate is wired open.
 *
 * The engine only consults the lifecycle when no position is open, so the table
 * is a superset with identical values wherever the engine does ask. That is what
 * makes the equivalence assertion meaningful rather than circular.
 */

import { runLifecycle } from "../supabase/functions/_shared/ipoLifecycle.ts";
import { episodesFor, replay, type EngineConfig } from "../supabase/functions/_shared/ipoLiveEngine.ts";
import { LiveVolatility } from "../supabase/functions/_shared/ipoLiveVolatility.ts";
import { IPO_INSTRUMENTS } from "../supabase/functions/_shared/ipoInstruments.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";

const WIN = JSON.parse(await Deno.readTextFile("/tmp/v2-exp3-windows.json")) as {
  windows: Array<{ id: string; from: string; to: string; months: number }>;
};
const htf: Record<string, Candle[]> = JSON.parse(await Deno.readTextFile("/tmp/v2-exp3-htf.json"));
const OUT = "/tmp/v2-exp3-candidates.json";

/** Freeze §17 BTC cleaning. Identical detector, never tuned, never repaired. */
const isDecimalShift = (b: Candle) => b.low < Math.min(b.open, b.close) / 100;

/** Verify the engine still carries the post-fix semantics the locked baseline used. */
{
  const src = await Deno.readTextFile("supabase/functions/_shared/ipoLiveEngine.ts");
  const costAtEntry = src.includes("costR: (2 * this.cfg.costPerSide(bar.close)) / risk");
  const noSameBarReentry = src.includes("if (this.open || k <= this.lastExitIndex)");
  const stopFirst = src.includes("if (closedBeyond) {");
  console.log(`engine semantics: cost at ENTRY bar=${costAtEntry}  same-bar re-entry FORBIDDEN=${noSameBarReentry}  ` +
    `HTF stop-first=${stopFirst}`);
  if (!costAtEntry || !noSameBarReentry || !stopFirst) {
    console.error("FATAL: the frozen engine semantics have moved."); Deno.exit(1);
  }
}

interface BarRecord {
  vol: string;
  hit: {
    candidateIndex: number; direction: "demand" | "supply";
    zoneLow: number; zoneHigh: number; invalidationLevel: number;
  } | null;
}
interface WindowTable {
  window: string; instrument: string; interval: string; from: string; to: string;
  months: number; rawBars: number; droppedBars: number;
  bars: Candle[]; rows: BarRecord[];
  engineTrades: Array<{
    entryIndex: number; exitIndex: number; netR: number; vol: string; ipoIndex: number;
    direction: string; entry: number; stop: number; target: number; risk: number;
    costR: number; entryBarTime: string; exitBarTime: string;
  }>;
  elapsedMs: number; completed: boolean;
}

let tables: Record<string, WindowTable> = {};
try { tables = JSON.parse(await Deno.readTextFile(OUT)); } catch { /* cold */ }

console.log("=".repeat(100));
console.log("EXPERIMENT 3 — PASS 2: frozen replay + candidate table on the unseen windows");
console.log("=".repeat(100));

const t0 = Date.now();
for (const w of WIN.windows) {
  for (const inst of IPO_INSTRUMENTS) {
    const id = `${w.id}-${inst.instrument.replace("/", "")}`;
    if (tables[id]?.completed) {
      console.log(`  ${id.padEnd(14)} RESUMED  ${tables[id].bars.length} bars  ${tables[id].engineTrades.length} trades`);
      continue;
    }
    const interval = inst.timeframe === "30min" ? "30min" : "1h";
    const raw = htf[`${inst.instrument}|${interval}|${w.from}|${w.to}`];
    if (!raw) { console.error(`FATAL: bars missing for ${id}; run the fetch pass first.`); Deno.exit(1); }

    const bars: Candle[] = inst.instrument === "BTC/USD" ? raw.filter((b) => !isDecimalShift(b)) : raw;
    const dropped = raw.length - bars.length;

    const started = Date.now();

    // (1) the frozen engine's own answer
    const cfg: EngineConfig = {
      instrument: inst.instrument, timeframe: inst.timeframe,
      highVolOnly: inst.highVolOnly, costPerSide: inst.costPerSide,
    };
    const e = replay(bars, cfg);

    // (2) the per-bar candidate table
    const vol = new LiveVolatility();
    const prefix: Candle[] = [];
    const rows: BarRecord[] = [];
    for (let k = 0; k < bars.length; k++) {
      prefix.push(bars[k]);
      const bucket = vol.push(bars[k]).vol;
      const life = runLifecycle(prefix, episodesFor(prefix))
        .filter((x) => x.validAt !== null && x.hasFvg);
      const hit = life.find((x) => x.touches.includes(k));
      rows.push({
        vol: bucket,
        hit: hit
          ? {
            candidateIndex: hit.candidateIndex, direction: hit.direction,
            zoneLow: hit.zoneLow, zoneHigh: hit.zoneHigh,
            invalidationLevel: hit.invalidationLevel,
          }
          : null,
      });
      if (k > 0 && k % 400 === 0) {
        console.log(`    ${id} ${k}/${bars.length} ${((Date.now() - started) / 1000).toFixed(0)}s`);
      }
    }

    tables[id] = {
      window: id, instrument: inst.instrument, interval,
      from: w.from, to: w.to, months: w.months,
      rawBars: raw.length, droppedBars: dropped, bars, rows,
      engineTrades: e.trades.map((t) => ({
        entryIndex: t.entryIndex, exitIndex: t.exitIndex!, netR: t.netR!, vol: t.vol,
        ipoIndex: t.ipoIndex, direction: t.direction, entry: t.entry, stop: t.stop,
        target: t.target, risk: t.risk, costR: t.costR,
        entryBarTime: bars[t.entryIndex].datetime, exitBarTime: bars[t.exitIndex!].datetime,
      })),
      elapsedMs: Date.now() - started, completed: true,
    };
    await Deno.writeTextFile(OUT, JSON.stringify(tables));
    console.log(`  ${id.padEnd(14)} ${inst.instrument.padEnd(8)} ${String(raw.length).padStart(5)} raw` +
      `${dropped ? ` -${dropped} corrupt` : "          "} -> ${String(bars.length).padStart(5)} bars -> ` +
      `${String(e.trades.length).padStart(4)} trades  ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }
}

const all = Object.values(tables).filter((t) => t.completed);
const total = all.reduce((a, t) => a + t.engineTrades.length, 0);
console.log(`\nbaseline population on unseen data: ${total} trades across ${all.length} window-instruments`);
for (const inst of IPO_INSTRUMENTS) {
  const n = all.filter((t) => t.instrument === inst.instrument).reduce((a, t) => a + t.engineTrades.length, 0);
  console.log(`  ${inst.instrument.padEnd(8)} ${n}`);
}
console.log(`total ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min — wrote ${OUT}`);

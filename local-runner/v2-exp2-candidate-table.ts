/**
 * IPO-CET-v2 EXPERIMENT 2 — PASS 1: the per-bar candidate table.
 *
 * RESEARCH ONLY. No production import is modified, no database is touched, no
 * deployment, no strategy rule is changed.
 *
 * WHY THIS EXISTS. Analysis 2 of the experiment needs a TRUE filtered replay:
 * when a context filter refuses an IPO, the one-position-per-instrument slot
 * stays free and a later IPO that the baseline never saw becomes eligible. The
 * only honest way to measure that is to re-run the engine's sequencing with the
 * filter live at decision time — once per filter variant.
 *
 * Re-running `ipoLiveEngine.replay` per filter would cost ~46 minutes each,
 * because the engine deliberately re-runs the frozen lifecycle over a growing
 * prefix on every bar. But that computation depends ONLY on the prefix. It does
 * not depend on whether a position happens to be open, and it does not depend on
 * any filter. So it is done ONCE here, for EVERY bar, and written to disk. The
 * sequencer then replays any number of filters from the table in milliseconds.
 *
 * The engine skips the lifecycle call while a position is open. Computing it at
 * every bar therefore produces a SUPERSET of what the engine would have asked
 * for, with identical values at every index the engine does ask about. The
 * companion script asserts that: with the gate wired permanently open, the table
 * reproduces `replay()` trade-for-trade, field-for-field.
 *
 * Inputs are the already-cached Twelve Data HTF windows. No API key, no fetch.
 */

import { runLifecycle } from "../supabase/functions/_shared/ipoLifecycle.ts";
import { episodesFor } from "../supabase/functions/_shared/ipoLiveEngine.ts";
import { LiveVolatility } from "../supabase/functions/_shared/ipoLiveVolatility.ts";
import { IPO_INSTRUMENTS } from "../supabase/functions/_shared/ipoInstruments.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";

/** Freeze §17, end-exclusive two-month periods. Identical to baseline-determinism.ts. */
const PERIODS: Array<[string, string]> = [
  ["2021-11-01", "2022-01-01"],
  ["2022-10-01", "2022-12-01"],
  ["2023-06-01", "2023-08-01"],
  ["2025-10-01", "2025-12-01"],
  ["2026-04-01", "2026-06-01"],
];

interface Win { id: string; instrument: string; interval: string; from: string; to: string }
const WINDOWS: Win[] = PERIODS.flatMap(([from, to], pi) =>
  IPO_INSTRUMENTS.map((inst) => ({
    id: `p${pi + 1}-${inst.instrument.replace("/", "")}`,
    instrument: inst.instrument,
    interval: inst.timeframe === "30min" ? "30min" : "1h",
    from, to,
  })));

const HTF_CACHE = "/tmp/td-htf-windows.json";
const OUT = "/tmp/v2-exp2-candidates.json";

const htf: Record<string, Candle[]> = JSON.parse(await Deno.readTextFile(HTF_CACHE));

/** Freeze §17 BTC cleaning. Identical detector, never tuned. */
const isDecimalShift = (b: Candle) => b.low < Math.min(b.open, b.close) / 100;

export interface BarRecord {
  /** Volatility bucket for this bar, from the streaming classifier. */
  vol: string;
  /** The candidate whose touch list contains this bar, if any. */
  hit: {
    candidateIndex: number;
    direction: "demand" | "supply";
    zoneLow: number;
    zoneHigh: number;
    invalidationLevel: number;
  } | null;
}

interface WindowTable {
  window: string;
  instrument: string;
  interval: string;
  from: string;
  to: string;
  bars: Candle[];
  rows: BarRecord[];
  elapsedMs: number;
  completed: boolean;
}

let tables: Record<string, WindowTable> = {};
try { tables = JSON.parse(await Deno.readTextFile(OUT)); } catch { /* cold */ }

console.log("=".repeat(92));
console.log("EXPERIMENT 2 — PASS 1: per-bar candidate table (no API, cached HTF only)");
console.log("=".repeat(92));

const t0 = Date.now();

for (const w of WINDOWS) {
  if (tables[w.id]?.completed) {
    console.log(`  ${w.id.padEnd(12)} RESUMED  ${tables[w.id].bars.length} bars`);
    continue;
  }
  const key = `${w.instrument}|${w.interval}|${w.from}|${w.to}`;
  const raw = htf[key];
  if (!raw) { console.error(`FATAL: ${key} absent from ${HTF_CACHE}; refusing to fetch.`); Deno.exit(1); }

  const bars: Candle[] = w.instrument === "BTC/USD" ? raw.filter((b) => !isDecimalShift(b)) : raw;

  const started = Date.now();
  const vol = new LiveVolatility();
  const prefix: Candle[] = [];
  const rows: BarRecord[] = [];

  for (let k = 0; k < bars.length; k++) {
    prefix.push(bars[k]);
    const bucket = vol.push(bars[k]).vol;

    // Exactly the engine's A1 evaluation, on exactly the engine's prefix.
    const life = runLifecycle(prefix, episodesFor(prefix))
      .filter((x) => x.validAt !== null && x.hasFvg);
    const hit = life.find((x) => x.touches.includes(k));

    rows.push({
      vol: bucket,
      hit: hit
        ? {
          candidateIndex: hit.candidateIndex,
          direction: hit.direction,
          zoneLow: hit.zoneLow,
          zoneHigh: hit.zoneHigh,
          invalidationLevel: hit.invalidationLevel,
        }
        : null,
    });

    if (k > 0 && k % 250 === 0) {
      const pct = ((k / bars.length) * 100).toFixed(0);
      console.log(`    ${w.id} ${k}/${bars.length} (${pct}%) ${((Date.now() - started) / 1000).toFixed(0)}s`);
    }
  }

  tables[w.id] = {
    window: w.id, instrument: w.instrument, interval: w.interval,
    from: w.from, to: w.to, bars, rows,
    elapsedMs: Date.now() - started, completed: true,
  };
  await Deno.writeTextFile(OUT, JSON.stringify(tables));
  const hits = rows.filter((r) => r.hit).length;
  console.log(`  ${w.id.padEnd(12)} ${w.instrument.padEnd(8)} ${String(bars.length).padStart(5)} bars  ` +
    `${String(hits).padStart(4)} bars carry a candidate touch  ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

console.log(`\ntotal ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min — wrote ${OUT}`);

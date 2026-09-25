/**
 * SMC ZONE / IMPULSE — STAGE 2: THE CAUSAL REPLAY CONTRACT.
 *
 * RESEARCH ONLY. No production module is modified, no database is written, no
 * deployment, no strategy rule is changed. Every decision is made by the
 * PRODUCTION `findUnifiedZone` called unmodified; this file contains no copy of
 * any rule.
 *
 * THE DEFECT UNDER TEST. `impulseZoneEngine.validateImpulseFromBOS` decides
 * whether an impulse is acceptable by scanning
 *
 *     for (let j = endIdx + 1; j < candles.length; j++)
 *
 * for a close beyond the origin. Live, the array ends at the current bar and
 * that is causal. Hand the same function a full history and it scans into the
 * future: a leg that was perfectly valid at time k is rejected because of a bar
 * at k+n. A whole-history replay therefore keeps only the impulses whose origin
 * survived to the end of the file — survivorship selection on the ONE condition
 * that decides acceptance.
 *
 * TWO TREATMENTS, one difference: future candle visibility.
 *
 *   A  LEGACY_WHOLE_SERIES   the engine receives the entire cached series and
 *                            the decision is read off at bar k. This is what a
 *                            naive backtest does.
 *   B  CAUSAL_PREFIX         the engine receives only closed bars up to k, at
 *                            production's 300-bar depth. Nothing after the
 *                            decision instant is visible.
 *
 * Both use the SAME current price — `close[k]` — so the only thing that moves is
 * what the engine can see.
 *
 * HONEST LIMIT OF THAT COMPARISON: treatment A also sees a LONGER array, so its
 * difference bundles future-origin-break with a bigger structure window. The
 * unconfounded measure of the defect is computed separately in Part C, which
 * takes every impulse the CAUSAL replay accepted and asks directly whether a
 * later close broke its origin. That number is the headline.
 */

import { findUnifiedZone } from "../supabase/functions/_shared/unifiedZoneEngine.ts";
import { detectLiquidityPools, SPECS, type Candle } from "../supabase/functions/_shared/smcAnalysis.ts";

const CACHE = "/tmp/zone-stage1-candles.json";
const OUT = "/tmp/zone-stage2-causal.json";
const LEDGER = "/tmp/zone-stage2-ledger.json";

const cache: Record<string, Candle[]> = JSON.parse(await Deno.readTextFile(CACHE));

/** Production depth: bot-scanner DEFAULT_CANDLE_LIMIT. */
const DEPTH = 300;
/** Scalper slots, from bot-scanner L5546. Not a choice made here. */
const SLOTS = { top: "1h", mid: "15m", low: "5m" } as const;
const BAR_MS = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000 } as const;

/** The Stage 1 oracle window, so both stages describe the same period. */
const FROM = Date.parse("2026-09-15T00:00:00Z");
const TO = Date.parse("2026-09-24T11:00:00Z");

const PAIRS = [...new Set(Object.keys(cache).map((k) => k.split("|")[0]))].sort();
const ms = (t: string) => Date.parse(t);

/** Bars fully closed at or before `at`. Never the bar in progress. */
function closedBy(series: Candle[], barMs: number, at: number): Candle[] {
  const out: Candle[] = [];
  for (const c of series) {
    if (ms(c.datetime) + barMs <= at) out.push(c); else break;
  }
  return out;
}

interface Shot {
  hasZone: boolean;
  state: string;
  tf: string | null;
  impHigh: number | null;
  impLow: number | null;
  impBos: number | null;
  impDir: string | null;
  zHigh: number | null;
  zLow: number | null;
  zType: string | null;
}

const EMPTY: Shot = {
  hasZone: false, state: "none", tf: null, impHigh: null, impLow: null,
  impBos: null, impDir: null, zHigh: null, zLow: null, zType: null,
};

function shotOf(r: ReturnType<typeof findUnifiedZone>): Shot {
  return {
    hasZone: r.hasZone, state: r.state, tf: r.selectedTF ?? null,
    impHigh: r.impulse?.high ?? null, impLow: r.impulse?.low ?? null,
    impBos: r.impulse?.bosPrice ?? null, impDir: r.impulse?.direction ?? null,
    zHigh: r.zone?.high ?? null, zLow: r.zone?.low ?? null, zType: r.zone?.type ?? null,
  };
}

/**
 * One evaluation. `future` selects the treatment: when false the arrays are
 * truncated at the decision instant and sliced to production depth; when true
 * the full cached series is handed over, exactly as a naive backtest would.
 */
function evaluate(
  pair: string, at: number, price: number, dir: "bullish" | "bearish", future: boolean,
): Shot | null {
  const pick = (tf: keyof typeof BAR_MS) => {
    const all = cache[`${pair}|${tf}`] ?? [];
    return future ? all : closedBy(all, BAR_MS[tf], at).slice(-DEPTH);
  };
  const m5 = pick("5m"), m15 = pick("15m"), h1 = pick("1h");
  if (m5.length < 20 || m15.length < 20 || h1.length < 20) return null;

  const spec = SPECS[pair] ?? SPECS["EUR/USD"];
  const pools = detectLiquidityPools(h1, 0.0005, 2);

  const r = findUnifiedZone(
    m5, m15, m5, dir, price, pools, undefined,
    { pipSize: spec.pipSize },
    h1, m15.length >= 15 ? m15 : m5, m5, {},
    { top: "1H", mid: "15m", low: "5m" },
  );
  return shotOf(r);
}

// ─────────────────────────────────────────────────────────────────────────────
// Parts A + B — the two treatments, decision bar by decision bar
// ─────────────────────────────────────────────────────────────────────────────

interface Diff {
  pair: string; at: string; dir: string;
  legacy: Shot; causal: Shot; fields: string[];
}

const near = (a: number | null, b: number | null, tol: number) =>
  a === null || b === null ? a === b : Math.abs(a - b) <= tol;

const diffs: Diff[] = [];
const perPair: Record<string, {
  decisions: number; both: number;
  impulseOnlyLegacy: number; impulseOnlyCausal: number;
  impulseChanged: number; zoneChanged: number; stateChanged: number; tfChanged: number;
}> = {};

console.log("=".repeat(100));
console.log("STAGE 2B — LEGACY_WHOLE_SERIES vs CAUSAL_PREFIX");
console.log("=".repeat(100));

const t0 = Date.now();
for (const pair of PAIRS) {
  const spec = SPECS[pair] ?? SPECS["EUR/USD"];
  const tol = spec.pipSize * 0.5;
  const m5all = cache[`${pair}|5m`] ?? [];
  const p = perPair[pair] = {
    decisions: 0, both: 0, impulseOnlyLegacy: 0, impulseOnlyCausal: 0,
    impulseChanged: 0, zoneChanged: 0, stateChanged: 0, tfChanged: 0,
  };

  for (const bar of m5all) {
    const at = ms(bar.datetime) + BAR_MS["5m"];   // decision at the bar's CLOSE
    if (at < FROM || at > TO) continue;
    // Production depth must be reachable, or the two treatments are not comparable.
    if (closedBy(cache[`${pair}|1h`] ?? [], BAR_MS["1h"], at).length < DEPTH) continue;
    if (closedBy(cache[`${pair}|15m`] ?? [], BAR_MS["15m"], at).length < DEPTH) continue;
    if (closedBy(m5all, BAR_MS["5m"], at).length < DEPTH) continue;

    // Direction is a downstream input the zone engine does not decide. Both
    // treatments are run for both directions so the comparison cannot be biased
    // by a direction call that itself differs between them.
    for (const dir of ["bullish", "bearish"] as const) {
      const causal = evaluate(pair, at, bar.close, dir, false);
      const legacy = evaluate(pair, at, bar.close, dir, true);
      if (!causal || !legacy) continue;
      p.decisions++;

      const cImp = causal.impHigh !== null, lImp = legacy.impHigh !== null;
      if (cImp && lImp) p.both++;
      if (lImp && !cImp) p.impulseOnlyLegacy++;
      if (cImp && !lImp) p.impulseOnlyCausal++;

      const fields: string[] = [];
      if (!near(legacy.impHigh, causal.impHigh, tol)) fields.push("impulse.high");
      if (!near(legacy.impLow, causal.impLow, tol)) fields.push("impulse.low");
      if (!near(legacy.impBos, causal.impBos, tol)) fields.push("impulse.bosPrice");
      if (!near(legacy.zHigh, causal.zHigh, tol)) fields.push("zone.high");
      if (!near(legacy.zLow, causal.zLow, tol)) fields.push("zone.low");
      if (legacy.zType !== causal.zType) fields.push("zone.type");
      if (legacy.tf !== causal.tf) fields.push("selectedTF");
      if (legacy.state !== causal.state) fields.push("state");

      if (fields.some((f) => f.startsWith("impulse"))) p.impulseChanged++;
      if (fields.some((f) => f.startsWith("zone"))) p.zoneChanged++;
      if (fields.includes("state")) p.stateChanged++;
      if (fields.includes("selectedTF")) p.tfChanged++;

      if (fields.length) {
        diffs.push({ pair, at: new Date(at).toISOString(), dir, legacy, causal, fields });
      }
    }
  }
  const pct = (a: number) => p.decisions ? `${(a / p.decisions * 100).toFixed(1)}%` : "—";
  console.log(`  ${pair.padEnd(9)} decisions ${String(p.decisions).padStart(6)}  ` +
    `impulse changed ${String(p.impulseChanged).padStart(6)} ${pct(p.impulseChanged).padStart(6)}  ` +
    `zone ${String(p.zoneChanged).padStart(6)} ${pct(p.zoneChanged).padStart(6)}  ` +
    `state ${String(p.stateChanged).padStart(6)} ${pct(p.stateChanged).padStart(6)}  ` +
    `legacy-only impulse ${String(p.impulseOnlyLegacy).padStart(5)}  causal-only ${String(p.impulseOnlyCausal).padStart(5)}`);
}
console.log(`  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

// ─────────────────────────────────────────────────────────────────────────────
// Part C — survivorship attribution, unconfounded
// ─────────────────────────────────────────────────────────────────────────────
//
// For every impulse the CAUSAL replay accepted, ask the question the legacy
// replay asks: does a later close break the origin? If yes, the whole-series
// engine would have rejected this leg — so the legacy population is selected on
// information the decision could not have had.
//
// This reads the origin rule out of the production source rather than restating
// it: bullish rejects on `close < originPrice`, bearish on `close > originPrice`,
// where originPrice is the impulse LOW for bullish and the HIGH for bearish.

interface Surv {
  pair: string; at: string; dir: string; tf: string | null;
  origin: number; breakAt: string | null; barsUntilBreak: number | null;
  state: string; hadZone: boolean;
}

const surv: Surv[] = [];
console.log(`\n${"=".repeat(100)}`);
console.log("STAGE 2C — SURVIVORSHIP: causal impulses whose origin broke LATER");
console.log("=".repeat(100));

for (const pair of PAIRS) {
  const m5all = cache[`${pair}|5m`] ?? [];
  let accepted = 0, doomed = 0;

  for (const bar of m5all) {
    const at = ms(bar.datetime) + BAR_MS["5m"];
    if (at < FROM || at > TO) continue;
    if (closedBy(cache[`${pair}|1h`] ?? [], BAR_MS["1h"], at).length < DEPTH) continue;
    if (closedBy(cache[`${pair}|15m`] ?? [], BAR_MS["15m"], at).length < DEPTH) continue;
    if (closedBy(m5all, BAR_MS["5m"], at).length < DEPTH) continue;

    for (const dir of ["bullish", "bearish"] as const) {
      const c = evaluate(pair, at, bar.close, dir, false);
      if (!c || c.impHigh === null || c.impLow === null) continue;
      accepted++;

      // The slot the impulse was found on decides which series to walk forward.
      const tfKey = c.tf === "1H" ? "1h" : c.tf === "15m" ? "15m" : "5m";
      const series = cache[`${pair}|${tfKey}`] ?? [];
      const originPrice = dir === "bullish" ? c.impLow : c.impHigh;

      let breakAt: string | null = null, bars = 0, counted = 0;
      for (const f of series) {
        const t = ms(f.datetime);
        if (t + BAR_MS[tfKey] <= at) continue;   // not future
        counted++;
        if ((dir === "bullish" && f.close < originPrice) ||
            (dir === "bearish" && f.close > originPrice)) {
          breakAt = f.datetime; bars = counted; break;
        }
      }
      if (breakAt) {
        doomed++;
        surv.push({
          pair, at: new Date(at).toISOString(), dir, tf: c.tf,
          origin: originPrice, breakAt, barsUntilBreak: bars,
          state: c.state, hadZone: c.hasZone,
        });
      }
    }
  }
  const pct = accepted ? `${(doomed / accepted * 100).toFixed(1)}%` : "—";
  console.log(`  ${pair.padEnd(9)} causal impulses ${String(accepted).padStart(6)}  ` +
    `origin broke later ${String(doomed).padStart(6)}  ${pct.padStart(7)}  ` +
    `-> invisible to a whole-series replay`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

const tot = (k: keyof typeof perPair[string]) =>
  Object.values(perPair).reduce((a, p) => a + (p[k] as number), 0);
const D = tot("decisions");
const pct = (a: number, b = D) => b ? `${(a / b * 100).toFixed(1)}%` : "—";

console.log(`\n${"=".repeat(100)}`);
console.log("TOTALS");
console.log("=".repeat(100));
console.log(`  decisions compared              ${D}`);
console.log(`  impulse geometry changed        ${tot("impulseChanged")}  ${pct(tot("impulseChanged"))}`);
console.log(`  zone geometry changed           ${tot("zoneChanged")}  ${pct(tot("zoneChanged"))}`);
console.log(`  UnifiedState changed            ${tot("stateChanged")}  ${pct(tot("stateChanged"))}`);
console.log(`  selected timeframe changed      ${tot("tfChanged")}  ${pct(tot("tfChanged"))}`);
console.log(`  impulse only in LEGACY          ${tot("impulseOnlyLegacy")}  ${pct(tot("impulseOnlyLegacy"))}`);
console.log(`  impulse only in CAUSAL          ${tot("impulseOnlyCausal")}  ${pct(tot("impulseOnlyCausal"))}`);

const fieldTally: Record<string, number> = {};
for (const d of diffs) for (const f of d.fields) fieldTally[f] = (fieldTally[f] ?? 0) + 1;
console.log(`\n  changed field tally:`);
for (const [k, v] of Object.entries(fieldTally).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(18)} ${String(v).padStart(7)}  ${pct(v)}`);
}

console.log(`\n  SURVIVORSHIP (Part C, unconfounded):`);
console.log(`    causal impulses whose origin broke later: ${surv.length}`);
const byTF: Record<string, number> = {};
for (const s of surv) byTF[s.tf ?? "none"] = (byTF[s.tf ?? "none"] ?? 0) + 1;
console.log(`    by slot: ${JSON.stringify(byTF)}`);
const withZone = surv.filter((s) => s.hadZone).length;
console.log(`    of those, ${withZone} had produced a zone (${pct(withZone, surv.length)} of doomed)`);
const median = (a: number[]) => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0;
console.log(`    median bars from decision to origin break: ${median(surv.map((s) => s.barsUntilBreak ?? 0))}`);

await Deno.writeTextFile(OUT, JSON.stringify({
  window: { from: new Date(FROM).toISOString(), to: new Date(TO).toISOString() },
  slots: SLOTS, depth: DEPTH,
  perPair, totals: {
    decisions: D, impulseChanged: tot("impulseChanged"), zoneChanged: tot("zoneChanged"),
    stateChanged: tot("stateChanged"), tfChanged: tot("tfChanged"),
    impulseOnlyLegacy: tot("impulseOnlyLegacy"), impulseOnlyCausal: tot("impulseOnlyCausal"),
  },
  fieldTally,
  survivorship: { total: surv.length, byTF, withZone },
}, null, 1));
await Deno.writeTextFile(LEDGER, JSON.stringify({ diffs: diffs.slice(0, 20000), survivorship: surv }, null, 1));
console.log(`\nwrote ${OUT} and ${LEDGER}`);

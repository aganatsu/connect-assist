/**
 * Objective detection of the MOVE that makes the preceding opposite-colour
 * candle an IPO. RESEARCH ONLY.
 *
 * THE FROZEN CANDLE RULE IS NOT TOUCHED:
 *   bullish expansion -> last BEARISH candle before the move
 *   bearish expansion -> last BULLISH candle before the move
 * The unresolved variable is "the move", and that is all this file addresses.
 *
 * ANTI-CIRCULARITY IS THE WHOLE POINT. Every previous attempt started at a known
 * IPO and asked what followed it, which guarantees a rule can be found and
 * guarantees it means nothing. Here moves are enumerated from raw bars with no
 * knowledge of any demonstration; only afterwards is the last opposite candle
 * before each move compared against what Ezzy marked.
 *
 * NO FITTED THRESHOLD. Every family compares a candidate move against its OWN
 * preceding context of equal length. The only constants are the inherited 14-bar
 * horizon and the 2-bar minimum already declared in the detector module.
 *
 * FINAL_BASE_EXIT and PERMANENT_BASE_EXIT are deliberately absent: both are
 * marked DEGENERATE_FOR_RESEARCH and collapse onto LAST_OPPOSITE_BEFORE_BREAK.
 */

import { DETECTOR_INHERITED_CONSTANTS, activeContextIndices } from "./ipoContractionDetector.ts";
import { fvgsNear } from "./ipoZones.ts";
import { directionalEvents } from "./ipoOriginExperiments.ts";
import type { Candle } from "./smcAnalysis.ts";

const CTX = DETECTOR_INHERITED_CONSTANTS.contextBars.value;
const MIN = DETECTOR_INHERITED_CONSTANTS.minWindowBars.value;

export type MoveFamily =
  | "M1_STRUCTURAL_BREAK"
  | "M2_DISPLACEMENT"
  | "M3_DIRECTIONAL_RUN"
  | "M4_FVG_CAUSAL"
  | "M5_CONTRACTION_EXPANSION"
  | "M6_STRUCTURE_PLUS_DISPLACEMENT";

export type OnsetDef =
  | "O1_FIRST_DIRECTIONAL"
  | "O2_FIRST_DISPLACEMENT"
  | "O3_SUSTAINED_RUN_START"
  | "O4_FIRST_FVG_SEQ"
  | "O5_BOS_CAUSAL_RUN"
  | "O6_SPAN_START";

export const MOVE_FAMILIES: MoveFamily[] = [
  "M1_STRUCTURAL_BREAK", "M2_DISPLACEMENT", "M3_DIRECTIONAL_RUN",
  "M4_FVG_CAUSAL", "M5_CONTRACTION_EXPANSION", "M6_STRUCTURE_PLUS_DISPLACEMENT",
];
export const ONSET_DEFS: OnsetDef[] = [
  "O1_FIRST_DIRECTIONAL", "O2_FIRST_DISPLACEMENT", "O3_SUSTAINED_RUN_START",
  "O4_FIRST_FVG_SEQ", "O5_BOS_CAUSAL_RUN", "O6_SPAN_START",
];

export interface Move {
  family: MoveFamily;
  direction: "bullish" | "bearish";
  /** Inclusive bar span of the departure. */
  spanStart: number;
  spanEnd: number;
}

const isUp = (c: Candle) => c.close >= c.open;
const body = (c: Candle) => Math.abs(c.close - c.open);

/** Net close travel over [a,b], signed. */
const net = (s: Candle[], a: number, b: number) => s[b].close - s[a].close;

/** |net| / total path over [a,b]. */
function efficiency(s: Candle[], a: number, b: number): number | null {
  if (b <= a) return null;
  let path = 0;
  for (let k = a + 1; k <= b; k++) path += Math.abs(s[k].close - s[k - 1].close);
  return path > 0 ? Math.abs(s[b].close - s[a].close) / path : null;
}

function meanBodyOfIdx(s: Candle[], idx: number[]): number | null {
  if (!idx.length) return null;
  let t = 0;
  for (const i of idx) t += body(s[i]);
  return t / idx.length;
}

/** Maximal runs of bars that keep progressing in one direction. */
function progressRuns(s: Candle[], up: boolean): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let a = 0; a < s.length - 1;) {
    let b = a;
    while (b + 1 < s.length && (up ? s[b + 1].high > s[b].high : s[b + 1].low < s[b].low)) b++;
    if (b - a + 1 >= MIN) out.push([a, b]);
    a = b > a ? b : a + 1;
  }
  return out;
}

/**
 * All six families. Each returns spans only; onset is a separate axis so the
 * two can be compared independently, which is what the open question requires.
 */
export function detectMoves(
  s: Candle[], family: MoveFamily, contractionEpisodes: Array<{ start: number; end: number }> = [],
): Move[] {
  const out: Move[] = [];
  const push = (direction: "bullish" | "bearish", a: number, b: number) => {
    if (b > a && a >= CTX) out.push({ family, direction, spanStart: a, spanEnd: b });
  };

  if (family === "M1_STRUCTURAL_BREAK" || family === "M6_STRUCTURE_PLUS_DISPLACEMENT") {
    for (const e of directionalEvents(s, {}) as any[]) {
      const a = e.swingIndex ?? Math.max(0, e.index - 10);
      const dir = e.direction === "bullish" ? "bullish" : "bearish";
      if (family === "M1_STRUCTURAL_BREAK") { push(dir, a, e.index); continue; }
      // M6 additionally requires displacement beyond the equal-length context.
      const n = e.index - a + 1;
      if (a - n < 0) continue;
      const here = Math.abs(net(s, a, e.index));
      const before = Math.abs(net(s, a - n, a - 1));
      if (here > before) push(dir, a, e.index);
    }
    return dedupe(out);
  }

  if (family === "M2_DISPLACEMENT") {
    for (const up of [true, false]) {
      for (const [a, b] of progressRuns(s, up)) {
        const n = b - a + 1;
        if (a - n < 0 || a < CTX) continue;
        const here = Math.abs(net(s, a, b));
        const before = Math.abs(net(s, a - n, a - 1));
        if (here > before) push(up ? "bullish" : "bearish", a, b);
      }
    }
    return dedupe(out);
  }

  if (family === "M3_DIRECTIONAL_RUN") {
    for (const up of [true, false]) {
      for (const [a, b] of progressRuns(s, up)) {
        const n = b - a + 1;
        if (a - n < 0 || a < CTX) continue;
        const here = efficiency(s, a, b), before = efficiency(s, a - n, a - 1);
        if (here !== null && before !== null && here > before) push(up ? "bullish" : "bearish", a, b);
      }
    }
    return dedupe(out);
  }

  if (family === "M4_FVG_CAUSAL") {
    const seen = new Set<number>();
    for (let k = CTX; k < s.length; k++) {
      for (const f of fvgsNear(s, k) as any[]) {
        if (seen.has(f.absIndex)) continue;
        seen.add(f.absIndex);
        const a = f.absIndex - 1;
        if (a < CTX) continue;
        const up = f.type === "bullish";
        // The move runs from the gap's first bar while progress continues.
        let b = f.absIndex + 1;
        while (b + 1 < s.length && (up ? s[b + 1].high > s[b].high : s[b + 1].low < s[b].low)) b++;
        push(up ? "bullish" : "bearish", a, b);
      }
    }
    return dedupe(out);
  }

  // M5: the departure that leaves a detected contraction. Context only — it
  // cannot be mandatory, because Ezzy explicitly trades without a contraction.
  for (const ep of contractionEpisodes) {
    let hi = -Infinity, lo = Infinity;
    for (let k = ep.start; k <= ep.end; k++) { hi = Math.max(hi, s[k].high); lo = Math.min(lo, s[k].low); }
    for (let k = ep.end + 1; k < Math.min(s.length, ep.end + 60); k++) {
      if (s[k].close > hi || s[k].close < lo) {
        const up = s[k].close > hi;
        let b = k;
        while (b + 1 < s.length && (up ? s[b + 1].high > s[b].high : s[b + 1].low < s[b].low)) b++;
        push(up ? "bullish" : "bearish", k, b);
        break;
      }
    }
  }
  return dedupe(out);
}

/** Collapses mechanically identical spans. No tuning against demonstrations. */
function dedupe(m: Move[]): Move[] {
  const seen = new Set<string>();
  return m.filter((x) => {
    const k = `${x.direction}|${x.spanStart}|${x.spanEnd}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.spanStart - b.spanStart);
}

/** Where the move is taken to BEGIN. The central variable. */
export function moveOnset(s: Candle[], m: Move, def: OnsetDef): number | null {
  const up = m.direction === "bullish";
  const a = m.spanStart, b = m.spanEnd;
  switch (def) {
    case "O6_SPAN_START":
      return a;
    case "O1_FIRST_DIRECTIONAL":
      for (let k = a; k <= b; k++) if (isUp(s[k]) === up) return k;
      return null;
    case "O2_FIRST_DISPLACEMENT": {
      for (let k = a; k <= b; k++) {
        const base = meanBodyOfIdx(s, activeContextIndices(s, k));
        if (base && isUp(s[k]) === up && body(s[k]) > base) return k;
      }
      return null;
    }
    case "O3_SUSTAINED_RUN_START":
      for (let k = a; k < b; k++) {
        if (isUp(s[k]) === up && isUp(s[k + 1]) === up) return k;
      }
      return null;
    case "O4_FIRST_FVG_SEQ": {
      for (let k = a; k <= b; k++) {
        const hit = (fvgsNear(s, k) as any[])
          .filter((f) => f.type === (up ? "bullish" : "bearish"))
          .filter((f) => f.absIndex >= a && f.absIndex <= b)
          .sort((x, y) => x.absIndex - y.absIndex)[0];
        if (hit) return Math.max(a, hit.absIndex - 1);
      }
      return null;
    }
    case "O5_BOS_CAUSAL_RUN": {
      let k = b;
      while (k - 1 >= a) {
        const prog = up ? s[k].high > s[k - 1].high : s[k].low < s[k - 1].low;
        if (!prog) break;
        k--;
      }
      return k;
    }
  }
}

/**
 * The frozen candle rule, applied to an independently detected onset.
 * Nothing about this function is new; it is LAST_OPPOSITE_BEFORE, bounded.
 */
export function ipoForMove(s: Candle[], m: Move, onset: number, maxBack = CTX * 4): number | null {
  const wantUp = m.direction === "bearish";     // bearish move -> last BULLISH candle
  for (let k = onset - 1; k >= Math.max(0, onset - maxBack); k--) {
    if (isUp(s[k]) === wantUp) return k;
  }
  return null;
}

// ─── PRE-REGISTERED RESEARCH HYPOTHESES ──────────────────────────────────────

/**
 * Frozen BEFORE any new demonstration was inspected, so that expanding the
 * sample cannot quietly become a search for whichever configuration fits it.
 *
 * Both recover the two directly inspectable STANDALONE IPOs exactly. They are
 * kept as a pair, unranked: M1 constrains the move by a confirmed structural
 * break and M2 does not, and BOS has NOT been shown to belong to Ezzy's
 * definition. Choosing between them is exactly what sample expansion is for.
 *
 * NOTHING HERE MAY CHANGE IN RESPONSE TO NEW LABELS.
 */
export const PREREGISTERED = {
  registeredOn: "2026-09-20",
  R1_PRECISION: {
    move: "M1_STRUCTURAL_BREAK" as MoveFamily,
    onset: "O4_FIRST_FVG_SEQ" as OnsetDef,
    ipo: "last opposite-colour candle immediately before the O4 onset",
    priorEvidence: "2/2 standalone exact; candidate density 3.5%/3.2%",
  },
  R2_BROAD: {
    move: "M2_DISPLACEMENT" as MoveFamily,
    onset: "O4_FIRST_FVG_SEQ" as OnsetDef,
    ipo: "last opposite-colour candle immediately before the O4 onset",
    priorEvidence: "2/2 standalone exact; candidate density 7.2%/5.3%",
  },
  note:
    "The 0.11% / 0.38% chance figures are DESCRIPTIVE ONLY. Candidate density " +
    "multiplied over two examples is not an inference: the observations are not " +
    "independent, both come from related 2020 material, and candidate occurrence " +
    "is temporally clustered.",
} as const;

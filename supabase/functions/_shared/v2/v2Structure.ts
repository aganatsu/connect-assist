// §0.6, §2.0 — v2Structure: the only structural source in V2.
// Swings are strict N=2 fractals inside one segment; each swing breaks at most once (first close strictly beyond).
// Break indices are computed over the whole series but every query filters by "≤ the last closed slot",
// so nothing is visible before the bar that produced it has closed.
import type { Series } from "./barStore.ts";

export type SwingKind = "H" | "L";
export interface Swing {
  i: number;          // swing bar slot
  kind: SwingKind;
  level: number;      // high (H) or low (L), points
  conf: number;       // confirmation slot i+2 (§0.6: exists from the close of i+2)
  seg: number;        // segment id
  breakIdx: number;   // slot of the single break event (§2.0b), -1 if none inside the segment
}

export interface StructureIndex {
  series: Series;
  swings: Swing[];             // ascending by i (a slot can hold both an H and an L swing)
}

export function buildStructure(s: Series): StructureIndex {
  const swings: Swing[] = [];
  const n = s.grid.length;
  for (let i = 2; i < n - 2; i++) {
    const b = s.bars[i];
    if (!b) continue;
    // five present bars in one segment (§0.6, §1.3a)
    if (s.bars[i + 2] === null || s.segStart[i + 2] > i - 2) continue;
    const nb = [s.bars[i - 2]!, s.bars[i - 1]!, s.bars[i + 1]!, s.bars[i + 2]!];
    if (nb.every((x) => b.h > x.h)) swings.push(mk(s, i, "H", b.h));
    if (nb.every((x) => b.l < x.l)) swings.push(mk(s, i, "L", b.l));
  }
  return { series: s, swings };
}

function mk(s: Series, i: number, kind: SwingKind, level: number): Swing {
  const seg = s.seg[i];
  let breakIdx = -1;
  for (let j = i + 3; j < s.grid.length; j++) {
    const b = s.bars[j];
    if (!b || s.seg[j] !== seg) break;      // §1.3a: never broken by a bar after a gap
    if (kind === "H" ? b.c > level : b.c < level) { breakIdx = j; break; }
  }
  return { i, kind, level, conf: i + 2, seg, breakIdx };
}

/** §2.0b swing is UNBROKEN at slot k (its break event, if any, lies after k). */
export function unbrokenAt(sw: Swing, k: number): boolean {
  return sw.breakIdx === -1 || sw.breakIdx > k;
}

export interface View {
  last: number;        // last closed slot L (current)
  seg: number;         // current segment id, -1 if L is MISSING or none
  from: number;        // first slot of the window ∩ current segment
}

/** Window (maximum lookback `w`) ∩ current segment at last closed slot L (§1.3a, §1.8, §2.0). */
export function view(s: Series, L: number, w: number): View {
  if (L < 0 || s.bars[L] === null) return { last: L, seg: -1, from: -1 };
  return { last: L, seg: s.seg[L], from: Math.max(L - w + 1, s.segStart[L]) };
}

/** §2.0d swings inside the view: all five bars inside it and confirmed by L. */
export function visibleSwings(ix: StructureIndex, v: View): Swing[] {
  if (v.seg < 0) return [];
  return ix.swings.filter((sw) => sw.seg === v.seg && sw.i - 2 >= v.from && sw.conf <= v.last);
}

/** §2.0d break events inside the view (swing visible, break bar ≤ L). */
export function visibleBreaks(ix: StructureIndex, v: View): Swing[] {
  return visibleSwings(ix, v).filter((sw) => sw.breakIdx !== -1 && sw.breakIdx <= v.last);
}

/** §2.0e the 1H swing record: every swing confirmed at or before slot L, in any segment. */
export function swingRecord(ix: StructureIndex, L: number): Swing[] {
  return ix.swings.filter((sw) => sw.conf <= L);
}

/**
 * §5.1 protected swing at 5m slot k for a setup whose 5m scope starts at slot `scopeFrom`
 * (first bar opening at or after the close of b; §2.0, PS): the most recent swing of `kind` whose swing bar
 * is in scope (its two left context bars may precede it; all five bars present and contiguous by construction),
 * confirmed at or before k−1 and UNBROKEN at k−1.
 */
export function protectedSwing(ix: StructureIndex, kind: SwingKind, scopeFrom: number, k: number): Swing | null {
  let best: Swing | null = null;
  for (const sw of ix.swings) {
    if (sw.kind !== kind || sw.i < scopeFrom || sw.conf > k - 1) continue;
    if (!unbrokenAt(sw, k - 1)) continue;
    if (!best || sw.i > best.i) best = sw;
  }
  return best;
}

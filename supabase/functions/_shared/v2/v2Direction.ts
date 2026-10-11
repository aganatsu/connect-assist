// §2.1 D1′ and §1.8 — direction from v2Structure 1H bias and 15m veto. No 5m term.
import { lastClosed, type Series } from "./barStore.ts";
import { VETO_BARS_15M, WINDOW_15M, WINDOW_1H } from "./spec.ts";
import { type StructureIndex, view, visibleBreaks } from "./v2Structure.ts";

export type Dir = "LONG" | "SHORT";
export type DirectionStatus = "OK" | "BIAS_NONE" | "VETOED" | "NOT_COMPUTABLE";
export interface Direction { dir: Dir | "NONE"; status: DirectionStatus; bias: Dir | "NONE" }

export function direction(s1h: Series, ix1h: StructureIndex, s15: Series, ix15: StructureIndex, t: number): Direction {
  const L1 = lastClosed(s1h.grid, s1h.step, t);
  const L15 = lastClosed(s15.grid, s15.step, t);
  const v1 = view(s1h, L1, WINDOW_1H);
  const v15 = view(s15, L15, WINDOW_15M);
  // §1.8: no current 1H or 15m segment → NOT COMPUTABLE
  if (v1.seg < 0 || v15.seg < 0) return { dir: "NONE", status: "NOT_COMPUTABLE", bias: "NONE" };

  // §1.8 15m veto computability: its 10 most recent closed intervals inside the current segment, and when the
  // segment is shorter than the 96-bar window, at least one break event inside the segment.
  const breaks15 = visibleBreaks(ix15, v15);
  const vetoFrom = L15 - VETO_BARS_15M + 1;
  if (s15.segStart[L15] > vetoFrom) return { dir: "NONE", status: "NOT_COMPUTABLE", bias: "NONE" };
  const shortSegment = s15.segStart[L15] > L15 - WINDOW_15M + 1;
  if (shortSegment && breaks15.length === 0) return { dir: "NONE", status: "NOT_COMPUTABLE", bias: "NONE" };

  // §2.1a bias = direction of the most recent 1H break event in the current segment within the window
  const breaks1 = visibleBreaks(ix1h, v1);
  if (breaks1.length === 0) return { dir: "NONE", status: "BIAS_NONE", bias: "NONE" };
  let latest = breaks1[0];
  for (const b of breaks1) if (b.breakIdx > latest.breakIdx) latest = b;
  const bias: Dir = latest.kind === "H" ? "LONG" : "SHORT";
  for (const b of breaks1) {
    if (b.breakIdx === latest.breakIdx && b.kind !== latest.kind) {
      throw new Error("one 1H bar broke both a swing high and a swing low (impossible under §2.0b)");
    }
  }

  // §2.1b 15m veto: an opposite 15m break event on one of the 10 most recent closed 15m bars
  const opposite = bias === "LONG" ? "L" : "H";
  const vetoed = breaks15.some((b) => b.kind === opposite && b.breakIdx >= vetoFrom && b.breakIdx <= L15);
  if (vetoed) return { dir: "NONE", status: "VETOED", bias };
  return { dir: bias, status: "OK", bias };
}

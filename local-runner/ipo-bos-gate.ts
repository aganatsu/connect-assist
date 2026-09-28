/**
 * IPO_BOS_REQUIRED_V1 — the single experimental rule, isolated. PURE.
 *
 * Kept in its own module so harnesses can import it WITHOUT executing an
 * experiment. The first version of this lived in the experiment script, whose
 * body runs at import time; importing the gate silently re-ran the entire
 * 12-window corpus and made every equivalence check look pathologically slow.
 *
 * BOS DEFINITION — the repository's existing detector, not a new one.
 * `analyzeMarketStructure` walks swing-to-swing events and records a break only
 * when `breakCandle.close` is beyond the prior structural level; a wick that
 * fails to close through is classified as a sweep instead. It separates
 * continuation (`bos`) from reversal (`choch`), and this experiment accepts
 * ONLY `bos` — CHoCH does not substitute, per the pre-registration.
 *
 * KNOWN LIMITATION, stated rather than hidden: that detector is swing-to-swing
 * and is documented to miss some close-throughs. The instruction was to use the
 * existing causal detector rather than invent a second definition, so the
 * experiment inherits its recall. A stricter detector is a different hypothesis.
 *
 * CAUSALITY. Structure is recomputed on the prefix handed in, which the engine
 * supplies as the closed bars STRICTLY BEFORE the touch bar. Swing confirmation
 * needs bars after a pivot, so a pivot only becomes visible once the prefix
 * contains them — recomputing makes that automatic rather than assumed. No
 * future BOS can qualify an IPO, and a refusal is final: a BOS confirming later
 * cannot resurrect an entry that was missed.
 */

import { analyzeMarketStructure, type Candle } from "../supabase/functions/_shared/smcAnalysis.ts";

export interface BosFind { index: number; type: "bullish" | "bearish" }

/**
 * The latest direction-matching, close-confirmed BOS strictly after the IPO
 * origin, as knowable from `barsBefore`. Null when none.
 *
 * demand (bullish IPO) requires a BULLISH bos; supply requires BEARISH.
 */
export function bosAfterOrigin(
  barsBefore: Candle[], ipoIndex: number, direction: "demand" | "supply",
): BosFind | null {
  if (barsBefore.length < 3) return null;
  const want = direction === "demand" ? "bullish" : "bearish";
  const st = analyzeMarketStructure(barsBefore);
  let best: BosFind | null = null;
  for (const b of st.bos) {
    if (b.type !== want) continue;
    if (b.index <= ipoIndex) continue;      // must come AFTER the origin
    if (!best || b.index > best.index) best = { index: b.index, type: b.type };
  }
  return best;
}

/** The gate as the engine consumes it. */
export const bosEntryGate = (g: {
  barsBefore: Candle[]; ipoIndex: number; direction: "demand" | "supply";
}) => bosAfterOrigin(g.barsBefore, g.ipoIndex, g.direction) !== null;

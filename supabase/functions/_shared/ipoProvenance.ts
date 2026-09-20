/**
 * Where every IPO rule came from.
 *
 * WHY THIS FILE EXISTS. The detector mixes two very different kinds of rule.
 * Some are the method as taught — an IPO must eventually break structure, the
 * zone is the proximal half of the candle. Others are numbers nobody ever
 * stated: two intervening candles, 0.75 ATR, a twelve-bar lookback, launch
 * offsets of 0-3. Both kinds sit in the same DEFAULTS object and both produce
 * the same confident-looking output, so a reader cannot tell which parts of a
 * result are the method and which are our scaffolding.
 *
 * That distinction decides what is allowed to change. A taught rule that
 * disagrees with the data is a finding. An operational rule that disagrees with
 * the data is probably just the wrong number — but it may only be changed with
 * the overfitting discipline that applies to any free parameter, which is
 * exactly why it must be visible rather than buried.
 *
 * HOW TO READ evidenceSource:
 *
 *   DIRECT_TEACHING             stated as part of the method
 *   USER_CONFIRMED              confirmed in review, often as a correction
 *   VIDEO_DEMONSTRATION         shown on a chart; used for corpus examples
 *   OPERATIONAL_INTERPRETATION  ours. A choice made so code could run
 *
 * ATTRIBUTION IS A CLAIM, NOT A FACT. These labels record what this project
 * believes about each rule's origin. Where a rule is marked USER_CONFIRMED or
 * DIRECT_TEACHING the intent is that a specific statement backs it; where that
 * is wrong the label is wrong and should be corrected here rather than argued
 * around in the consuming code. When in doubt a rule is marked
 * OPERATIONAL_INTERPRETATION, because over-claiming provenance is the more
 * damaging error: it makes our own guess look like the method.
 *
 * Nothing here executes. It is a manifest attached to research output.
 */

export type EvidenceSource =
  | "DIRECT_TEACHING"
  | "USER_CONFIRMED"
  | "VIDEO_DEMONSTRATION"
  | "OPERATIONAL_INTERPRETATION";

export const EVIDENCE_SOURCES: EvidenceSource[] = [
  "DIRECT_TEACHING",
  "USER_CONFIRMED",
  "VIDEO_DEMONSTRATION",
  "OPERATIONAL_INTERPRETATION",
];

export interface RuleProvenance {
  /** Stable key. Inventory entries cite these. */
  key: string;
  /** What the rule actually is, in one line. */
  rule: string;
  /** The parameter value where the rule is numeric, else null. */
  value: number | string | boolean | null;
  evidenceSource: EvidenceSource;
  /** Why it carries that label, and what is at stake if it is wrong. */
  note: string;
}

const P = (
  key: string,
  rule: string,
  value: RuleProvenance["value"],
  evidenceSource: EvidenceSource,
  note: string,
): RuleProvenance => ({ key, rule, value, evidenceSource, note });

export const IPO_RULE_PROVENANCE: RuleProvenance[] = [
  // ── geometry ───────────────────────────────────────────────────────────────
  P("geometry.singleCandle",
    "The zone is drawn from ONE candle, not a range of candles",
    null, "USER_CONFIRMED",
    "Frozen in review. Every alternative geometry proposal has been declined."),
  P("geometry.proximalHalf",
    "The zone is the proximal HALF: demand [midpoint, high], supply [low, midpoint]",
    null, "USER_CONFIRMED",
    "Corrected in review after an earlier draft anchored on the extent instead."),
  P("geometry.distalIsMidpointOfFullWickRange",
    "Distal is the midpoint of the full wick range, not of the body",
    null, "USER_CONFIRMED", "Stated explicitly; wick range, not body range."),
  P("geometry.extentIsInvalidationOnly",
    "Extent is the far wick and is an invalidation level only, never a zone edge",
    null, "USER_CONFIRMED",
    "A zone reaching the extent would be the whole candle, which is the thing this geometry rejects."),

  // ── structure ──────────────────────────────────────────────────────────────
  P("structure.breakRequired",
    "An IPO must eventually produce a candle-close break of structure",
    null, "DIRECT_TEACHING",
    "The defining requirement. Everything else here only decides how it is measured."),
  P("structure.ledgerIsTheGate",
    "The factual close-through ledger gates confirmation; BOS/CHoCH only classify it",
    null, "OPERATIONAL_INTERPRETATION",
    "Ours. Measured earlier: 39-47% of factual close-throughs emit no policy event, so gating on BOS/CHoCH would have discarded them."),
  P("structure.maxEventAgeBars",
    "No age cap on structure events in research mode",
    null, "OPERATIONAL_INTERPRETATION",
    "Ours. The live shadow uses 50 bars; the reference boxes are months old, so a cap would suppress the very events under study."),
  P("confirmation.departedByBreakBar",
    "A confirming break requires the zone to have been departed by the break bar",
    null, "OPERATIONAL_INTERPRETATION",
    "Ours. The teaching says the move breaks structure; that the zone must be left FIRST is our reading of what makes the break that zone's."),
  P("confirmation.sameBarUnverifiable",
    "Departure and break on one bar is kept, but labelled SAME_BAR_UNVERIFIABLE",
    null, "OPERATIONAL_INTERPRETATION",
    "Ours. OHLC cannot order two events inside one bar, so the case is preserved and flagged rather than counted as proven or thrown away."),

  // ── invalidation and lifecycle ─────────────────────────────────────────────
  P("invalidation.singleCloseBeyondExtent",
    "ONE candle close fully beyond the extent invalidates; wicks never do",
    null, "USER_CONFIRMED",
    "Corrected in review against the existing V2 order-block rule, which requires two consecutive closes."),
  P("lifecycle.distinctVisitCounting",
    "A test is one distinct VISIT to the zone, not one per bar inside it",
    null, "USER_CONFIRMED",
    "Corrected in review; the existing ob.touches counter increments per bar and would have inflated every test count."),
  P("lifecycle.flipGatedOnBroken",
    "A flip retest can only be recorded after the zone is BROKEN",
    null, "USER_CONFIRMED",
    "Corrected in review; the legacy 'mitigated' state must not decide a flip."),
  P("lifecycle.armOnlyAfterDeparture",
    "A retest counts only once price has left the zone on the departure side",
    null, "OPERATIONAL_INTERPRETATION",
    "Ours. Without it the bars immediately after the IPO read as retests of a zone price never left."),
  P("lifecycle.horizonBars",
    "Lifecycle replay horizon", 200, "OPERATIONAL_INTERPRETATION",
    "Ours, and arbitrary. A zone still live at bar 201 is reported as it stood at bar 200."),

  // ── coexistence and refinement ─────────────────────────────────────────────
  P("coexistence.multipleIPOsCoexist",
    "Several IPOs can be valid on one chart at the same time",
    null, "USER_CONFIRMED",
    "Stated directly. It is why this layer is an inventory and not a selector, and why no zone is called a false positive for coexisting with another."),
  P("refinement.parentStaysValid",
    "A higher-timeframe IPO remains valid as CONTEXT after a child refines it",
    null, "USER_CONFIRMED",
    "Stated directly. Finding a child must never invalidate the parent."),
  P("refinement.containmentIsFull",
    "A child must sit FULLY inside the parent zone; overlap is not refinement",
    null, "USER_CONFIRMED", "Corrected in review against an overlap test."),
  P("refinement.childNotBeforeParent",
    "A child candle cannot predate its parent candle",
    null, "OPERATIONAL_INTERPRETATION",
    "Ours. Geometrically nesting inside a zone that did not yet exist is not refinement, but the rule was never stated."),
  P("refinement.ambiguityUnresolved",
    "When several HTF IPOs validly contain a child, lineage is left undecided",
    null, "OPERATIONAL_INTERPRETATION",
    "Ours, and deliberately incomplete. Nearest-parent and narrowest-parent are both plausible and neither is taught, so neither is applied."),

  // ── candle selection: ALL OURS ─────────────────────────────────────────────
  P("selection.maxInterveningCandles",
    "Candles allowed between the IPO and the start of the departure move",
    2, "OPERATIONAL_INTERPRETATION",
    "Ours. The tolerance is an interpretation of 'a small candle or two may drift before the move'; the number 2 is not taught."),
  P("selection.interveningMaxRangeAtr",
    "An intervening candle must be smaller than this multiple of ATR",
    0.75, "OPERATIONAL_INTERPRETATION",
    "Ours. Prevents a full-bodied candle being skipped, but 0.75 is a chosen number."),
  P("selection.maxLookbackForIPO",
    "How far back from the departure origin the IPO candle may sit",
    12, "OPERATIONAL_INTERPRETATION",
    "Ours. Directly bounds which candles can ever be selected."),
  P("selection.departureBarExempt",
    "The departure bar itself is exempt from the intervening budget",
    null, "OPERATIONAL_INTERPRETATION",
    "Ours. Added because the departure bar is by definition the wrong colour for the zone."),
  P("origin.anchorSet",
    "Origin anchors considered: ABSOLUTE_EXTREME, INTERNAL_SWING, EXTERNAL_SWING",
    "3 anchors", "OPERATIONAL_INTERPRETATION",
    "Ours. A research instrument for measuring reachability, not a taught procedure."),
  P("origin.launchOffsets",
    "Launch offsets swept from each anchor", "0..3", "OPERATIONAL_INTERPRETATION",
    "Ours. Widening the sweep mechanically raises recovery and candidate count together."),

  // ── context measurements, none of which gate anything ──────────────────────
  P("liquidity.grabContext",
    "A liquidity grab before the IPO is meaningful context",
    null, "DIRECT_TEACHING",
    "Taught as part of the setup. Measured and reported here; it gates nothing, because no threshold for it is taught."),
  P("liquidity.priorRangeWindow",
    "Bars used for the prior-range liquidity reference", 10, "OPERATIONAL_INTERPRETATION",
    "Ours. Changes which sweeps count as 'prior'."),
  P("fvg.departureCreatesGap",
    "The departure move typically leaves a fair value gap",
    null, "DIRECT_TEACHING", "Taught as a characteristic. Reported, never required."),
  P("fvg.withinBars",
    "Bars after the IPO in which an FVG counts as the departure FVG",
    3, "OPERATIONAL_INTERPRETATION",
    "Ours. Decides which gap is called the departure FVG; a wider window would attribute later, unrelated gaps to the zone."),
  P("consolidation.notInsideConsolidation",
    "An IPO formed inside consolidation is not a valid IPO",
    null, "DIRECT_TEACHING",
    "TAUGHT BUT UNIMPLEMENTED. The predicate built for it produced 5-13 ATR 'ranges' with zero boundary interaction, so it was retired. Status is UNRESOLVED everywhere: the rule is not abandoned, it is unmeasured."),
];

export const PROVENANCE_BY_KEY: Record<string, RuleProvenance> = Object.fromEntries(
  IPO_RULE_PROVENANCE.map((p) => [p.key, p]),
);

/** Keys that shaped a detected zone, in the order they apply. */
export const DETECTION_RULE_KEYS: string[] = [
  "geometry.singleCandle",
  "geometry.proximalHalf",
  "geometry.distalIsMidpointOfFullWickRange",
  "geometry.extentIsInvalidationOnly",
  "structure.breakRequired",
  "structure.ledgerIsTheGate",
  "structure.maxEventAgeBars",
  "selection.maxInterveningCandles",
  "selection.interveningMaxRangeAtr",
  "selection.maxLookbackForIPO",
  "selection.departureBarExempt",
  "invalidation.singleCloseBeyondExtent",
  "lifecycle.armOnlyAfterDeparture",
  "lifecycle.distinctVisitCounting",
  "lifecycle.flipGatedOnBroken",
  "lifecycle.horizonBars",
  "liquidity.grabContext",
  "liquidity.priorRangeWindow",
  "fvg.departureCreatesGap",
  "fvg.withinBars",
  "consolidation.notInsideConsolidation",
  "confirmation.departedByBreakBar",
  "confirmation.sameBarUnverifiable",
  "coexistence.multipleIPOsCoexist",
];

export function provenanceManifest(keys: string[] = DETECTION_RULE_KEYS) {
  const rules = keys.map((k) => PROVENANCE_BY_KEY[k]).filter(Boolean);
  const by = (s: EvidenceSource) => rules.filter((r) => r.evidenceSource === s);
  const operational = by("OPERATIONAL_INTERPRETATION");
  return {
    attributionBasis:
      "This project's record of each rule's origin, not an external citation. " +
      "Correct a wrong label here rather than working around it downstream.",
    counts: Object.fromEntries(EVIDENCE_SOURCES.map((s) => [s, by(s).length])),
    /** The headline a reader needs: how much of this output is ours. */
    operationalRuleCount: operational.length,
    operationalRuleKeys: operational.map((r) => r.key),
    freeParameters: operational
      .filter((r) => r.value !== null)
      .map((r) => ({ key: r.key, value: r.value })),
    rules,
  };
}

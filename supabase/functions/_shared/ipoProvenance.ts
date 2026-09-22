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

/**
 * How far a demonstration can still be re-checked against its own source.
 *
 * This is orthogonal to EvidenceSource. That says WHAT KIND of claim a row is;
 * this says WHETHER ANYONE CAN GO LOOK. A VIDEO_DEMONSTRATION whose file no
 * longer exists is still a video demonstration, but nothing can be verified
 * against it, and a rule must never be proposed from one.
 */
export type ConfidenceTier =
  | "TIER_1_DIRECTLY_INSPECTABLE"
  | "TIER_2_DERIVED_FROM_INSPECTABLE_SOURCE"
  | "TIER_3_UNINSPECTABLE_LEGACY";

export const CONFIDENCE_TIERS: ConfidenceTier[] = [
  "TIER_1_DIRECTLY_INSPECTABLE",
  "TIER_2_DERIVED_FROM_INSPECTABLE_SOURCE",
  "TIER_3_UNINSPECTABLE_LEGACY",
];

/**
 * Who the demonstration came from.
 *
 * WHY THIS IS NOT DERIVABLE FROM evidence_source. Both an Ezzy video row and
 * the user's own independently judged row can be VIDEO_DEMONSTRATION or
 * USER_CONFIRMED, and conflating them would let one teacher's material be
 * silently padded with the user's own trading judgments — an error already made
 * once and explicitly corrected.
 *
 * TUBEPULL_UNKNOWN_SOURCE is kept as its own family rather than folded into
 * "unattributed": the material exists and is usable, but it has NOT been shown
 * to come from the same teacher, so it must never be pooled with EZZY when
 * validating or invalidating Ezzy's rules.
 *
 * NULL means NOT YET ATTRIBUTED. It must never be read as "probably Ezzy".
 */
export type SourceFamily = "EZZY" | "TUBEPULL_UNKNOWN_SOURCE" | "USER_INDEPENDENT";

export const SOURCE_FAMILIES: SourceFamily[] = [
  "EZZY",
  "TUBEPULL_UNKNOWN_SOURCE",
  "USER_INDEPENDENT",
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
  // ── contraction, from "Trade with no Contraction" ──────────────────────────
  // Full transcript on disk (59:54, one speaker). Timestamps are the
  // transcript's own. This video is the ONLY source that defines contraction
  // positively rather than by example.
  P("contraction.trendStopsAndLevelsRepeat",
    "A contraction begins when a higher-high/higher-low sequence STOPS, and shows equal highs and equal lows inside it",
    null, "DIRECT_TEACHING",
    "07:15-07:43 verbatim: 'the market was in this huge contraction, so we had equal highs " +
    "and equal lows inside of this contraction, plus ... initially we was kind of doing the " +
    "higher highs and higher lows, and then we stopped. The moment we stop, we enter in a " +
    "contraction mode ... That's how you start to identifying major contraction zones'."),
  P("contraction.lowVolumeAndSideways",
    "Low volume / low liquidity and a sideways move are signs of contraction",
    null, "DIRECT_TEACHING",
    "17:34-17:47 verbatim: 'We got low volume, okay? So this is a good sign of a contraction. " +
    "We do have equal highs and equal lows inside of contraction. More like a sideway move. " +
    "That's what I look for'. Also 29:42-29:47: 'on the 30 minutes you can see the contraction. " +
    "A sideway contraction, but you can still see the low liquidity'."),
  P("contraction.doNotTakeIposFromInsideIt",
    "IPOs are NOT taken from inside a contraction",
    null, "DIRECT_TEACHING",
    "15:52-16:21 verbatim: 'we do have an IPO there, but the IPO inside of a contraction, I " +
    "don't like it. I don't look for bounce and up inside of a contraction. It could happen, " +
    "but I don't like it. Usually I don't get IPOs from the contraction, okay? I get the break " +
    "and retest, but not the first touch.' THIS BOUNDS THE CONTRACTION-SCOPED SEARCH: the " +
    "contraction is identified first as CONTEXT, but the IPO is sourced from outside it. " +
    "Consistent with the measured finding that the labelled IPO sat BEFORE its contraction."),
  P("contraction.mustBeClearedOut",
    "An uncleared contraction is unfinished business and becomes a target",
    null, "DIRECT_TEACHING",
    "15:41-15:49: 'we should expect a little bit of reversal, but not fully because we still " +
    "have this contraction to clear it out'. 16:37-16:57 explains the mechanism: 'if you were " +
    "buying inside of this contraction ... this would've hit your stop loss, taking every " +
    "buyers and sellers from that small contraction'. 57:43-57:52: 'this contraction hasn't " +
    "been cleared, so pushing to this level we would've cleared this higher high'."),
  P("contraction.fiftyPercentOfTheBoxIsATarget",
    "Price often reverses at 50% of the CONTRACTION BOX — distinct from 50% of the IPO candle",
    null, "DIRECT_TEACHING",
    "55:37-56:09 verbatim: 'we only came to the fifty percent of the contraction box. So if " +
    "you take the higher part and the lower part, you can see that we came back to the fifty " +
    "percent of the contraction box.' HE CONTRADICTS HIMSELF ON FREQUENCY in the same breath: " +
    "'A lot of times that happens, but that's really rare. I would say eight out of 10 or " +
    "seven out of 10, it could just go to the 50% and reverse.' At 59:22-59:37 he calls it " +
    "'a rare situation'. Recorded unresolved rather than tidied."),
  P("contraction.nearTrendLineSignalsBreak",
    "A contraction forming close to the trend line is a sign the trend line will break",
    null, "DIRECT_TEACHING",
    "36:11-36:22 verbatim: 'when you have a contraction so close to the trend line, it's a " +
    "sign that it will break'. Contrasted at 36:28-37:22 with touches that had 'no contraction " +
    "close to it'."),
  P("contraction.stopSitsBeyondTheBoxAndTheIpo",
    "The stop goes beyond the whole contraction box, which is also beyond the IPO used",
    null, "DIRECT_TEACHING",
    "39:03-39:26 verbatim: 'my stop loss was above the entire contraction box, meaning above " +
    "the IPO that I used ... my stop loss is always above the IPO that I'm using' and 'I put " +
    "my stop loss on this IPO below the contraction box'."),
  P("contraction.zoneTrappedBetweenTwoIpos",
    "A contraction sits between an IPO above and an IPO below",
    null, "DIRECT_TEACHING",
    "19:15-19:28 verbatim: 'we're in a contraction. I got the zone is where the market's " +
    "consolidating above. This zone is where the market's consolidating below. So the zone is " +
    "trapped between two IPOs — a break and retest and a small timeframe IPO'."),
  P("contraction.sessionGatesTheSetup",
    "A contraction that ends outside the London or New York session is not traded",
    null, "DIRECT_TEACHING",
    "48:49-49:52 verbatim: 'one key thing that we don't have here is the fact that the " +
    "contraction happened at the end of New York time, and we don't trade outside of the green " +
    "or red. So if we're not inside of the green or red, we don't trade it.' NOTE: this is an " +
    "ENTRY filter, not part of the contraction definition — he still calls it a contraction."),

  // ── origin, from the same transcript ───────────────────────────────────────
  P("origin.lastCandleBeforeTheMoveBothDirections",
    "IPO = last candle UP before a down move, or last candle DOWN before an up move",
    null, "DIRECT_TEACHING",
    "08:44-08:58: 'you see this one candle up before the down move ... There's an IPO at last " +
    "candle up before the down move.' 11:46-11:58: 'this is the last candle down before this " +
    "expansion to the upside. So this is automatically an IPO.' Repeated at 12:04, 12:19, " +
    "32:18, 45:41, 51:02, 53:55. The most consistently repeated statement in the video."),
  P("origin.zoneIsWickAndBody",
    "The zone is drawn from the wick and body of that one candle",
    null, "DIRECT_TEACHING",
    "12:04-12:27 verbatim: 'If you put a zone there, this is the wick connected to the body, " +
    "you see a reversal' and 'If you use the wick and body, you can see that there's a " +
    "reversal'. 35:01-35:07: 'I went ahead to the four hours and zoomed in and took this one " +
    "candle ... one candle took wick and body for the break and retest'. Supports the frozen " +
    "single-candle, full-wick-range geometry."),
  P("origin.breakAndRetestValidatesTheIpo",
    "An IPO is confirmed by being broken and then retested",
    null, "DIRECT_TEACHING",
    "09:08-09:21 verbatim: 'we had this reversal confirm me that this IPO is a break, it's " +
    "valid. So ... if a break happens, I would count on a retest.' 53:09-53:16: 'IPOs, notice " +
    "that it's either it's break and retest, break and retest.' 54:24-54:27: 'whenever tested " +
    "once, I know for a fact that's the zone.'"),
  P("geometry.fiftyPercentAcrossTimeframes",
    "50% of the candle is taken on the higher timeframe and the lower timeframes agree with it",
    null, "DIRECT_TEACHING",
    "13:07-13:57 verbatim: 'if you go to the daily, you take the 50% of the entire candle ... " +
    "You can even get a more precise zone ... 50% of the daily, and then the four hours, you " +
    "got the break and retest ... That's the 50%. If you wanna use this one, it's the 50% " +
    "also. So every timeframe connects.' Note 'the ENTIRE candle' — wick range, not body. At " +
    "44:04-44:22 he offers 50% of the body as a lower-accuracy alternative: 'either one, body " +
    "or wick'."),
  P("refinement.dropDownOnlyUntilCandlesGetChoppy",
    "Refine to a lower timeframe for precision, but stop when the candles become small/choppy",
    null, "DIRECT_TEACHING",
    "13:33-13:44 verbatim: 'If you wanna make it more precise, you can even check the two " +
    "hours, see how it looks. If it gives you a lot of small candles, don't go for it. Go for " +
    "a higher timeframe so you have more accurate candle.' A STOPPING RULE for refinement, " +
    "which the earlier HTF->LTF teaching did not supply."),

  // ── market phases ──────────────────────────────────────────────────────────
  // Verbatim from the transcript of "Forex & Crypto Manipulation Exposed by 21
  // Year Old Trading Genius" (a Trading Nut interview; the speaker names himself
  // "easy100k"/ezzy100k, i.e. Eli Semedo). The file is on disk, so unlike the
  // earlier confidence-tier audit these do not live only in a chat log.
  //
  // NONE of these are wired to the detector. They are recorded because they
  // describe a DIFFERENT framing from the swing-to-break leg the research code
  // uses, and that difference is the open question.
  P("phase.contractionIsFoundFirst",
    "Find the contraction zone first; the IPO search happens inside that phase",
    null, "DIRECT_TEACHING",
    "Transcript 00:48-01:05, verbatim: 'basically what i look for is the first thing " +
    "is to find a contraction zone which is the one in purple ... whenever i identify " +
    "the contraction phase i try to find something we call ipos'. NOTE THE ORDER: the " +
    "contraction is located BEFORE any IPO is looked for, so it scopes the search. " +
    "Our research code instead searches a swing-to-break structural leg, which is not " +
    "the same window and is not derived from anything he says."),
  P("phase.expansionThenTrend",
    "Contraction -> expansion out of the box -> trend",
    null, "DIRECT_TEACHING",
    "Transcript 01:27-01:48, verbatim: 'usually market has these two cycles the first " +
    "one is the contraction ... what usually market do is it expands outside the " +
    "contraction box which is the first move the expansion and then it goes into a trend'."),
  P("phase.manipulationVariant",
    "Contraction -> manipulation -> trend, as an alternative to plain expansion",
    null, "DIRECT_TEACHING",
    "Transcript 01:48-02:02, verbatim: 'the second scenario is when the market's in a " +
    "contraction phase right, instead of doing expansion it does something what we call " +
    "the manipulation and then it does the contraction and then it does the trend'. " +
    "AS SPOKEN it reads manipulation -> contraction -> trend; at 05:52 he describes the " +
    "same pattern as 'manipulation expansion and trend to the upside'. Recorded with the " +
    "inconsistency intact rather than tidied into one reading."),
  P("phase.purposeIsStopHunting",
    "The manipulation exists to stop out both sides before the trend",
    null, "DIRECT_TEACHING",
    "Transcript 02:02-02:29, verbatim: 'people that are trading support and resistance " +
    "inside the contraction phase they are going to get stopped out before the market " +
    "gets to a trend so the market pushes up clear the liquidity on the upper side and " +
    "then it pushes down clear the liquidity on the downside ... they take everybody out " +
    "then they continue to trend'."),
  P("phase.trendCoversTheContractionBox",
    "The trend usually travels beyond the far side of the contraction box",
    null, "DIRECT_TEACHING",
    "Transcript 02:59-03:09, verbatim: 'whenever it expands the trend most of the times " +
    "goes below the contraction box', and 05:28-05:38: 'my take profit is below the " +
    "contraction box ... whenever it expands it trends it will cover the lower level of " +
    "the box'. This is a TARGET rule, not an origin rule."),

  // ── origin, as taught in the same transcript ───────────────────────────────
  P("origin.leftBehindBeforeTheMove",
    "The IPO is a candle the market leaves behind before it makes the move",
    null, "DIRECT_TEACHING",
    "Transcript 01:02-01:16, verbatim: 'i try to find something we call ipos which " +
    "basically is a candle where the market, before the market does the move, it leaves " +
    "a candle behind, which we take as a reference for our entries'. THE MOVE IS THE ONE " +
    "IT IMMEDIATELY PRECEDES. Nothing here refers to a structural break, so selecting the " +
    "origin from a break-producing phase is our proxy, not his rule."),
  P("origin.contractionExpandsToTheIpo",
    "After contraction, price expands TO the IPO, and then trends",
    null, "DIRECT_TEACHING",
    "Transcript 03:27-03:36, verbatim: 'same thing happen here the contraction expands to " +
    "the ipo which is the candle that you know we look for and then it trends to the " +
    "downside'. The IPO is the DESTINATION of the expansion and the reference for entry — " +
    "it is left behind earlier and revisited, not created by the expansion."),
  P("origin.institutionalCandle",
    "The IPO is the 'institutional candle' and its size sets the zone and the stop",
    null, "DIRECT_TEACHING",
    "Transcript 04:46-05:03, verbatim: 'my stop-loss is according to the size of the box " +
    "and the size of the box it really depends on the size of the ipo which is the " +
    "institutional candle, sign to enter the market'."),
  P("geometry.ipoFiftyPercentIsTheReversal",
    "50% of the IPO candle is where price is expected to reverse",
    null, "DIRECT_TEACHING",
    "Transcript 05:17-05:26, verbatim: 'right here 50 of the candle that's where the " +
    "market will reverse'. On the BTC/USD 1h chart a fib is anchored across one candle " +
    "with the 0.5 line drawn in red and labelled 'PREVIOUS IPO 50%'; measured at " +
    "y=466.0 against level-1 y=380.5 and level-0 y=551.5, i.e. the exact midpoint. " +
    "CONSISTENT WITH our frozen geometry.distalIsMidpointOfFullWickRange and " +
    "geometry.proximalHalf. CAVEAT: that the fib's endpoints are the candle's own high " +
    "and low is a VISUAL reading — overlapping drawn objects defeated pixel measurement " +
    "of the candle itself, so the confirmation is strong but not measured end to end."),

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
  P("refinement.sameDirection",
    "A refined child IPO must have the same direction as its parent IPO",
    null, "USER_CONFIRMED",
    "Confirmed in review. HTF demand refines to LTF demand, HTF supply to LTF supply. An opposite-direction IPO may well exist inside the parent zone — it is simply not that parent's refinement or execution child. The rule was already enforced in resolveParentLineage as an unstated implementation assumption; it is declared here so it can be reviewed rather than discovered by reading the filter."),
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

  // ── the origin rule as literally stated on screen ─────────────────────────
  //
  // Observed in "smart money part 1" as an on-screen list and as two chart
  // annotations. This is the first DIRECT_TEACHING evidence this project has
  // for ORIGIN SELECTION specifically — everything else in that area was
  // OPERATIONAL_INTERPRETATION.
  P("origin.lastOppositeBeforeMajorMove",
    "The origin is the last opposite-colour candle before the major move: the last " +
    "bullish candle before a drop, the last bearish candle before a push up",
    null, "DIRECT_TEACHING",
    "Stated twice within ONE source, 'smart money part 1'. On-screen rules list: 'Last " +
    "candle before major move'. Chart annotations: 'Last Bullish before the big drop' and " +
    "'last bearish candle before the big push up'. Note what it does NOT say: nothing " +
    "about the swing extreme, the largest candle, or the strongest displacement. " +
    "SCOPE: this is one teacher's stated rule. It has NOT been shown to hold for material " +
    "from other creators, and that video contains no dated demonstrations to test it on."),
  P("refinement.findOnHtfWorkOnLtf",
    "Find your zones on a bigger timeframe, then work THAT zone on a lower timeframe",
    null, "DIRECT_TEACHING",
    "On-screen tip in Smart money part 2 at 03:00-04:00, verbatim: 'TIP: FIND YOUR " +
    "ZONES ON A BIGGER TIME FRAME AND THEN WORK THAT ZONE ON A LOWER TIME FRAME'. " +
    "Note the definite article — THAT zone, singular. It says the HTF zone is carried " +
    "down and worked, not that a new zone is found on the lower timeframe. Two " +
    "independent pixel measurements agree: on 2020-05-11 the 1h box matched the 4H " +
    "zone rather than any 1h candle, and on 2020-04-20 the 8h zone matched the DAILY " +
    "candle's own geometry. INTERPRETATION BOUNDARY: this confirms only that HTF zones " +
    "are CARRIED DOWN to lower timeframes. It does NOT license inferring that each " +
    "lower timeframe creates a new refinement child — the one observed case where a " +
    "zone genuinely narrowed (daily 2020-05-11 to 4H 2020-05-11 16:00) remains " +
    "unvalidated at n=1, and repeated display of the same box must never be counted " +
    "as a second example."),
  P("origin.candleThatTookPeopleOut",
    "The origin candle is the one that 'took people out'",
    null, "DIRECT_TEACHING",
    "From the same on-screen rules list. AMBIGUOUS AS STATED and deliberately left so: " +
    "it could mean a sweep of prior highs/lows, a wick through liquidity that closes " +
    "back, an engulfing of the previous candle, or removal of an immediate short-term " +
    "extreme. It must not be assumed to mean the swing extreme — the detector already " +
    "prefers extreme and sweep bars and that is precisely where it disagrees with the " +
    "demonstrations."),
  P("origin.mustBreakStructure",
    "The setup must break structure",
    null, "DIRECT_TEACHING",
    "On-screen rules list. Already implemented as the confirmation requirement, and " +
    "this upgrades structure.breakRequired from inferred to stated."),
  P("origin.notInsideConsolidation",
    "The origin cannot be inside a consolidation",
    null, "DIRECT_TEACHING",
    "On-screen rules list, and it names a condition this project CANNOT CURRENTLY " +
    "EVALUATE. The consolidation predicate was retired as indefensible (5-13 ATR " +
    "'ranges' with zero boundary interaction) and every zone reports UNRESOLVED. So a " +
    "rule the teaching states plainly is one we measure not at all — that gap is the " +
    "finding, not an oversight to paper over."),

  // ── candle selection: ALL OURS ─────────────────────────────────────────────
  P("selection.maxInterveningCandles",
    "Candles allowed between the IPO and the start of the departure move",
    2, "OPERATIONAL_INTERPRETATION",
    "THE TOLERANCE IS TAUGHT, THE NUMBER IS OURS. Roughly one to three small candles may drift between the IPO and the start of the move. Pinning that to exactly 2 is a choice: it sits inside the taught range but excludes the top of it, so a demonstrated IPO with three drifting candles would be missed by the default and found at 3. Treat it as a free parameter under the usual holdout discipline, not as the method."),
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
    null, "USER_CONFIRMED",
    "Downgraded from DIRECT_TEACHING: confirmed in review, but no specific teaching statement has been located for it. Restore DIRECT_TEACHING only when one is. Reported, never required."),
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
  "refinement.sameDirection",
  "origin.lastOppositeBeforeMajorMove",
  "origin.candleThatTookPeopleOut",
  "origin.mustBreakStructure",
  "origin.notInsideConsolidation",
  "refinement.findOnHtfWorkOnLtf",
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

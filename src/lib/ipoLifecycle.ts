/**
 * IPO lifecycle presentation. PURE. Read-only over the observation row.
 *
 * It maps what the FROZEN engine actually recorded onto the trader's lifecycle
 * vocabulary, and refuses to map anything it cannot prove.
 *
 * THE CENTRAL RULE: a stage is DETECTED only when a field on the row proves it.
 * Nothing is inferred backwards. A candidate that is VALID obviously touched
 * its zone at some point in any sane reading, but if `touch` says NO then TOUCH
 * is not marked — because the thing being displayed is what the engine
 * recorded, not what must have been true.
 *
 * FOUR OF THE TWELVE TERMS ARE NOT TRACKED, and are shown as such:
 *
 *   MOVE_AWAY, EXPANSION_TO_IPO, TREND_FROM_IPO
 *     Research states. `ipoStateMachine.ts` implements them and says in its own
 *     header that nothing there is wired to production. The frozen population
 *     rules do not compute them, and the observation endpoint already returns
 *     the literal "NOT_TRACKED" for all three.
 *
 *   VALID_EXTERNAL_IPO
 *     Subtler, and the one most likely to be mapped wrongly. In the state
 *     machine this means a PRE-EXISTING qualified IPO that price later left.
 *     The frozen engine tracks every candidate independently and stores no link
 *     to a predecessor, and it classifies nothing as external or internal
 *     structure. Pointing this stage at `validAt` would relabel NEW_IPO_VALID
 *     and make the chain look complete by saying the same fact twice.
 *
 * PENDING IS NOT NOT_TRACKED. "The engine watches for this and it has not
 * happened" and "the engine never computes this" are different claims, and
 * collapsing them would hide which stages are missing from the engine.
 */

/**
 * The six statuses requested, plus PENDING.
 *
 * PENDING is the honest state for a tracked stage that has not been reached —
 * without it a watched-but-unreached stage would have to borrow NOT_TRACKED and
 * misreport the engine's coverage.
 */
export type StageStatus =
  | "DETECTED" | "ACTIVE" | "COMPLETED" | "FAILED" | "SUPPRESSED" | "NOT_TRACKED" | "PENDING";

export type LifecycleTerm =
  | "VALID_EXTERNAL_IPO" | "MOVE_AWAY" | "CONTRACTION_ACTIVE" | "EXPANSION_TO_IPO"
  | "IPO_TOUCH" | "VALID_TOUCHED" | "TREND_FROM_IPO" | "NEW_IPO_PENDING"
  | "PENDING_DEAD" | "SUPPRESSED_IN_CONTRACTION" | "OPPOSITE_SIDE_CLEARED"
  | "NEW_IPO_VALID" | "IPO_INVALIDATED";

/** Plain English for every term, shown beside the code rather than replacing it. */
export const GLOSSARY: Record<LifecycleTerm, string> = {
  VALID_EXTERNAL_IPO: "Existing qualified IPO zone",
  MOVE_AWAY: "Price leaves the IPO",
  CONTRACTION_ACTIVE: "Range/compression detected",
  EXPANSION_TO_IPO: "Price expands back toward the IPO",
  IPO_TOUCH: "Price revisited the valid IPO",
  VALID_TOUCHED: "Price revisited the valid IPO",
  TREND_FROM_IPO: "Directional move launches from the touched IPO",
  NEW_IPO_PENDING: "Possible new IPO candidate not yet confirmed",
  PENDING_DEAD: "Candidate failed before becoming valid",
  SUPPRESSED_IN_CONTRACTION: "Candidate formed inside contraction and is not eligible",
  OPPOSITE_SIDE_CLEARED: "Trend cleared the far side of the prior contraction",
  NEW_IPO_VALID: "Pending candidate has now qualified",
  IPO_INVALIDATED: "Full candle close beyond the IPO's far extreme",
};

/** The subset of the observation row this module reads. Structural, so the real row fits. */
export interface LifecycleRowLike {
  state: string;
  signalValid: boolean;
  validationStatus: string;
  observationStatus: string;
  contraction: string;
  touch: string;
  oppositeSideCleared: string;
  moveAway: string;
  expansion: string;
  trend: string;
  reasonCodes: string[];
}

export interface Stage {
  term: LifecycleTerm;
  label: string;
  status: StageStatus;
  /** Plain English for the term itself. */
  meaning: string;
  /** Why this stage holds this status, for this candidate. */
  why: string;
  /** Raw engine values behind the verdict. Never dropped — debugging needs them. */
  evidence: string[];
}

const yes = (v: string) => v === "YES";
const tracked = (v: string) => v === "YES" || v === "NO";

/**
 * The eight-stage chain, in the order a trader reads it.
 *
 * Every `status` below is decided from a field on the row. Where the row says
 * NOT_TRACKED the stage says NOT_TRACKED, and no later evidence is allowed to
 * promote it — that is the whole point of the rule.
 */
export function lifecycleChain(r: LifecycleRowLike): Stage[] {
  const invalidated = r.state === "INVALIDATED";
  const suppressed = r.state === "SUPPRESSED_IN_CONTRACTION";
  const dead = r.state === "PENDING_DEAD";
  const valid = yes(r.oppositeSideCleared);
  const touched = yes(r.touch);
  const noPrior = r.reasonCodes.includes("NO_PRIOR_CONTRACTION");

  const notTracked = (term: LifecycleTerm, why: string, evidence: string[]): Stage => ({
    term, label: TERM_LABEL[term], status: "NOT_TRACKED",
    meaning: GLOSSARY[term], why, evidence,
  });

  return [
    // Not `validAt`. See the module header: this is the PREDECESSOR IPO, which
    // the frozen engine does not record.
    notTracked(
      "VALID_EXTERNAL_IPO",
      "The frozen engine tracks each candidate independently and stores no link to a predecessor IPO, nor any external/internal classification.",
      ["no field on the observation row carries it"],
    ),
    notTracked("MOVE_AWAY",
      "Research state. The frozen population rules do not compute it.",
      [`moveAway=${r.moveAway}`]),
    {
      term: "CONTRACTION_ACTIVE",
      label: TERM_LABEL.CONTRACTION_ACTIVE,
      meaning: GLOSSARY.CONTRACTION_ACTIVE,
      status: yes(r.contraction) ? "DETECTED" : noPrior ? "FAILED" : "COMPLETED",
      why: yes(r.contraction)
        ? "An active contraction covers this candle, so the candidate is not eligible to become a valid IPO."
        : noPrior
          ? "No prior contraction exists, so there is no far side for a trend to clear. This candidate can never be promoted."
          : "A prior contraction exists and is the range whose far side must be cleared.",
      evidence: [`contraction=${r.contraction}`, noPrior ? "NO_PRIOR_CONTRACTION" : "prior contraction present"],
    },
    notTracked("EXPANSION_TO_IPO",
      "Research state. The frozen population rules do not compute it.",
      [`expansion=${r.expansion}`]),
    {
      term: "IPO_TOUCH",
      label: TERM_LABEL.IPO_TOUCH,
      meaning: GLOSSARY.IPO_TOUCH,
      status: !tracked(r.touch) ? "NOT_TRACKED"
        : r.observationStatus === "TOUCHED_THIS_BAR" ? "ACTIVE"
        : touched ? "COMPLETED" : "PENDING",
      why: r.observationStatus === "TOUCHED_THIS_BAR"
        ? "Price is in the zone on the current bar."
        : touched ? "Price has revisited the zone."
        : "Price has not revisited the zone yet.",
      evidence: [`touch=${r.touch}`, `observationStatus=${r.observationStatus}`],
    },
    notTracked("TREND_FROM_IPO",
      "Research state. The frozen population rules do not compute it.",
      [`trend=${r.trend}`]),
    {
      term: "OPPOSITE_SIDE_CLEARED",
      label: TERM_LABEL.OPPOSITE_SIDE_CLEARED,
      meaning: GLOSSARY.OPPOSITE_SIDE_CLEARED,
      status: valid ? "COMPLETED"
        : dead ? "FAILED"
        : suppressed ? "SUPPRESSED"
        : "PENDING",
      why: valid ? "The trend cleared the far side of the prior contraction; the candidate was promoted."
        : dead ? (noPrior
            ? "There was no prior contraction to clear."
            : "The candidate died before the far side was cleared.")
        : suppressed ? "Held back: the candidate sits inside an active contraction."
        : "Waiting for the trend to clear the far side of the prior contraction.",
      evidence: [`oppositeSideCleared=${r.oppositeSideCleared}`, `state=${r.state}`,
                 ...r.reasonCodes.filter((c) =>
                   c === "AWAITING_OPPOSITE_SIDE_CLEARANCE" || c === "DIED_BEFORE_CLEARANCE" || c === "NO_PRIOR_CONTRACTION")],
    },
    {
      term: "NEW_IPO_VALID",
      label: TERM_LABEL.NEW_IPO_VALID,
      meaning: GLOSSARY.NEW_IPO_VALID,
      status: invalidated ? "FAILED"
        : suppressed ? "SUPPRESSED"
        : dead ? "FAILED"
        : valid ? "COMPLETED"
        : "PENDING",
      why: invalidated ? "A full candle closed beyond the IPO's far extreme."
        : suppressed ? "Suppressed by an active contraction; it cannot qualify while that holds."
        : dead ? "The candidate died before it could qualify."
        : valid ? "The candidate has qualified."
        : "Not yet qualified.",
      evidence: [`validationStatus=${r.validationStatus}`, `signalValid=${r.signalValid}`, `state=${r.state}`],
    },
  ];
}

const TERM_LABEL: Record<LifecycleTerm, string> = {
  VALID_EXTERNAL_IPO: "Valid external IPO",
  MOVE_AWAY: "Move away",
  CONTRACTION_ACTIVE: "Contraction",
  EXPANSION_TO_IPO: "Expansion",
  IPO_TOUCH: "Touch",
  VALID_TOUCHED: "Valid touched",
  TREND_FROM_IPO: "Trend",
  NEW_IPO_PENDING: "New IPO pending",
  PENDING_DEAD: "Pending dead",
  SUPPRESSED_IN_CONTRACTION: "Suppressed in contraction",
  OPPOSITE_SIDE_CLEARED: "Opposite side cleared",
  NEW_IPO_VALID: "New IPO valid",
  IPO_INVALIDATED: "IPO invalidated",
};

export const termLabel = (t: LifecycleTerm): string => TERM_LABEL[t];

export interface PathNode {
  term: LifecycleTerm;
  label: string;
  meaning: string;
  status: StageStatus;
  why: string;
}

/**
 * The route THIS candidate actually took, as opposed to the full chain.
 *
 * Every candidate starts at NEW_IPO_PENDING because that is what the engine
 * creates. Where it goes next is read from the recorded state, never guessed:
 *
 *   pending -> suppressed in contraction         (held back, may yet clear)
 *   pending -> pending dead                      (failed, with the recorded reason)
 *   pending -> opposite side cleared -> valid    (promoted)
 *                                     -> touched / invalidated as recorded
 */
export function candidatePath(r: LifecycleRowLike): PathNode[] {
  const node = (term: LifecycleTerm, status: StageStatus, why: string): PathNode =>
    ({ term, label: TERM_LABEL[term], meaning: GLOSSARY[term], status, why });

  const valid = yes(r.oppositeSideCleared);
  const path: PathNode[] = [
    node("NEW_IPO_PENDING",
      r.state === "PENDING_CANDIDATE" ? "ACTIVE" : "COMPLETED",
      "A directional candle created a candidate."),
  ];

  if (r.state === "SUPPRESSED_IN_CONTRACTION") {
    path.push(node("SUPPRESSED_IN_CONTRACTION", "SUPPRESSED",
      "Candidate formed inside active contraction and is not eligible to become a valid IPO."));
    return path;
  }

  if (r.state === "PENDING_DEAD") {
    path.push(node("PENDING_DEAD", "FAILED",
      r.reasonCodes.includes("NO_PRIOR_CONTRACTION")
        ? "No prior contraction existed, so there was no far side to clear."
        : r.reasonCodes.includes("DIED_BEFORE_CLEARANCE")
          ? "The candidate died before the far side of the prior contraction was cleared."
          : "The engine marked the candidate dead; no more specific reason was recorded."));
    return path;
  }

  if (valid) {
    path.push(node("OPPOSITE_SIDE_CLEARED", "COMPLETED",
      "The trend cleared the far side of the prior contraction."));
    path.push(node("NEW_IPO_VALID", r.state === "INVALIDATED" ? "COMPLETED" : "COMPLETED",
      "The candidate qualified as a valid IPO."));
    if (yes(r.touch)) {
      path.push(node("VALID_TOUCHED",
        r.observationStatus === "TOUCHED_THIS_BAR" ? "ACTIVE" : "COMPLETED",
        r.observationStatus === "TOUCHED_THIS_BAR"
          ? "Price is in the zone on the current bar."
          : "Price revisited the valid IPO."));
    }
    if (r.state === "INVALIDATED") {
      path.push(node("IPO_INVALIDATED", "FAILED",
        "A full candle closed beyond the IPO's far extreme."));
    }
    return path;
  }

  if (r.state === "INVALIDATED") {
    path.push(node("IPO_INVALIDATED", "FAILED",
      "A full candle closed beyond the IPO's far extreme before the candidate qualified."));
    return path;
  }

  path.push(node("OPPOSITE_SIDE_CLEARED", "PENDING",
    "Waiting for the trend to clear the far side of the prior contraction."));
  return path;
}

/**
 * The contraction note the panel shows when a candidate is suppressed.
 *
 * Returns null when there is nothing to say, so the caller renders nothing
 * rather than an empty box.
 */
export function contractionNote(r: LifecycleRowLike): { headline: string; detail: string } | null {
  if (r.state === "SUPPRESSED_IN_CONTRACTION" || yes(r.contraction)) {
    return {
      headline: "Active contraction detected",
      detail: "Candidate formed inside active contraction and is not eligible to become a valid IPO.",
    };
  }
  if (r.reasonCodes.includes("NO_PRIOR_CONTRACTION")) {
    return {
      headline: "No prior contraction",
      detail: "Promotion measures a trend clearing the far side of a PRIOR contraction. With none on record there is no far side, so this candidate can never be promoted.",
    };
  }
  return null;
}

/** Counts for a compact summary line. NOT_TRACKED is reported, not hidden. */
export function chainCoverage(stages: Stage[]): { tracked: number; notTracked: number; total: number } {
  const notTracked = stages.filter((s) => s.status === "NOT_TRACKED").length;
  return { tracked: stages.length - notTracked, notTracked, total: stages.length };
}

import { describe, it, expect } from "vitest";
import {
  lifecycleChain, candidatePath, contractionNote, chainCoverage, GLOSSARY, termLabel,
  type LifecycleRowLike, type StageStatus,
} from "./ipoLifecycle";

/** A row as the observation endpoint actually returns it. */
const row = (over: Partial<LifecycleRowLike> = {}): LifecycleRowLike => ({
  state: "PENDING_CANDIDATE",
  signalValid: false,
  validationStatus: "NOT_VALIDATED",
  observationStatus: "WATCHING",
  contraction: "NO",
  touch: "NO",
  oppositeSideCleared: "NO",
  // The endpoint hardcodes these three; the UI must not promote them.
  moveAway: "NOT_TRACKED",
  expansion: "NOT_TRACKED",
  trend: "NOT_TRACKED",
  reasonCodes: ["AWAITING_OPPOSITE_SIDE_CLEARANCE"],
  ...over,
});

const stage = (r: LifecycleRowLike, term: string) =>
  lifecycleChain(r).find((s) => s.term === term)!;
const statusOf = (r: LifecycleRowLike, term: string): StageStatus => stage(r, term).status;

// ── the chain ────────────────────────────────────────────────────────────────

describe("the lifecycle chain", () => {
  it("renders the eight stages in trader order", () => {
    expect(lifecycleChain(row()).map((s) => s.term)).toEqual([
      "VALID_EXTERNAL_IPO", "MOVE_AWAY", "CONTRACTION_ACTIVE", "EXPANSION_TO_IPO",
      "IPO_TOUCH", "TREND_FROM_IPO", "OPPOSITE_SIDE_CLEARED", "NEW_IPO_VALID",
    ]);
  });

  it("reports its own coverage rather than implying the chain is complete", () => {
    const c = chainCoverage(lifecycleChain(row()));
    expect(c.total).toBe(8);
    expect(c.notTracked).toBe(4);
    expect(c.tracked).toBe(4);
  });
});

// ── the central rule: nothing is inferred ────────────────────────────────────

describe("a stage is never marked without proof", () => {
  const RESEARCH = ["MOVE_AWAY", "EXPANSION_TO_IPO", "TREND_FROM_IPO"];

  it("keeps the three research states NOT_TRACKED in every situation", () => {
    const situations = [
      row(),
      row({ state: "VALID_LIVE", oppositeSideCleared: "YES", signalValid: true, touch: "YES" }),
      row({ state: "VALID_TOUCHED", oppositeSideCleared: "YES", touch: "YES", observationStatus: "TOUCHED_THIS_BAR" }),
      row({ state: "INVALIDATED" }),
      row({ state: "PENDING_DEAD" }),
      row({ state: "SUPPRESSED_IN_CONTRACTION", contraction: "YES" }),
    ];
    for (const r of situations) {
      for (const term of RESEARCH) expect(statusOf(r, term)).toBe("NOT_TRACKED");
    }
  });

  it("keeps VALID_EXTERNAL_IPO not tracked even for a fully valid, touched IPO", () => {
    // The tempting wrong mapping: point it at validAt and the chain looks
    // complete. That would relabel NEW_IPO_VALID and state the same fact twice.
    const r = row({ state: "VALID_TOUCHED", oppositeSideCleared: "YES", signalValid: true, touch: "YES" });
    expect(statusOf(r, "VALID_EXTERNAL_IPO")).toBe("NOT_TRACKED");
    expect(stage(r, "VALID_EXTERNAL_IPO").why).toMatch(/predecessor/i);
  });

  it("does not infer TOUCH backwards from validity", () => {
    // A valid IPO plausibly touched at some point. The engine says touch=NO, so
    // the panel says pending. What is displayed is what was recorded.
    const r = row({ state: "VALID_LIVE", oppositeSideCleared: "YES", signalValid: true, touch: "NO" });
    expect(statusOf(r, "IPO_TOUCH")).toBe("PENDING");
  });

  it("separates PENDING from NOT_TRACKED", () => {
    // Watched-but-unreached and never-computed must not collapse together, or
    // the engine's coverage is misreported.
    expect(statusOf(row(), "IPO_TOUCH")).toBe("PENDING");
    expect(statusOf(row(), "MOVE_AWAY")).toBe("NOT_TRACKED");
  });

  it("marks touch NOT_TRACKED if the field ever stops being a tri-state", () => {
    expect(statusOf(row({ touch: "NOT_TRACKED" }), "IPO_TOUCH")).toBe("NOT_TRACKED");
  });
});

// ── contraction ──────────────────────────────────────────────────────────────

describe("contraction is visible, in both of its meanings", () => {
  it("marks an active contraction as DETECTED and explains the suppression", () => {
    const r = row({ state: "SUPPRESSED_IN_CONTRACTION", contraction: "YES",
                    reasonCodes: ["INSIDE_ACTIVE_CONTRACTION"] });
    expect(statusOf(r, "CONTRACTION_ACTIVE")).toBe("DETECTED");
    const note = contractionNote(r)!;
    expect(note.headline).toBe("Active contraction detected");
    expect(note.detail).toBe(
      "Candidate formed inside active contraction and is not eligible to become a valid IPO.");
  });

  it("treats a PRIOR contraction as the thing clearance is measured against", () => {
    // contraction=NO means this candle is not inside one. A prior contraction
    // still exists, and it is the range whose far side must be cleared.
    const r = row({ contraction: "NO", reasonCodes: ["AWAITING_OPPOSITE_SIDE_CLEARANCE"] });
    expect(statusOf(r, "CONTRACTION_ACTIVE")).toBe("COMPLETED");
    expect(stage(r, "CONTRACTION_ACTIVE").why).toMatch(/prior contraction exists/i);
    expect(contractionNote(r)).toBeNull();
  });

  it("calls out a candidate with no prior contraction as unpromotable", () => {
    const r = row({ state: "PENDING_DEAD", reasonCodes: ["NO_PRIOR_CONTRACTION"] });
    expect(statusOf(r, "CONTRACTION_ACTIVE")).toBe("FAILED");
    expect(contractionNote(r)!.headline).toBe("No prior contraction");
    expect(contractionNote(r)!.detail).toMatch(/never be promoted/);
  });
});

// ── candidate paths ──────────────────────────────────────────────────────────

describe("the candidate path shows the route actually taken", () => {
  it("failed: NEW IPO PENDING → PENDING DEAD, with the recorded reason", () => {
    const r = row({ state: "PENDING_DEAD", reasonCodes: ["DIED_BEFORE_CLEARANCE"] });
    const p = candidatePath(r);
    expect(p.map((n) => n.term)).toEqual(["NEW_IPO_PENDING", "PENDING_DEAD"]);
    expect(p[1].status).toBe("FAILED");
    expect(p[1].why).toMatch(/died before the far side/i);
  });

  it("failed for the other reason, and says which", () => {
    const p = candidatePath(row({ state: "PENDING_DEAD", reasonCodes: ["NO_PRIOR_CONTRACTION"] }));
    expect(p[1].why).toMatch(/no prior contraction/i);
  });

  it("does not invent a reason the engine did not record", () => {
    const p = candidatePath(row({ state: "PENDING_DEAD", reasonCodes: [] }));
    expect(p[1].why).toMatch(/no more specific reason was recorded/i);
  });

  it("successful: NEW IPO PENDING → OPPOSITE SIDE CLEARED → NEW IPO VALID", () => {
    const p = candidatePath(row({ state: "VALID_LIVE", oppositeSideCleared: "YES", signalValid: true }));
    expect(p.map((n) => n.term)).toEqual(["NEW_IPO_PENDING", "OPPOSITE_SIDE_CLEARED", "NEW_IPO_VALID"]);
    expect(p.every((n) => n.status === "COMPLETED")).toBe(true);
  });

  it("extends the successful path with the touch when one was recorded", () => {
    const p = candidatePath(row({ state: "VALID_TOUCHED", oppositeSideCleared: "YES",
                                  touch: "YES", observationStatus: "TOUCHED_THIS_BAR" }));
    expect(p.map((n) => n.term)).toEqual(
      ["NEW_IPO_PENDING", "OPPOSITE_SIDE_CLEARED", "NEW_IPO_VALID", "VALID_TOUCHED"]);
    expect(p[3].status).toBe("ACTIVE");
  });

  it("ends a promoted-then-broken IPO at IPO_INVALIDATED", () => {
    const p = candidatePath(row({ state: "INVALIDATED", oppositeSideCleared: "YES",
                                  reasonCodes: ["INVALIDATED_BY_CLOSE"] }));
    expect(p[p.length - 1].term).toBe("IPO_INVALIDATED");
    expect(p[p.length - 1].status).toBe("FAILED");
    expect(p[p.length - 1].why).toMatch(/full candle closed beyond/i);
  });

  it("suppressed: stops at SUPPRESSED_IN_CONTRACTION rather than claiming failure", () => {
    const p = candidatePath(row({ state: "SUPPRESSED_IN_CONTRACTION", contraction: "YES" }));
    expect(p.map((n) => n.term)).toEqual(["NEW_IPO_PENDING", "SUPPRESSED_IN_CONTRACTION"]);
    expect(p[1].status).toBe("SUPPRESSED");
    expect(p[1].status).not.toBe("FAILED");
  });

  it("still waiting: shows the clearance it is waiting on", () => {
    const p = candidatePath(row());
    expect(p.map((n) => n.term)).toEqual(["NEW_IPO_PENDING", "OPPOSITE_SIDE_CLEARED"]);
    expect(p[0].status).toBe("ACTIVE");
    expect(p[1].status).toBe("PENDING");
  });
});

// ── raw codes and glossary ───────────────────────────────────────────────────

describe("debuggability and vocabulary", () => {
  it("carries the raw engine values on every tracked stage", () => {
    const r = row({ state: "VALID_TOUCHED", oppositeSideCleared: "YES", touch: "YES",
                    validationStatus: "VALIDATED@412", signalValid: true });
    expect(stage(r, "IPO_TOUCH").evidence).toContain("touch=YES");
    expect(stage(r, "OPPOSITE_SIDE_CLEARED").evidence).toContain("oppositeSideCleared=YES");
    expect(stage(r, "NEW_IPO_VALID").evidence).toContain("validationStatus=VALIDATED@412");
  });

  it("carries the raw value even on a not-tracked stage, so the source is visible", () => {
    expect(stage(row(), "MOVE_AWAY").evidence).toContain("moveAway=NOT_TRACKED");
  });

  it("defines every one of the twelve terms in plain English", () => {
    const REQUIRED = [
      "VALID_EXTERNAL_IPO", "MOVE_AWAY", "CONTRACTION_ACTIVE", "EXPANSION_TO_IPO",
      "IPO_TOUCH", "VALID_TOUCHED", "TREND_FROM_IPO", "NEW_IPO_PENDING", "PENDING_DEAD",
      "SUPPRESSED_IN_CONTRACTION", "OPPOSITE_SIDE_CLEARED", "NEW_IPO_VALID", "IPO_INVALIDATED",
    ] as const;
    for (const t of REQUIRED) {
      expect(GLOSSARY[t]).toBeTruthy();
      expect(GLOSSARY[t].length).toBeGreaterThan(10);
      expect(termLabel(t).length).toBeGreaterThan(0);
    }
  });

  it("uses the wording the spec asked for", () => {
    expect(GLOSSARY.VALID_EXTERNAL_IPO).toBe("Existing qualified IPO zone");
    expect(GLOSSARY.MOVE_AWAY).toBe("Price leaves the IPO");
    expect(GLOSSARY.CONTRACTION_ACTIVE).toBe("Range/compression detected");
    expect(GLOSSARY.EXPANSION_TO_IPO).toBe("Price expands back toward the IPO");
    expect(GLOSSARY.VALID_TOUCHED).toBe("Price revisited the valid IPO");
    expect(GLOSSARY.TREND_FROM_IPO).toBe("Directional move launches from the touched IPO");
    expect(GLOSSARY.NEW_IPO_PENDING).toBe("Possible new IPO candidate not yet confirmed");
    expect(GLOSSARY.PENDING_DEAD).toBe("Candidate failed before becoming valid");
    expect(GLOSSARY.SUPPRESSED_IN_CONTRACTION)
      .toBe("Candidate formed inside contraction and is not eligible");
    expect(GLOSSARY.OPPOSITE_SIDE_CLEARED).toBe("Trend cleared the far side of the prior contraction");
    expect(GLOSSARY.NEW_IPO_VALID).toBe("Pending candidate has now qualified");
    expect(GLOSSARY.IPO_INVALIDATED).toBe("Full candle close beyond the IPO's far extreme");
  });
});

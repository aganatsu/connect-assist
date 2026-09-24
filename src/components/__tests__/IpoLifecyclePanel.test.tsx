/**
 * IpoScanDetail — the rendered lifecycle panel.
 *
 * Mounted rather than grepped, because the claim being protected is "a stage is
 * never shown as detected without proof", and that is a property of what
 * renders, not of what the source contains.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { IpoScanDetail, type IpoRow } from "../IpoScanDetail";

const row = (over: Partial<IpoRow> = {}): IpoRow => ({
  instrument: "EUR/USD", timeframe: "1h", direction: "long",
  ipoCandleTime: "2026-09-22T08:00:00Z", ipoIndex: 412,
  zoneHigh: 1.1, zoneLow: 1.095, midpoint: 1.095,
  state: "PENDING_CANDIDATE", signalValid: false,
  validationStatus: "NOT_VALIDATED", observationStatus: "WATCHING",
  fvgPresent: false, fvgStatus: "WINDOW_OPEN",
  contraction: "NO", touch: "NO", oppositeSideCleared: "NO",
  moveAway: "NOT_TRACKED", expansion: "NOT_TRACKED", trend: "NOT_TRACKED",
  volatilityBucket: "HIGH_VOL", volatilityEligible: true,
  intendedEntry: 1.095, target2R: 1.105, s2Invalidation: 1.09, riskPrice: 0.005,
  sequencingState: "FREE", executionEligible: false,
  reasonCodes: ["AWAITING_OPPOSITE_SIDE_CLEARANCE"],
  ...over,
});

const panel = () =>
  screen.getByText("Lifecycle").closest("section") as HTMLElement;

/**
 * The candidate-path row only.
 *
 * A term legitimately appears twice — once in the eight-stage chain and once in
 * the path this candidate took — so path assertions have to be scoped or they
 * match both.
 */
const pathRow = () =>
  screen.getByText("Candidate path").nextElementSibling as HTMLElement;

describe("the lifecycle panel renders every stage", () => {
  it("shows all eight stages of the chain", () => {
    render(<IpoScanDetail row={row()} />);
    const p = within(panel());
    for (const label of ["Valid external IPO", "Move away", "Contraction", "Expansion",
                         "Touch", "Trend", "Opposite side cleared", "New IPO valid"]) {
      expect(p.getAllByText(new RegExp(label, "i")).length).toBeGreaterThan(0);
    }
  });

  it("states how much of the chain the engine actually tracks", () => {
    render(<IpoScanDetail row={row()} />);
    expect(screen.getByText(/4 of 8 stages tracked by the frozen engine/)).toBeInTheDocument();
  });

  it("keeps the raw engine fields visible for debugging", () => {
    render(<IpoScanDetail row={row({ validationStatus: "VALIDATED@412" })} />);
    const p = within(panel());
    expect(p.getByText("Raw engine fields")).toBeInTheDocument();
    expect(p.getByText("VALIDATED@412")).toBeInTheDocument();
    expect(p.getAllByText("not tracked").length).toBeGreaterThanOrEqual(3);
  });
});

describe("no stage is shown as detected without proof", () => {
  it("shows the research stages as not tracked even on a fully valid IPO", () => {
    render(<IpoScanDetail row={row({
      state: "VALID_TOUCHED", oppositeSideCleared: "YES", touch: "YES",
      signalValid: true, observationStatus: "TOUCHED_THIS_BAR",
      validationStatus: "VALIDATED@412", reasonCodes: ["ELIGIBLE_NOW"],
    })} />);
    for (const term of ["MOVE_AWAY", "EXPANSION_TO_IPO", "TREND_FROM_IPO", "VALID_EXTERNAL_IPO"]) {
      const chip = screen.getByTitle(new RegExp(`^${term} —`));
      expect(chip.textContent).toMatch(/not tracked/i);
    }
  });

  it("explains in the panel why those stages are blank", () => {
    render(<IpoScanDetail row={row()} />);
    expect(screen.getByText(/nothing is\s+inferred backwards/i)).toBeInTheDocument();
    expect(screen.getByText(/research\s+states the frozen rules do not compute/i)).toBeInTheDocument();
  });
});

describe("contraction is made visible", () => {
  it("shows the active-contraction note and the exact explanation asked for", () => {
    render(<IpoScanDetail row={row({
      state: "SUPPRESSED_IN_CONTRACTION", contraction: "YES",
      reasonCodes: ["INSIDE_ACTIVE_CONTRACTION"],
    })} />);
    expect(screen.getByText("Active contraction detected")).toBeInTheDocument();
    expect(screen.getByText(
      "Candidate formed inside active contraction and is not eligible to become a valid IPO."
    )).toBeInTheDocument();
  });

  it("does not show the note when no contraction is in play", () => {
    render(<IpoScanDetail row={row()} />);
    expect(screen.queryByText("Active contraction detected")).toBeNull();
    expect(screen.queryByText("No prior contraction")).toBeNull();
  });

  it("flags a candidate that can never be promoted", () => {
    render(<IpoScanDetail row={row({ state: "PENDING_DEAD", reasonCodes: ["NO_PRIOR_CONTRACTION"] })} />);
    expect(screen.getByText("No prior contraction")).toBeInTheDocument();
    expect(screen.getByText(/never be promoted/)).toBeInTheDocument();
  });
});

describe("candidate paths", () => {
  it("renders the failed path with the reason the engine recorded", () => {
    render(<IpoScanDetail row={row({ state: "PENDING_DEAD", reasonCodes: ["DIED_BEFORE_CLEARANCE"] })} />);
    expect(screen.getByText("Candidate path")).toBeInTheDocument();
    const p = within(pathRow());
    expect(p.getByTitle(/^PENDING_DEAD —/).textContent).toMatch(/Pending dead/);
    expect(p.getByTitle(/died before the far side/i)).toBeInTheDocument();
  });

  it("renders the successful path", () => {
    render(<IpoScanDetail row={row({
      state: "VALID_LIVE", oppositeSideCleared: "YES", signalValid: true,
      validationStatus: "VALIDATED@412", reasonCodes: [],
    })} />);
    const p = within(pathRow());
    for (const term of ["NEW_IPO_PENDING", "OPPOSITE_SIDE_CLEARED", "NEW_IPO_VALID"]) {
      expect(p.getByTitle(new RegExp(`^${term} —`))).toBeInTheDocument();
    }
  });

  it("renders a suppressed candidate as suppressed, not failed", () => {
    render(<IpoScanDetail row={row({ state: "SUPPRESSED_IN_CONTRACTION", contraction: "YES" })} />);
    const chip = within(pathRow()).getByTitle(/^SUPPRESSED_IN_CONTRACTION —/);
    expect(chip.title).toMatch(/SUPPRESSED:/);
    expect(chip.title).not.toMatch(/FAILED:/);
  });
});

describe("the glossary and the read-only contract", () => {
  it("defines the vocabulary in the panel", () => {
    render(<IpoScanDetail row={row()} />);
    expect(screen.getByText("Lifecycle glossary")).toBeInTheDocument();
    expect(screen.getByText("Trend cleared the far side of the prior contraction")).toBeInTheDocument();
    expect(screen.getByText("Full candle close beyond the IPO's far extreme")).toBeInTheDocument();
  });

  it("still says it cannot trade", () => {
    render(<IpoScanDetail row={row()} />);
    expect(screen.getByText(/The scanner places no order/)).toBeInTheDocument();
    for (const name of [/buy/i, /sell/i, /place order/i]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("renders nothing but a prompt when no row is selected", () => {
    render(<IpoScanDetail row={null} />);
    expect(screen.getByText(/Select a row to inspect/)).toBeInTheDocument();
    expect(screen.queryByText("Candidate path")).toBeNull();
  });
});

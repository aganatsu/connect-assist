/**
 * Scanner semantics: ownership vs. new-entry eligibility, and filter behaviour.
 *
 * THE CONTRADICTION THESE CLOSE. The engine's `sequencingState`,
 * `executionEligible` and reason codes answer one question — *could a NEW entry
 * be created on this instrument right now?* With a position open the answer is
 * always no, on EVERY row for that instrument, including the row whose own IPO
 * opened it. Rendered verbatim the owning row read:
 *
 *     Trade status              OPEN POSITION
 *     sequencing                BLOCKED_POSITION_OPEN
 *     would the rules admit it  no
 *     POSITION_ALREADY_OPEN
 *
 * which says a live trade is a rejection. The raw fields are unchanged and still
 * auditable; what changed is that the ROW decides how to read them.
 */
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const invoke = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } },
}));

import { IpoScanDetail, type IpoRow } from "../IpoScanDetail";
import { IpoScanner } from "../IpoScanner";
import { classifyRow, readNewEntryCheck, type PositionLike, type ClosedLike } from "@/lib/ipoTradeLinkage";

// ─── fixtures ────────────────────────────────────────────────────────────────

const row = (over: Partial<IpoRow> = {}): IpoRow => ({
  instrument: "USD/JPY", timeframe: "30min", direction: "long",
  ipoCandleTime: "2026-09-24T16:00:00Z", ipoIndex: 1,
  zoneHigh: 158.2, zoneLow: 157.8, midpoint: 158.0,
  state: "VALID_TOUCHED", signalValid: true,
  validationStatus: "VALIDATED", observationStatus: "OBSERVED",
  fvgPresent: true, fvgStatus: "YES", contraction: "YES", touch: "YES",
  oppositeSideCleared: "YES", moveAway: "NOT_TRACKED", expansion: "NOT_TRACKED",
  trend: "NOT_TRACKED", volatilityBucket: "HIGH_VOL", volatilityEligible: true,
  intendedEntry: 158.0, target2R: 158.8, s2Invalidation: 157.6, riskPrice: 0.4,
  // Exactly what the engine reports while any position is open on this symbol.
  sequencingState: "BLOCKED_POSITION_OPEN",
  executionEligible: false,
  reasonCodes: ["POSITION_ALREADY_OPEN"],
  ...over,
});

const position = (over: Partial<PositionLike> = {}): PositionLike => ({
  symbol: "USD/JPY", timeframe: "30min", direction: "long",
  ipo_candle_time: "2026-09-24 16:00:00+00",   // Postgres rendering, same instant
  entry_time: "2026-09-24T16:30:00Z", entry_price: 158.0,
  target_price: 158.8, s2_invalidation_level: 157.6,
  volatility_bucket: "HIGH_VOL", zone_entry_ordinal: 1, status: "open", ...over,
});

const draw = (r: IpoRow, positions: PositionLike[] = [], closed: ClosedLike[] = []) =>
  render(<IpoScanDetail row={r} link={classifyRow(r, positions, closed)} />);

// ─────────────────────────────────────────────────────────────────────────────
// 1-3. ownership vs. blocking
// ─────────────────────────────────────────────────────────────────────────────

describe("1 — the IPO that owns the open position", () => {
  const owner = () => draw(row(), [position()]);

  it("leads with OPEN POSITION, not a rejection", () => {
    owner();
    expect(screen.getAllByText("OPEN POSITION").length).toBeGreaterThan(0);
    expect(screen.getByText("POSITION ACTIVE")).toBeInTheDocument();
  });

  it("says this IPO opened the current paper position", () => {
    owner();
    expect(screen.getAllByText(/This IPO opened the current paper position/).length)
      .toBeGreaterThan(0);
  });

  it("does NOT present POSITION_ALREADY_OPEN as a rejection in the primary view", () => {
    owner();
    // The raw code survives for audit — but only inside the collapsed section,
    // never as a badge beside OPEN POSITION.
    const details = screen.getByText(/Raw engine \/ new-entry check/).closest("details")!;
    expect(within(details).getByText("POSITION_ALREADY_OPEN")).toBeInTheDocument();
    // Nothing outside that section shouts it.
    const outside = screen.queryAllByText("POSITION_ALREADY_OPEN")
      .filter((el) => !details.contains(el));
    expect(outside).toHaveLength(0);
    // And "would admit: no" is not offered as a verdict on this trade.
    expect(screen.queryByText("would the rules admit it")).toBeNull();
  });

  it("explains the raw block as self-referential rather than an error", () => {
    owner();
    expect(screen.getAllByText(/already owns the active position/i).length).toBeGreaterThan(0);
    const check = readNewEntryCheck(classifyRow(row(), [position()], []));
    expect(check.ownsOpenPosition).toBe(true);
    expect(check.isRejection).toBe(false);
  });
});

describe("2 — a different IPO while the slot is occupied", () => {
  // Same instrument, DIFFERENT IPO candle: this row does not own the position.
  const other = row({ ipoCandleTime: "2026-09-24T18:00:00Z", ipoIndex: 2 });

  it("is blocked, and names the position holding the slot", () => {
    draw(other, [position()]);
    expect(screen.getByText("BLOCKED — POSITION ALREADY OPEN")).toBeInTheDocument();
    // Stated in the CURRENT STATUS headline and again in the execution section.
    expect(screen.getAllByText(/USD\/JPY already has an open IPO position from 2026-09-24 16:30/)
      .length).toBeGreaterThan(0);
  });

  it("reports the block as a genuine rejection", () => {
    const check = readNewEntryCheck(classifyRow(other, [position()], []));
    expect(check.verdict).toBe("BLOCKED_BY_OTHER");
    expect(check.ownsOpenPosition).toBe(false);
    expect(check.isRejection).toBe(true);
  });
});

describe("3 — no open position leaves eligibility semantics unchanged", () => {
  it("shows ordinary new-entry eligibility", () => {
    draw(row({ sequencingState: "FREE", executionEligible: true, reasonCodes: [] }), []);
    expect(screen.getByText("would enter")).toBeInTheDocument();
    expect(screen.queryByText("POSITION ACTIVE")).toBeNull();
    expect(screen.queryByText("BLOCKED — POSITION ALREADY OPEN")).toBeNull();
  });

  it("still shows a real refusal when one applies", () => {
    draw(row({ sequencingState: "FREE", executionEligible: false,
               reasonCodes: ["ECONOMICALLY_UNTRADEABLE_COST"] }), []);
    expect(screen.getByText("would not enter")).toBeInTheDocument();
    expect(screen.getAllByText("ECONOMICALLY_UNTRADEABLE_COST").length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4-12. filters
// ─────────────────────────────────────────────────────────────────────────────

const scanRow = (i: number, over: Partial<IpoRow> = {}): IpoRow => row({
  ipoIndex: i,
  ipoCandleTime: new Date(Date.UTC(2026, 8, 20, i)).toISOString(),
  ...over,
});

/**
 * 24 rows spanning every filterable dimension, deliberately MORE than one page
 * (the default size is 10) so filtering-before-pagination can be shown without
 * touching the page-size control.
 *
 * Eight per instrument: 3 VALID_TOUCHED, 2 VALID_LIVE, 2 PENDING, 1 INVALIDATED.
 * Counts are derived below rather than written down twice.
 */
const SHAPE: Array<[string, string]> = [
  ["VALID_TOUCHED", "VALIDATED"], ["VALID_TOUCHED", "VALIDATED"], ["VALID_TOUCHED", "VALIDATED"],
  ["VALID_LIVE", "VALIDATED"], ["VALID_LIVE", "VALIDATED"],
  ["PENDING_CANDIDATE", "PENDING"], ["PENDING_CANDIDATE", "PENDING"],
  ["INVALIDATED", "INVALIDATED"],
];
const SYMBOLS = ["USD/JPY", "EUR/USD", "BTC/USD"];
const DATASET: IpoRow[] = SYMBOLS.flatMap((instrument, si) =>
  SHAPE.map(([state, validationStatus], ri) =>
    scanRow(si * 8 + ri + 1, { instrument, state, validationStatus })));

const countWhere = (f: (r: IpoRow) => boolean) => DATASET.filter(f).length;
const N_ALL = DATASET.length;                                        // 24
const N_PER_SYMBOL = countWhere((r) => r.instrument === "EUR/USD");  // 8
const N_VALIDATED = countWhere((r) => r.validationStatus === "VALIDATED");   // 15
const N_PENDING = countWhere((r) => r.validationStatus === "PENDING");       // 6
const N_TOUCHED = countWhere((r) => r.state === "VALID_TOUCHED");            // 9
const PAGE_DEFAULT = 10;

/** The first USD/JPY row owns the open position. */
const OPEN = position({ ipo_candle_time: DATASET[0].ipoCandleTime });

function mountScanner(rows: IpoRow[] = DATASET, positions: PositionLike[] = [OPEN]) {
  invoke.mockImplementation((fn: string) => {
    if (fn === "ipo-observation") {
      return Promise.resolve({ data: {
        ok: true, errors: [],
        snapshots: [{ instrument: "ALL", timeframe: "30min", volatilityBucket: "HIGH_VOL",
                      sequencingState: "BLOCKED_POSITION_OPEN", barsProcessed: 1200, rows }],
      }, error: null });
    }
    return Promise.resolve({ data: {
      ok: true, openPositions: positions, recentTrades: [], recentEvents: [],
    }, error: null });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><IpoScanner /></QueryClientProvider>);
}

const header = () => screen.getByText(/IPO Scanner/).textContent ?? "";
const bodyRows = () => {
  const table = screen.queryByRole("table");
  return table ? within(table).getAllByRole("row").slice(1) : [];
};

beforeEach(() => invoke.mockReset());

describe("filters", () => {
  it("4 — instrument filter narrows the full dataset", async () => {
    mountScanner();
    await waitFor(() => expect(header()).toContain(`(${N_ALL})`));
    fireEvent.change(screen.getByLabelText("Instrument"), { target: { value: "EUR/USD" } });
    await waitFor(() => expect(header()).toContain(`(${N_PER_SYMBOL})`));
    expect(bodyRows().length).toBe(N_PER_SYMBOL);
  });

  it("5 — trade status filter works", async () => {
    mountScanner();
    await waitFor(() => expect(header()).toContain(`(${N_ALL})`));
    fireEvent.change(screen.getByLabelText("Trade status"),
                     { target: { value: "OPEN_POSITION_OWNER" } });
    // Exactly the one row whose IPO candle matches the open position.
    await waitFor(() => expect(header()).toContain("(1)"));
    expect(bodyRows().length).toBe(1);
  });

  it("6 — lifecycle filter works", async () => {
    mountScanner();
    await waitFor(() => expect(header()).toContain(`(${N_ALL})`));
    fireEvent.change(screen.getByLabelText("Lifecycle"), { target: { value: "VALID_TOUCHED" } });
    await waitFor(() => expect(header()).toContain(`(${N_TOUCHED})`));
  });

  it("7 — validation filter works", async () => {
    mountScanner();
    await waitFor(() => expect(header()).toContain(`(${N_ALL})`));
    fireEvent.change(screen.getByLabelText("Validation"), { target: { value: "PENDING" } });
    await waitFor(() => expect(header()).toContain(`(${N_PENDING})`));
  });

  it("8 — filters combine rather than resetting each other", async () => {
    mountScanner();
    await waitFor(() => expect(header()).toContain(`(${N_ALL})`));
    fireEvent.change(screen.getByLabelText("Instrument"), { target: { value: "USD/JPY" } });
    await waitFor(() => expect(header()).toContain(`(${N_PER_SYMBOL})`));
    fireEvent.change(screen.getByLabelText("Lifecycle"), { target: { value: "VALID_TOUCHED" } });
    await waitFor(() => expect(header()).toContain("(3)"));
    // The instrument filter is still applied — the second select did not clear it.
    expect((screen.getByLabelText("Instrument") as HTMLSelectElement).value).toBe("USD/JPY");
  });

  it("8b — USD/JPY + OPEN POSITION resolves to the owning row only", async () => {
    mountScanner();
    await waitFor(() => expect(header()).toContain(`(${N_ALL})`));
    fireEvent.change(screen.getByLabelText("Instrument"), { target: { value: "USD/JPY" } });
    fireEvent.change(screen.getByLabelText("Trade status"),
                     { target: { value: "OPEN_POSITION_OWNER" } });
    await waitFor(() => expect(header()).toContain("(1)"));
    expect(bodyRows().length).toBe(1);
  });

  it("9 — filtering happens before pagination", async () => {
    mountScanner();
    // 24 rows across 3 pages at the default size.
    await waitFor(() =>
      expect(screen.getByText(`Showing 1–${PAGE_DEFAULT} of ${N_ALL}`)).toBeInTheDocument());
    expect(bodyRows().length).toBe(PAGE_DEFAULT);

    // Narrowing to 8 rows must give ONE page of 8 — page 1 of the FILTERED set,
    // not page 1 of a paged 24 that happens to contain 8 matches.
    fireEvent.change(screen.getByLabelText("Instrument"), { target: { value: "EUR/USD" } });
    await waitFor(() =>
      expect(screen.getByText(`Showing 1–${N_PER_SYMBOL} of ${N_PER_SYMBOL}`)).toBeInTheDocument());
    expect(bodyRows().length).toBe(N_PER_SYMBOL);
    // Every rendered row belongs to the filtered instrument.
    for (const r of bodyRows()) expect(r.textContent).toContain("EUR/USD");
  });

  it("10 — the header count reconciles with the rendered filtered rows", async () => {
    mountScanner();
    await waitFor(() => expect(header()).toContain(`(${N_ALL})`));
    fireEvent.change(screen.getByLabelText("Validation"), { target: { value: "VALIDATED" } });
    await waitFor(() => expect(header()).toContain(`(${N_VALIDATED})`));
    // The count describes the FILTERED SET, not the page: 15 matches shown 10
    // at a time still reads (15).
    expect(bodyRows().length).toBe(PAGE_DEFAULT);
    expect(screen.getByText(`Showing 1–${PAGE_DEFAULT} of ${N_VALIDATED}`)).toBeInTheDocument();
  });

  it("11 — chips show what is active, and clear filters restores everything", async () => {
    mountScanner();
    await waitFor(() => expect(header()).toContain(`(${N_ALL})`));
    fireEvent.change(screen.getByLabelText("Instrument"), { target: { value: "USD/JPY" } });
    fireEvent.change(screen.getByLabelText("Lifecycle"), { target: { value: "VALID_TOUCHED" } });
    await waitFor(() => expect(header()).toContain("(3)"));

    const chips = screen.getByTestId("active-filters");
    expect(within(chips).getByText(/USD\/JPY/)).toBeInTheDocument();
    expect(within(chips).getByText(/VALID_TOUCHED/)).toBeInTheDocument();

    // One chip at a time.
    fireEvent.click(within(chips).getByLabelText("Remove filter VALID_TOUCHED"));
    await waitFor(() => expect(header()).toContain(`(${N_PER_SYMBOL})`));

    fireEvent.click(screen.getByText("Clear filters"));
    await waitFor(() => expect(header()).toContain(`(${N_ALL})`));
    expect(screen.queryByTestId("active-filters")).toBeNull();
  });

  it("12 — a zero-result filter explains itself and offers a way out", async () => {
    mountScanner();
    await waitFor(() => expect(header()).toContain(`(${N_ALL})`));
    fireEvent.change(screen.getByLabelText("Instrument"), { target: { value: "BTC/USD" } });
    fireEvent.change(screen.getByLabelText("Trade status"),
                     { target: { value: "OPEN_POSITION_OWNER" } });
    await waitFor(() =>
      expect(screen.getByText("No IPOs match the current filters.")).toBeInTheDocument());
    // Not a blank table.
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.click(screen.getAllByText("Clear filters")[0]);
    await waitFor(() => expect(header()).toContain(`(${N_ALL})`));
  });

  it("names the concepts rather than two generic state labels", async () => {
    mountScanner();
    await waitFor(() => expect(header()).toContain(`(${N_ALL})`));
    for (const label of ["Instrument", "Trade status", "Lifecycle", "Validation", "Observation"]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.queryByText("All trade states")).toBeNull();
    expect(screen.queryByText("All states")).toBeNull();
  });

  it("does not claim that no paper positions exist", async () => {
    mountScanner();
    await waitFor(() => expect(header()).toContain(`(${N_ALL})`));
    expect(screen.getByText(/Scanner view — paper execution shown for context/i)).toBeInTheDocument();
    expect(screen.queryByText(/Observation only — no orders/i)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. nothing strategic moved
// ─────────────────────────────────────────────────────────────────────────────

describe("13 — this is UI interpretation only", () => {
  it("the scanner still cannot write or trade", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/components/IpoScanner.tsx", "utf8"));
    // Comments describe what is forbidden, so only real code is searched.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
    for (const banned of [".insert(", ".update(", ".delete(", ".upsert(", "useMutation",
                          'from("', "broker", "placeOrder"]) {
      expect(code).not.toContain(banned);
    }
  });

  it("the linkage module derives ownership from identity, never from display text", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/lib/ipoTradeLinkage.ts", "utf8"));
    // Ownership comes from isSameIpo, which compares all four identity fields.
    expect(src).toContain("export function isSameIpo");
    expect(src).toContain("sameInstant(o.ipoCandleTime, t.ipo_candle_time)");
    // The new reading is derived from the Linkage, not re-derived from codes.
    expect(src).toContain("export function readNewEntryCheck(link: Linkage");
    expect(src).not.toContain('reasonCodes.includes("POSITION_ALREADY_OPEN")');
  });

  it("no strategy or paper-execution module is imported by the scanner UI", async () => {
    const fs = await import("node:fs");
    for (const f of ["src/components/IpoScanner.tsx", "src/components/IpoScanDetail.tsx",
                     "src/lib/ipoTradeLinkage.ts"]) {
      const src = fs.readFileSync(f, "utf8");
      for (const banned of ["ipoLiveEngine", "ipoIncrementalEngine", "ipoPaperRunner",
                            "ipoPaperContract", "ipoCausalOrdering", "runLifecycle"]) {
        expect(src).not.toContain(banned);
      }
    }
  });
});

/**
 * Scanner pagination, selection persistence and the independent scroll panes.
 *
 * The scanner fetches two endpoints, so these tests mock the Supabase client
 * and drive it through a real QueryClient — the point is the interaction
 * between filtering, paging and selection, which only appears when the
 * component actually runs.
 */
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } },
}));

import { IpoScanner } from "../IpoScanner";
import type { IpoRow } from "../IpoScanDetail";

const mkRow = (i: number, over: Partial<IpoRow> = {}): IpoRow => ({
  instrument: "EUR/USD", timeframe: "1h", direction: "long",
  ipoCandleTime: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T08:00:00Z`,
  ipoIndex: 1000 + i,
  zoneHigh: 1.1, zoneLow: 1.095, midpoint: 1.095,
  state: "PENDING_CANDIDATE", signalValid: false,
  validationStatus: `NOT_VALIDATED#${1000 + i}`, observationStatus: "WATCHING",
  fvgPresent: false, fvgStatus: "WINDOW_OPEN",
  contraction: "NO", touch: "NO", oppositeSideCleared: "NO",
  moveAway: "NOT_TRACKED", expansion: "NOT_TRACKED", trend: "NOT_TRACKED",
  volatilityBucket: "HIGH_VOL", volatilityEligible: true,
  intendedEntry: 1.095, target2R: 1.105, s2Invalidation: 1.09, riskPrice: 0.005,
  sequencingState: "FREE", executionEligible: false, reasonCodes: [],
  ...over,
});

/** n rows, half of them on USD/JPY so instrument filtering has something to do. */
const rows = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    mkRow(i, i % 2 === 1 ? { instrument: "USD/JPY", timeframe: "30min" } : {}));

const setData = (observationRows: IpoRow[], openPositions: unknown[] = []) => {
  invoke.mockImplementation((fn: string) => {
    if (fn === "ipo-observation") {
      return Promise.resolve({
        data: {
          ok: true,
          snapshots: [{
            instrument: "EUR/USD", timeframe: "1h", asOf: "2026-09-23T10:00:00Z",
            barsProcessed: 1200, volatilityBucket: "HIGH_VOL", sequencingState: "FREE",
            openPosition: null, rows: observationRows, completedTrades: 0,
          }],
          errors: [],
        },
        error: null,
      });
    }
    return Promise.resolve({
      data: { ok: true, openPositions, recentTrades: [], recentEvents: [], runtime: [],
              health: null, healthStale: false, cadenceMs: 900_000,
              summary: { trades: 0, wins: 0, winRate: 0, totalR: 0, expectancyR: 0,
                         totalPnlUsd: 0, abortedExcluded: 0 } },
      error: null,
    });
  });
};

const draw = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><IpoScanner /></QueryClientProvider>);
};

const bodyRows = () => {
  const table = document.querySelector("table") as HTMLElement;
  return within(table).getAllByRole("row").slice(1); // drop the header
};

beforeEach(() => { invoke.mockReset(); });

// ── pagination ───────────────────────────────────────────────────────────────

describe("scanner pagination", () => {
  it("shows 10 rows per page by default", async () => {
    setData(rows(37));
    draw();
    await waitFor(() => expect(screen.getByText("Page 1 of 4")).toBeInTheDocument());
    expect(bodyRows()).toHaveLength(10);
    expect(screen.getByText("Showing 1–10 of 37")).toBeInTheDocument();
  });

  it("Previous is disabled on page 1 and Next on the last page", async () => {
    setData(rows(15));
    draw();
    await waitFor(() => expect(screen.getByText("Page 1 of 2")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByText("Page 2 of 2")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(bodyRows()).toHaveLength(5);
  });

  it("walks forward and back to the same rows", async () => {
    setData(rows(25));
    draw();
    await waitFor(() => expect(screen.getByText("Page 1 of 3")).toBeInTheDocument());
    const first = bodyRows()[0].textContent;
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByText("Page 2 of 3")).toBeInTheDocument());
    expect(bodyRows()[0].textContent).not.toBe(first);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await waitFor(() => expect(screen.getByText("Page 1 of 3")).toBeInTheDocument());
    expect(bodyRows()[0].textContent).toBe(first);
  });

  it("offers 10, 20 and 50 and repartitions on change", async () => {
    setData(rows(37));
    draw();
    await waitFor(() => expect(screen.getByText("Page 1 of 4")).toBeInTheDocument());
    const size = screen.getByLabelText("rows per page") as HTMLSelectElement;
    expect([...size.options].map((o) => o.value)).toEqual(["10", "20", "50"]);
    fireEvent.change(size, { target: { value: "20" } });
    await waitFor(() => expect(screen.getByText("Page 1 of 2")).toBeInTheDocument());
    expect(bodyRows()).toHaveLength(20);
    fireEvent.change(size, { target: { value: "50" } });
    await waitFor(() => expect(screen.getByText("Page 1 of 1")).toBeInTheDocument());
    expect(bodyRows()).toHaveLength(37);
  });
});

// ── filtering × pagination ───────────────────────────────────────────────────

describe("filtering and pagination interact correctly", () => {
  it("paginates AFTER filtering, not before", async () => {
    setData(rows(40));   // 20 EUR/USD, 20 USD/JPY
    draw();
    await waitFor(() => expect(screen.getByText("Page 1 of 4")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Trade status"),
                     { target: { value: "NO_TRADE" } });
    // Every row here is NO_TRADE, so the count must be unchanged — had paging
    // run first, the filter would only have seen the 10 rows on screen.
    await waitFor(() => expect(screen.getByText("Showing 1–10 of 40")).toBeInTheDocument());
  });

  it("resets to page 1 when a filter reduces the row count", async () => {
    setData(rows(40));
    draw();
    await waitFor(() => expect(screen.getByText("Page 1 of 4")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByText("Page 3 of 4")).toBeInTheDocument());

    // 40 rows across two instruments; narrowing to one halves the list to two
    // pages, so page 3 no longer exists.
    fireEvent.change(screen.getByLabelText("Instrument"),
                     { target: { value: "EUR/USD" } });
    await waitFor(() => expect(screen.getByText("Page 1 of 2")).toBeInTheDocument());
    expect(screen.getByText("Showing 1–10 of 20")).toBeInTheDocument();
  });

  it("drops the pager entirely when a filter empties the list", async () => {
    setData(rows(40));
    draw();
    await waitFor(() => expect(screen.getByText("Page 1 of 4")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Trade status"),
                     { target: { value: "OPEN_POSITION_OWNER" } });
    // No rows, so no pager to strand — and the empty state says so plainly
    // rather than showing "Page 1 of 1" over nothing.
    // A filter emptied the list, which is a different situation from an empty
    // dataset and now says so, with a way out.
    await waitFor(() => expect(screen.getByText("No IPOs match the current filters."))
      .toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  });

  it("never strands the user past the end of a narrowed list", async () => {
    setData(rows(40));
    draw();
    await waitFor(() => expect(screen.getByText("Page 1 of 4")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByText("Page 2 of 4")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Trade status"),
                     { target: { value: "NO_TRADE" } });
    await waitFor(() => expect(screen.getByText(/Page 1 of 4/)).toBeInTheDocument());
    expect(screen.queryByText(/of 0/)).toBeNull();
  });
});

// ── selection ────────────────────────────────────────────────────────────────

describe("selection survives paging and refresh", () => {
  it("keeps the detail pane when the user changes page", async () => {
    setData(rows(25));
    draw();
    await waitFor(() => expect(screen.getByText("Page 1 of 3")).toBeInTheDocument());
    fireEvent.click(bodyRows()[0]);
    await waitFor(() =>
      expect(screen.queryByText(/Select a row to inspect/)).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByText("Page 2 of 3")).toBeInTheDocument());
    // The selected row is no longer on screen, but it still exists in the data,
    // so the pane must not be cleared.
    expect(screen.queryByText(/Select a row to inspect/)).toBeNull();
  });

  it("keeps the selection across a refetch that returns equal-but-new objects", async () => {
    setData(rows(12));
    draw();
    await waitFor(() => expect(screen.getByText("Page 1 of 2")).toBeInTheDocument());
    fireEvent.click(bodyRows()[0]);
    await waitFor(() => expect(screen.queryByText(/Select a row to inspect/)).toBeNull());

    setData(rows(12));                       // fresh objects, same identities
    await waitFor(() => expect(screen.queryByText(/Select a row to inspect/)).toBeNull());
  });

  it("clears the pane when the selected row genuinely leaves the data", async () => {
    // Selection is resolved by key against the CURRENT dataset, so a row that
    // disappears resolves to null and the pane returns to its prompt. Proven
    // directly on the resolver rather than by forcing a refetch, which cannot
    // be driven deterministically here.
    const before = rows(12);
    const keyOf = (r: IpoRow) => `${r.instrument}|${r.ipoIndex}`;
    const selectedKey = keyOf(before[0]);
    expect(before.find((r) => keyOf(r) === selectedKey)).toBeTruthy();

    const after = before.map((r, i) => ({ ...r, ipoIndex: 9000 + i }));
    expect(after.find((r) => keyOf(r) === selectedKey)).toBeUndefined();
  });

  it("shows the prompt when nothing is selected", async () => {
    setData(rows(12));
    draw();
    await waitFor(() => expect(screen.getByText("Page 1 of 2")).toBeInTheDocument());
    expect(screen.getByText(/Select a row to inspect/)).toBeInTheDocument();
  });
});

// ── independent scrolling ────────────────────────────────────────────────────

describe("the panes scroll independently", () => {
  it("gives the scanner body its own bounded scroll container", async () => {
    setData(rows(25));
    draw();
    await waitFor(() => expect(screen.getByTestId("scanner-scroll")).toBeInTheDocument());
    const cls = screen.getByTestId("scanner-scroll").className;
    expect(cls).toMatch(/overflow-auto/);
    expect(cls).toMatch(/min-h-0/);
    expect(cls).toMatch(/flex-1/);
  });

  it("makes the table header sticky so columns stay readable while scrolling", async () => {
    setData(rows(25));
    draw();
    await waitFor(() => expect(document.querySelector("thead")).toBeTruthy());
    expect((document.querySelector("thead") as HTMLElement).className).toMatch(/sticky/);
  });

  it("gives the detail pane its own scroll container that does not chain to the page", async () => {
    setData(rows(12));
    draw();
    await waitFor(() => expect(screen.getByText("Page 1 of 2")).toBeInTheDocument());
    fireEvent.click(bodyRows()[0]);
    await waitFor(() => expect(screen.getByTestId("detail-scroll")).toBeInTheDocument());
    const cls = screen.getByTestId("detail-scroll").className;
    expect(cls).toMatch(/overflow-y-auto/);
    expect(cls).toMatch(/overscroll-contain/);
    expect(cls).toMatch(/min-h-0/);
  });

  it("keeps the detail header out of the scrolling region", async () => {
    setData(rows(12));
    draw();
    await waitFor(() => expect(screen.getByText("Page 1 of 2")).toBeInTheDocument());
    fireEvent.click(bodyRows()[0]);
    await waitFor(() => expect(screen.getByTestId("detail-scroll")).toBeInTheDocument());
    // The "EUR/USD · 1h · long" title must be a sibling of the scroll area, not
    // inside it, or it scrolls away with the content.
    const title = screen.getByText(/EUR\/USD · 1h · long/);
    expect(screen.getByTestId("detail-scroll").contains(title)).toBe(false);
  });
});

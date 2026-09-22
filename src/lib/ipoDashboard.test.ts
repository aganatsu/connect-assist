import { describe, it, expect } from "vitest";
import {
  SMALL_SAMPLE_MAX, isSmallSample, pluralTrades, cleanTrades,
  equityCurveR, drawdownR, headline, explainStatus, explainableCodes,
  lifecycleStages, groupTrades, bySymbol, byBucket, byOrdinal, exitReasonSplit,
  filterTrades, filterOptions, filterIsActive, NO_FILTERS, planGeometry, gapState,
  type ClosedTradeLike, type OpenPositionLike,
} from "./ipoDashboard";

const trade = (over: Partial<ClosedTradeLike> = {}): ClosedTradeLike => ({
  symbol: "EUR/USD", direction: "long", exit_time: "2026-09-20T10:00:00Z",
  exit_reason: "TARGET_2R", realized_r: 2, realized_pnl_usd: 400,
  volatility_bucket: "HIGH_VOL", zone_entry_ordinal: 1, excluded_from_stats: false,
  ...over,
});

const position = (over: Partial<OpenPositionLike> = {}): OpenPositionLike => ({
  symbol: "USD/JPY", direction: "short", status: "open",
  entry_price: 157.5, target_price: 156.5, s2_invalidation_level: 158.0,
  nominal_risk_distance: 0.5, gap_reason: null, ...over,
});

// ── exclusion, which every statistic depends on ──────────────────────────────

describe("data-gap aborts never reach a statistic", () => {
  it("drops excluded rows and rows with no R", () => {
    const rows = [
      trade(),
      trade({ excluded_from_stats: true, realized_r: null, exit_reason: "DATA_GAP_ABORTED" }),
      trade({ realized_r: null }),
    ];
    expect(cleanTrades(rows)).toHaveLength(1);
  });

  it("counts them separately rather than hiding them", () => {
    const m = headline([], [trade(), trade({ excluded_from_stats: true, realized_r: null })]);
    expect(m.closedTrades).toBe(1);
    expect(m.abortedExcluded).toBe(1);
  });

  it("still shows them in the exit-reason split — an aborting run must be visible", () => {
    const split = exitReasonSplit([
      trade(), trade({ excluded_from_stats: true, realized_r: null, exit_reason: "DATA_GAP_ABORTED" }),
    ]);
    expect(split.find((s) => s.reason === "DATA_GAP_ABORTED")?.n).toBe(1);
  });
});

// ── summary metrics ──────────────────────────────────────────────────────────

describe("summary metrics", () => {
  it("computes counts, R, P&L, win rate and average over clean rows only", () => {
    const m = headline([position(), position({ symbol: "EUR/USD" })], [
      trade({ realized_r: 2, realized_pnl_usd: 400, exit_time: "2026-09-20T10:00:00Z" }),
      trade({ realized_r: -1.4, realized_pnl_usd: -280, exit_time: "2026-09-21T10:00:00Z", exit_reason: "S2_CLOSE_INVALIDATION" }),
      trade({ realized_r: 2, realized_pnl_usd: 400, exit_time: "2026-09-22T10:00:00Z" }),
      trade({ realized_r: null, excluded_from_stats: true, realized_pnl_usd: null }),
    ]);
    expect(m.openPositions).toBe(2);
    expect(m.closedTrades).toBe(3);
    expect(m.wins).toBe(2);
    expect(m.losses).toBe(1);
    expect(m.winRate).toBeCloseTo(2 / 3, 10);
    expect(m.totalR).toBeCloseTo(2.6, 10);
    expect(m.avgR).toBeCloseTo(2.6 / 3, 10);
    expect(m.totalPnlUsd).toBeCloseTo(520, 10);
  });

  it("a scratch is neither a win nor a loss", () => {
    const m = headline([], [trade({ realized_r: 0, realized_pnl_usd: 0 })]);
    expect(m.wins).toBe(0);
    expect(m.losses).toBe(0);
    expect(m.closedTrades).toBe(1);
  });

  it("is safe on an empty book rather than dividing by zero", () => {
    const m = headline([], []);
    expect(m.winRate).toBe(0);
    expect(m.avgR).toBe(0);
    expect(m.totalR).toBe(0);
    expect(Number.isNaN(m.avgR)).toBe(false);
  });
});

// ── drawdown ─────────────────────────────────────────────────────────────────

describe("drawdown over the realized-R curve", () => {
  const seq = (rs: number[]) =>
    rs.map((r, i) => trade({ realized_r: r, exit_time: `2026-09-${String(10 + i).padStart(2, "0")}T10:00:00Z` }));

  it("builds the curve oldest-first even though the endpoint returns newest-first", () => {
    const newestFirst = [...seq([1, -2, 3])].reverse();
    expect(equityCurveR(newestFirst).map((p) => p.cumR)).toEqual([1, -1, 2]);
  });

  it("measures peak to trough, not first to last", () => {
    // +3 then -2 then +1: peak 3, trough 1, so max drawdown is 2 even though the
    // curve ends positive.
    const d = drawdownR(seq([3, -2, 1]));
    expect(d.peakR).toBeCloseTo(3, 10);
    expect(d.maxR).toBeCloseTo(2, 10);
    expect(d.currentR).toBeCloseTo(1, 10);
  });

  it("reports zero when the curve only rises", () => {
    const d = drawdownR(seq([1, 1, 1]));
    expect(d.maxR).toBe(0);
    expect(d.currentR).toBe(0);
  });

  it("treats an opening loss as drawdown from a zero start", () => {
    expect(drawdownR(seq([-1.4])).maxR).toBeCloseTo(1.4, 10);
  });

  it("carries the window, because the endpoint caps its history", () => {
    expect(drawdownR(seq([1, 2, 3])).window).toBe(3);
    expect(drawdownR([]).window).toBe(0);
  });
});

// ── small sample ─────────────────────────────────────────────────────────────

describe("small-sample labelling", () => {
  it("flags anything under the threshold", () => {
    expect(isSmallSample(0)).toBe(true);
    expect(isSmallSample(1)).toBe(true);
    expect(isSmallSample(SMALL_SAMPLE_MAX - 1)).toBe(true);
    expect(isSmallSample(SMALL_SAMPLE_MAX)).toBe(false);
  });

  it("flags a 100% win rate over one trade", () => {
    const m = headline([], [trade({ realized_r: 2 })]);
    expect(m.winRate).toBe(1);
    expect(m.smallSample).toBe(true);
  });

  it("flags thin buckets independently of the overall sample", () => {
    const rows = [
      ...Array.from({ length: 25 }, (_, i) =>
        trade({ symbol: "EUR/USD", exit_time: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T10:00:00Z` })),
      trade({ symbol: "BTC/USD" }),
    ];
    expect(headline([], rows).smallSample).toBe(false);
    const groups = bySymbol(rows);
    expect(groups.find((g) => g.key === "EUR/USD")!.smallSample).toBe(false);
    expect(groups.find((g) => g.key === "BTC/USD")!.smallSample).toBe(true);
  });

  it("pluralises without tripping the journal-coupling guard", () => {
    expect(pluralTrades(1)).toBe("trade");
    expect(pluralTrades(0)).toBe("trades");
    expect(pluralTrades(2)).toBe("trades");
  });
});

// ── readable status mapping ──────────────────────────────────────────────────

describe("status codes become readable without losing the code", () => {
  const REQUIRED = [
    "BLOCKED_POSITION_OPEN", "POSITION_ALREADY_OPEN", "SUPPRESSED_IN_CONTRACTION",
    "NOT_TRACKED", "FREE", "ECONOMICALLY_UNTRADEABLE_COST",
    "COVERAGE_LOST", "GAP_SUSPENDED", "DATA_GAP_ABORTED",
  ];

  it("covers every code the dashboard is required to explain", () => {
    for (const c of REQUIRED) expect(explainableCodes()).toContain(c);
  });

  it("returns a sentence and keeps the raw code for every one of them", () => {
    for (const c of REQUIRED) {
      const e = explainStatus(c);
      expect(e.code).toBe(c);
      expect(e.headline.length).toBeGreaterThan(0);
      expect(e.headline).not.toBe(c);          // it was actually translated
      expect(e.detail.length).toBeGreaterThan(10);
    }
  });

  it("distinguishes the costR block from the sequencing block", () => {
    expect(explainStatus("ECONOMICALLY_UNTRADEABLE_COST").headline).toMatch(/cost/i);
    expect(explainStatus("ECONOMICALLY_UNTRADEABLE_COST").tone).toBe("warn");
    expect(explainStatus("POSITION_ALREADY_OPEN").headline).toMatch(/already open/i);
  });

  it("treats a healthy state as healthy, not as a warning", () => {
    expect(explainStatus("FREE").tone).toBe("good");
    expect(explainStatus("GAP_RECOVERED").tone).toBe("good");
    expect(explainStatus("TARGET_2R").tone).toBe("good");
    expect(explainStatus("UNAVAILABLE").tone).toBe("neutral");
  });

  it("says S2 can exceed 1R, because a wick does not close a position", () => {
    expect(explainStatus("S2_CLOSE_INVALIDATION").detail).toMatch(/CLOSED/);
    expect(explainStatus("S2_CLOSE_INVALIDATION").detail).toMatch(/exceed 1R/);
  });

  it("passes an unknown code through instead of guessing", () => {
    const e = explainStatus("SOME_NEW_CODE");
    expect(e.code).toBe("SOME_NEW_CODE");
    expect(e.headline).toBe("SOME_NEW_CODE");
    expect(e.detail).toMatch(/Unrecognised/);
  });

  it("handles a missing code without throwing", () => {
    expect(explainStatus(null).headline).toBe("—");
    expect(explainStatus(undefined).code).toBe("—");
  });
});

// ── lifecycle ────────────────────────────────────────────────────────────────

describe("lifecycle progression", () => {
  const base = { validCandidates: 0, touched: null, openPositions: 0, closedAtTarget: 0, closedAtS2: 0 };

  it("runs VALID IPO → TOUCH → TREND → POSITION OPEN → TARGET / S2", () => {
    expect(lifecycleStages(base).map((s) => s.key))
      .toEqual(["VALID_IPO", "TOUCH", "TREND", "POSITION_OPEN", "RESOLVED"]);
  });

  it("never claims TREND — the frozen rules do not compute it", () => {
    for (const input of [base, { ...base, validCandidates: 9, openPositions: 2, closedAtTarget: 5 }]) {
      const trend = lifecycleStages(input).find((s) => s.key === "TREND")!;
      expect(trend.status).toBe("not_tracked");
      expect(trend.detail).toMatch(/not computed/);
    }
  });

  it("marks TOUCH not tracked when the caller has no touch data, rather than inferring it", () => {
    const touch = lifecycleStages({ ...base, validCandidates: 4 }).find((s) => s.key === "TOUCH")!;
    expect(touch.status).toBe("not_tracked");
    expect(touch.detail).toMatch(/Scanner/);
  });

  it("uses a real touch count when one is supplied", () => {
    expect(lifecycleStages({ ...base, touched: 3 }).find((s) => s.key === "TOUCH")!.status).toBe("done");
    expect(lifecycleStages({ ...base, touched: 0 }).find((s) => s.key === "TOUCH")!.status).toBe("pending");
  });

  it("shows an open position as active and a resolved one as done", () => {
    const s = lifecycleStages({ ...base, openPositions: 1, closedAtTarget: 2, closedAtS2: 1 });
    expect(s.find((x) => x.key === "POSITION_OPEN")!.status).toBe("active");
    const resolved = s.find((x) => x.key === "RESOLVED")!;
    expect(resolved.status).toBe("done");
    expect(resolved.detail).toBe("2 target · 1 S2");
  });
});

// ── grouping ─────────────────────────────────────────────────────────────────

describe("performance breakdowns", () => {
  const rows = [
    trade({ symbol: "EUR/USD", volatility_bucket: "HIGH_VOL", zone_entry_ordinal: 1, realized_r: 2 }),
    trade({ symbol: "EUR/USD", volatility_bucket: "LOW_VOL", zone_entry_ordinal: 2, realized_r: -1 }),
    trade({ symbol: "USD/JPY", volatility_bucket: "HIGH_VOL", zone_entry_ordinal: null, realized_r: 2 }),
  ];

  it("groups by symbol with correct R and win counts", () => {
    const g = bySymbol(rows);
    const eur = g.find((x) => x.key === "EUR/USD")!;
    expect(eur.n).toBe(2);
    expect(eur.wins).toBe(1);
    expect(eur.losses).toBe(1);
    expect(eur.totalR).toBeCloseTo(1, 10);
    expect(eur.avgR).toBeCloseTo(0.5, 10);
  });

  it("groups by volatility bucket", () => {
    expect(byBucket(rows).find((x) => x.key === "HIGH_VOL")!.n).toBe(2);
  });

  it("groups by re-entry ordinal and labels a missing ordinal rather than dropping it", () => {
    const g = byOrdinal(rows);
    expect(g.map((x) => x.key).sort()).toEqual(["#1", "#2", "unknown"]);
  });

  it("orders groups by size so the biggest bucket reads first", () => {
    expect(bySymbol(rows)[0].key).toBe("EUR/USD");
  });

  it("splits exit reasons with shares that sum to one", () => {
    const split = exitReasonSplit([
      trade({ exit_reason: "TARGET_2R" }), trade({ exit_reason: "TARGET_2R" }),
      trade({ exit_reason: "S2_CLOSE_INVALIDATION" }),
    ]);
    expect(split[0]).toMatchObject({ reason: "TARGET_2R", n: 2 });
    expect(split.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1, 10);
  });

  it("does not divide by zero on an empty set", () => {
    expect(groupTrades([], (t) => t.symbol)).toEqual([]);
    expect(exitReasonSplit([])).toEqual([]);
  });
});

// ── filters ──────────────────────────────────────────────────────────────────

describe("client-side filters", () => {
  const rows = [
    trade({ symbol: "EUR/USD", volatility_bucket: "HIGH_VOL", zone_entry_ordinal: 1,
            exit_reason: "TARGET_2R", exit_time: "2026-09-10T10:00:00Z" }),
    trade({ symbol: "USD/JPY", volatility_bucket: "LOW_VOL", zone_entry_ordinal: 2,
            exit_reason: "S2_CLOSE_INVALIDATION", exit_time: "2026-09-15T10:00:00Z" }),
    trade({ symbol: "BTC/USD", volatility_bucket: "HIGH_VOL", zone_entry_ordinal: null,
            exit_reason: "DATA_GAP_ABORTED", exit_time: "2026-09-20T10:00:00Z" }),
  ];

  it("returns everything by default", () => {
    expect(filterTrades(rows, NO_FILTERS)).toHaveLength(3);
    expect(filterIsActive(NO_FILTERS)).toBe(false);
  });

  it("filters by each dimension", () => {
    expect(filterTrades(rows, { ...NO_FILTERS, symbol: "USD/JPY" })).toHaveLength(1);
    expect(filterTrades(rows, { ...NO_FILTERS, bucket: "HIGH_VOL" })).toHaveLength(2);
    expect(filterTrades(rows, { ...NO_FILTERS, ordinal: "#2" })).toHaveLength(1);
    expect(filterTrades(rows, { ...NO_FILTERS, ordinal: "unknown" })).toHaveLength(1);
    expect(filterTrades(rows, { ...NO_FILTERS, exitReason: "TARGET_2R" })).toHaveLength(1);
  });

  it("combines filters as AND", () => {
    expect(filterTrades(rows, { ...NO_FILTERS, bucket: "HIGH_VOL", symbol: "BTC/USD" })).toHaveLength(1);
    expect(filterTrades(rows, { ...NO_FILTERS, bucket: "LOW_VOL", symbol: "BTC/USD" })).toHaveLength(0);
  });

  it("treats a single-day range as that whole day, both ends inclusive", () => {
    expect(filterTrades(rows, { ...NO_FILTERS, from: "2026-09-15", to: "2026-09-15" })).toHaveLength(1);
    expect(filterTrades(rows, { ...NO_FILTERS, from: "2026-09-10", to: "2026-09-20" })).toHaveLength(3);
    expect(filterTrades(rows, { ...NO_FILTERS, from: "2026-09-16" })).toHaveLength(1);
    expect(filterTrades(rows, { ...NO_FILTERS, to: "2026-09-09" })).toHaveLength(0);
  });

  it("knows when a filter is active, so the UI can offer a reset", () => {
    expect(filterIsActive({ ...NO_FILTERS, symbol: "EUR/USD" })).toBe(true);
    expect(filterIsActive({ ...NO_FILTERS, from: "2026-09-01" })).toBe(true);
  });

  it("offers only values the data actually contains", () => {
    const o = filterOptions(rows);
    expect(o.symbols).toEqual(["BTC/USD", "EUR/USD", "USD/JPY"]);
    expect(o.buckets).toEqual(["HIGH_VOL", "LOW_VOL"]);
    expect(o.ordinals).toEqual(["#1", "#2", "unknown"]);
    expect(o.exitReasons).toContain("DATA_GAP_ABORTED");
  });
});

// ── open-position geometry ───────────────────────────────────────────────────

describe("open-position plan geometry", () => {
  it("measures from entry, and the 2R target really is 2R", () => {
    const g = planGeometry(position());
    expect(g.toTarget).toBeCloseTo(1.0, 10);
    expect(g.toTargetR).toBeCloseTo(2.0, 10);
    expect(g.toS2).toBeCloseTo(0.5, 10);
    expect(g.toS2R).toBeCloseTo(1.0, 10);
  });

  it("is direction-agnostic — a long reads the same way", () => {
    const g = planGeometry(position({
      direction: "long", entry_price: 1.1, target_price: 1.12,
      s2_invalidation_level: 1.09, nominal_risk_distance: 0.01,
    }));
    expect(g.toTargetR).toBeCloseTo(2, 10);
    expect(g.toS2R).toBeCloseTo(1, 10);
  });

  it("does not divide by zero when the risk distance is degenerate", () => {
    const g = planGeometry(position({ nominal_risk_distance: 0 }));
    expect(Number.isFinite(g.toTargetR)).toBe(true);
  });

  it("reads a live position as calm and a suspended one as a gap", () => {
    expect(gapState(position()).tone).toBe("good");
    const susp = gapState(position({ status: "data_gap_suspended", gap_reason: "COVERAGE_LOST" }));
    expect(susp.code).toBe("COVERAGE_LOST");
    expect(susp.tone).toBe("bad");
    expect(susp.headline).toMatch(/gap/i);
  });
});

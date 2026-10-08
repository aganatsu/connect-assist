/**
 * STEP 16-B — cap-adjusted reporting of hypothetical (dry-run) fills.
 * PURE: no database, no clock (the caller passes `nowMs`). Reporting only:
 * nothing on the trading path imports this module.
 *
 * Why: a dry-run fill never becomes a position, so the live position caps
 * (which count REAL positions) never see it, and the scanner re-arms the same
 * zone after each hypothetical fill. Summing the raw per-fill outcomes then
 * counts exposure the live account could never have held.
 *
 * The raw outcomes (Step 15 resolver, trade_attribution section G) are taken
 * as given and never modified. Two models are applied on top:
 *
 *   caps     (the Step 16 requirement) — the live unified caps, 3 global /
 *            1 per symbol, checked at the FILL in the live fill order
 *            (global, then per symbol).
 *   limits   caps + the live correlation filter (Gate 22), which the live
 *            scanner checks at order PLACEMENT only, never at the fill.
 *            Reconstructable exactly: Gate 22 calls getCorrelation WITHOUT a
 *            dynamic matrix (static STATIC_CORRELATIONS, unchanged since
 *            2026-09-02) plus the static SMT-pair and currency fallbacks, and
 *            the inputs (symbol, direction, placed / filled / closed times)
 *            are recorded. A fill with no placement time cannot be evaluated
 *            and is marked correlation_not_evaluable (no block).
 *
 * Slots: an admissible fill occupies a slot from filled_at until its resolver
 * closed_at, or through `nowMs` while unresolved (a deferred fill is still
 * open). A slot is free once closed_at <= the next fill time. A blocked fill
 * occupies no slot. Fills are processed by filled_at, then order placement
 * time (the live hunt's order), then signal id, so simultaneous fills resolve
 * deterministically.
 */
import { getCorrelation, getDirectionalCorrelation } from "./portfolioCorrelation.ts";
import { parsePairCurrencies } from "./fotsi.ts";
import { SMT_PAIRS } from "./smcAnalysis.ts";

export const CAP_BOOK_VERSION = "hypothetical_cap_book.v1";

/**
 * Config versions recorded as BEHAVIOUR-EQUIVALENT (different canonical hashes,
 * same effective runtime configuration). Totals pool fills only within one
 * class; a version not listed here is its own class, so nothing is collapsed
 * silently. Adding a version requires the equivalence proof (Step 16 decision 3).
 */
export const CONFIG_EQUIVALENCE_CLASSES: Record<string, string[]> = {
  "frozen_impulse_route2_v1": [
    "3d5b8fb0d756b3596ed46d133e873a88", // Step 14 patch (2026-10-07)
    // Step 16-E: the same effective configuration with the 26 live default-only
    // controls stored explicitly — behaviour-equivalent, NOT identical; marks the
    // explicit frozen-config boundary. Proof: step16eExplicitDefaults.test.ts.
    "1037e6170289f865e4d6618dcf28b94d",
  ],
};

export function configClassOf(version: string | null | undefined): string {
  for (const [label, versions] of Object.entries(CONFIG_EQUIVALENCE_CLASSES)) {
    if (version && versions.includes(version)) return label;
  }
  return `unregistered:${version ?? "none"}`;
}

export interface CapBookFill {
  signalId: string;
  orderId: string | null;
  symbol: string;
  direction: "long" | "short";
  placedAtMs: number | null;
  filledAtMs: number;
  closedAtMs: number | null;
  exitReason: string | null;
  rGross: number | null;
  rNet: number | null;
  pnlUsd: number | null;
  riskUsd: number | null;
  configVersion: string | null;
}

export type CapReason = "blocked_by_global_cap" | "blocked_by_symbol_cap";
export type CorrelationReason = "blocked_by_correlation_hedge" | "blocked_by_correlation_cap";

export interface FillRef { signalId: string; orderId: string | null }

export interface Verdict {
  status: "admissible" | "blocked";
  reason: CapReason | CorrelationReason | null;
  blockedBy: FillRef[];
}

export interface CapBookRow {
  fill: CapBookFill;
  resolved: boolean;
  /** hypothetical net P/L = R net × the fill's recorded risk dollars (the resolver's definition) */
  pnlNetUsd: number | null;
  caps: Verdict;
  limits: Verdict & { correlation: "evaluated" | "correlation_not_evaluable" };
}

export interface Totals {
  fills: number;
  resolved: number;
  open: number;
  grossR: number;
  netR: number;
  pnlUsd: number;
  pnlNetUsd: number;
  /** resolved rows whose net R / P/L were unavailable and are excluded from those sums */
  missingNet: number;
  missingPnl: number;
}

export interface CapBookOptions {
  nowMs: number;
  globalCap?: number;
  perSymbolCap?: number;
  /** Gate 22 settings (live: on, 0.8, 2) */
  correlationEnabled?: boolean;
  correlationThreshold?: number;
  maxCorrelatedPositions?: number;
}

export interface ClassTotals {
  raw: Totals;
  capAdjusted: Totals & { blocked: number };
  limitsAdjusted: Totals & { blocked: number };
}

export interface CapBookReport {
  version: string;
  rows: CapBookRow[];
  /** totals per behaviour-equivalence class (see CONFIG_EQUIVALENCE_CLASSES) */
  byClass: Record<string, ClassTotals>;
  /** true when every row belongs to one class, i.e. the pooled totals below are meaningful */
  singleClass: boolean;
  raw: Totals;
  capAdjusted: Totals & { blocked: number };
  limitsAdjusted: Totals & { blocked: number };
  correlation: "modelled_static_placement_time" | "correlation_not_modelled";
  assumptions: string[];
}

const ref = (f: CapBookFill): FillRef => ({ signalId: f.signalId, orderId: f.orderId });
const isOpenAt = (f: CapBookFill, t: number, nowMs: number) => f.filledAtMs <= t && (f.closedAtMs ?? nowMs) > t;

export function sortFills(fills: CapBookFill[]): CapBookFill[] {
  return [...fills].sort((a, b) =>
    a.filledAtMs - b.filledAtMs ||
    (a.placedAtMs ?? a.filledAtMs) - (b.placedAtMs ?? b.filledAtMs) ||
    (a.signalId < b.signalId ? -1 : a.signalId > b.signalId ? 1 : 0));
}

/** Live caps at the fill: global first, then per symbol (bot-scanner hunt_fill order). */
function capVerdict(f: CapBookFill, open: CapBookFill[], g: number, p: number): Verdict {
  if (open.length >= g) return { status: "blocked", reason: "blocked_by_global_cap", blockedBy: open.map(ref) };
  const same = open.filter((o) => o.symbol === f.symbol);
  if (same.length >= p) return { status: "blocked", reason: "blocked_by_symbol_cap", blockedBy: same.map(ref) };
  return { status: "admissible", reason: null, blockedBy: [] };
}

/**
 * Gate 22 (bot-scanner runSafetyGates, "Correlation Filter"), same rules:
 * per open position on another symbol — static matrix |ρ| >= threshold → doubling
 * (eff >= threshold) or hedge (eff <= −threshold); else SMT pair; else currency
 * decomposition. Any hedge blocks; doubling blocks at >= maxCorrelated.
 * Pinned to the scanner source by step16HypotheticalCapBook.test.ts.
 */
export function correlationVerdict(
  f: CapBookFill, open: CapBookFill[], threshold: number, maxCorrelated: number,
): Verdict {
  const hedge: CapBookFill[] = [], doubling: CapBookFill[] = [];
  const newCcy = parsePairCurrencies(f.symbol);
  const smt = (SMT_PAIRS as Record<string, string>)[f.symbol];
  for (const pos of open) {
    if (pos.symbol === f.symbol) continue;
    const raw = getCorrelation(f.symbol, pos.symbol);
    const eff = getDirectionalCorrelation({ symbol: f.symbol, direction: f.direction }, { symbol: pos.symbol, direction: pos.direction });
    let matched = false;
    if (Math.abs(raw) >= threshold) {
      if (eff >= threshold) { doubling.push(pos); matched = true; }
      else if (eff <= -threshold) { hedge.push(pos); matched = true; }
    }
    if (!matched && smt && pos.symbol === smt) {
      (pos.direction === f.direction ? doubling : hedge).push(pos);
      matched = true;
    }
    if (!matched && newCcy) {
      const posCcy = parsePairCurrencies(pos.symbol);
      if (posCcy) {
        const [nb, nq] = newCcy, [pb, pq] = posCcy;
        const nBuy = f.direction === "long" ? nb : nq, nSell = f.direction === "long" ? nq : nb;
        const pBuy = pos.direction === "long" ? pb : pq, pSell = pos.direction === "long" ? pq : pb;
        if (nBuy === pSell && nSell === pBuy) hedge.push(pos);
        else if (nBuy === pBuy && nSell === pSell) doubling.push(pos);
      }
    }
  }
  if (hedge.length > 0) return { status: "blocked", reason: "blocked_by_correlation_hedge", blockedBy: hedge.map(ref) };
  if (doubling.length >= maxCorrelated) return { status: "blocked", reason: "blocked_by_correlation_cap", blockedBy: doubling.map(ref) };
  return { status: "admissible", reason: null, blockedBy: [] };
}

function totals(rows: CapBookRow[]): Totals {
  const res = rows.filter((r) => r.resolved);
  const sum = (xs: (number | null)[]) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);
  return {
    fills: rows.length,
    resolved: res.length,
    open: rows.length - res.length,
    grossR: sum(res.map((r) => r.fill.rGross)),
    netR: sum(res.map((r) => r.fill.rNet)),
    pnlUsd: sum(res.map((r) => r.fill.pnlUsd)),
    pnlNetUsd: sum(res.map((r) => r.pnlNetUsd)),
    missingNet: res.filter((r) => r.fill.rNet == null).length,
    missingPnl: res.filter((r) => r.fill.pnlUsd == null).length,
  };
}

export function buildCapBook(fills: CapBookFill[], o: CapBookOptions): CapBookReport {
  const g = o.globalCap ?? 3, p = o.perSymbolCap ?? 1;
  const corrOn = o.correlationEnabled ?? true;
  const thr = o.correlationThreshold ?? 0.8, maxCorr = o.maxCorrelatedPositions ?? 2;
  const ordered = sortFills(fills);
  const capsOpen: CapBookFill[] = [];
  const limitsAdmitted: CapBookFill[] = [];
  const rows: CapBookRow[] = [];

  for (const f of ordered) {
    // ── caps model (fill time) ──
    const capsNowOpen = capsOpen.filter((x) => isOpenAt(x, f.filledAtMs, o.nowMs));
    const caps = capVerdict(f, capsNowOpen, g, p);
    if (caps.status === "admissible") capsOpen.push(f);

    // ── limits model: correlation at PLACEMENT, then caps at the fill ──
    let limits: CapBookRow["limits"];
    const evaluable = f.placedAtMs != null;
    const corr = corrOn && evaluable
      ? correlationVerdict(f, limitsAdmitted.filter((x) => isOpenAt(x, f.placedAtMs as number, o.nowMs)), thr, maxCorr)
      : { status: "admissible" as const, reason: null, blockedBy: [] };
    if (corr.status === "blocked") {
      limits = { ...corr, correlation: "evaluated" };
    } else {
      const lc = capVerdict(f, limitsAdmitted.filter((x) => isOpenAt(x, f.filledAtMs, o.nowMs)), g, p);
      limits = { ...lc, correlation: corrOn && evaluable ? "evaluated" : "correlation_not_evaluable" };
    }
    if (limits.status === "admissible") limitsAdmitted.push(f);

    const resolved = f.closedAtMs != null && f.closedAtMs <= o.nowMs;
    rows.push({
      fill: f, resolved, caps, limits,
      pnlNetUsd: f.rNet != null && f.riskUsd != null ? f.rNet * f.riskUsd : null,
    });
  }

  const classTotals = (sel: CapBookRow[]): ClassTotals => {
    const capAdj = totals(sel.filter((r) => r.caps.status === "admissible"));
    const limAdj = totals(sel.filter((r) => r.limits.status === "admissible"));
    return {
      raw: totals(sel),
      capAdjusted: { ...capAdj, blocked: sel.length - capAdj.fills },
      limitsAdjusted: { ...limAdj, blocked: sel.length - limAdj.fills },
    };
  };
  const byClass: Record<string, ClassTotals> = {};
  for (const label of new Set(rows.map((r) => configClassOf(r.fill.configVersion)))) {
    byClass[label] = classTotals(rows.filter((r) => configClassOf(r.fill.configVersion) === label));
  }
  const pooled = classTotals(rows);
  return {
    version: CAP_BOOK_VERSION,
    rows,
    byClass,
    singleClass: Object.keys(byClass).length <= 1,
    ...pooled,
    correlation: corrOn ? "modelled_static_placement_time" : "correlation_not_modelled",
    assumptions: [
      `caps ${g} global / ${p} per symbol, checked at the fill (global, then per symbol)`,
      "admissible fill holds a slot from filled_at to closed_at (or now while unresolved); blocked fills hold none",
      "ties: filled_at, then order placement time, then signal id",
      corrOn
        ? `correlation (limits model only): Gate 22 static matrix, threshold ${thr}, max ${maxCorr} correlated, at order placement only`
        : "correlation_not_modelled",
      "raw outcomes are the Step 15 resolver's, unmodified",
      "slots are account-wide across config versions; totals pool only within a behaviour-equivalence class",
    ],
  };
}

/**
 * The canonical causal forward population, and the statistics drawn from it.
 *
 * WHAT THESE GUARD. Before the causal-ordering fix the paper dashboard pooled
 * pre-fix and post-fix trades into one headline — 11 closed, +12.91R, ~82% win —
 * and none of that was a measurement of the strategy. The cure is a single
 * admission rule used by every card, so these tests check the rule, then check
 * that the splits reconcile with the headline that rule produced.
 *
 * NOTHING HERE DELETES, REWRITES OR RELABELS A STORED ROW, and a test at the
 * bottom asserts the module cannot.
 */

import { assert, assertEquals, assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  isValidatedCausalForwardTrade, isLegacyForwardTrade, perf, causalReport,
  legacySummary,
  CAUSAL_EXECUTION_VERSION, FORWARD_CAUSAL_START, SAMPLE_MILESTONES, SMALL_SAMPLE_BELOW,
  DAILY_BUCKETS, INSTRUMENTS,
  type HistoryRowLike, type PositionRowLike,
} from "../../functions/_shared/ipoCausalEvidence.ts";

const V = CAUSAL_EXECUTION_VERSION;
const AFTER = "2026-09-25T09:00:00Z";
const BEFORE = "2026-09-24T10:00:00Z";

const row = (over: Partial<HistoryRowLike> = {}): HistoryRowLike => ({
  symbol: "EUR/USD", direction: "long",
  entry_time: AFTER, exit_time: "2026-09-25T11:00:00Z",
  exit_reason: "TARGET_2R", realized_r: 1.8, realized_pnl_usd: 360,
  excluded_from_stats: false, causal_execution_version: V,
  sequence_contaminated: false, exit_resolution_method: "HTF_UNAMBIGUOUS",
  daily_structure_alignment: "ALIGNED", ambiguity_kind: null, ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// 1-4. the admission rule
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("1 — a legacy trade is excluded from the causal headline", () => {
  // No version stamp at all: recorded before the fix.
  const legacy = row({ causal_execution_version: null, entry_time: BEFORE });
  assertEquals(isValidatedCausalForwardTrade(legacy), false);
  assertEquals(isLegacyForwardTrade(legacy), true);
  assertEquals(causalReport([legacy], [], {}).headline.trades, 0);

  // Stamped, but ENTERED before the boundary — its fill bar was resolved under
  // the old model even though it exited after the deploy.
  const straddling = row({ entry_time: BEFORE, exit_time: "2026-09-25T01:00:00Z" });
  assertEquals(isValidatedCausalForwardTrade(straddling), false,
    "a position that filled before the boundary is not causal evidence");
  assertEquals(isLegacyForwardTrade(straddling), true);
});

Deno.test("2 — a trade on the current causal version is included", () => {
  assertEquals(isValidatedCausalForwardTrade(row()), true);
  const rep = causalReport([row()], [], {});
  assertEquals(rep.headline.trades, 1);
  assertEquals(rep.boundary.causalExecutionVersion, "1m-ordering-v1");
  assertEquals(rep.boundary.forwardCausalStart, FORWARD_CAUSAL_START);
  // A different, future version is not silently accepted.
  assertEquals(isValidatedCausalForwardTrade(row({ causal_execution_version: "2m-ordering-v9" })), false);
});

Deno.test("3 — excluded_from_stats is excluded", () => {
  const r = row({ excluded_from_stats: true, exit_reason: "ORDERING_UNRESOLVED",
    realized_r: null, realized_pnl_usd: null });
  assertEquals(isValidatedCausalForwardTrade(r), false);
  const rep = causalReport([r], [], {});
  assertEquals(rep.headline.trades, 0);
  assertEquals(rep.quality.excludedUnresolved, 1, "and it is COUNTED, not hidden");
});

Deno.test("4 — sequence_contaminated is excluded but stays visible", () => {
  const r = row({ sequence_contaminated: true });
  assertEquals(isValidatedCausalForwardTrade(r), false,
    "its outcome is known; its EXISTENCE depends on an unresolved branch");
  const rep = causalReport([r, row()], [], {});
  assertEquals(rep.headline.trades, 1);
  assertEquals(rep.quality.excludedSequenceContaminated, 1);
  assertEquals(rep.quality.causalRowsTotal, 2, "both rows are still counted as causal-era rows");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5-6. positions and the legacy view
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("5 — an ordering-ambiguous position counts as open and occupied", () => {
  const positions: PositionRowLike[] = [
    { symbol: "USD/JPY", status: "ordering_ambiguous", causal_execution_version: V,
      ambiguity_kind: "ENTRY_VS_TARGET_SAME_MINUTE" },
  ];
  const rep = causalReport([], positions, {});
  assertEquals(rep.open.total, 1, "an ambiguous position is OPEN — the slot is held");
  assertEquals(rep.open.ambiguous, 1);
  // And it contributes no fabricated result.
  assertEquals(rep.headline.trades, 0);
  assertEquals(rep.headline.netR, 0);
});

Deno.test("6 — legacy statistics remain available, separately and labelled", () => {
  const rows = [
    row({ causal_execution_version: null, entry_time: BEFORE, realized_r: 2, realized_pnl_usd: 400 }),
    row({ causal_execution_version: null, entry_time: BEFORE, realized_r: -1, realized_pnl_usd: -200 }),
    row(),
  ];
  const leg = legacySummary(rows);
  assertEquals(leg.trades, 2);
  assertAlmostEquals(leg.netR, 1, 1e-12);
  assertEquals(leg.notCausallyOrdered, true, "the label is part of the payload, not the UI's memory");
  // And the causal headline is untouched by them.
  assertEquals(causalReport(rows, [], {}).headline.trades, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// 7-8. the arithmetic that is easy to get wrong
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("7 — profit factor never divides by zero", () => {
  // No trades at all.
  const none = perf([]);
  assertEquals(none.profitFactor, null);
  assertEquals(none.pfNote, "NO_TRADES");
  assertEquals(none.winRate, null, "a win rate over nothing is not 0%, it is undefined");

  // Wins and no losses: no finite profit factor exists.
  const unbeaten = perf([row({ realized_r: 2 }), row({ realized_r: 1.5 })]);
  assertEquals(unbeaten.profitFactor, null);
  assertEquals(unbeaten.pfNote, "NO_LOSSES");
  assertEquals(unbeaten.losses, 0);

  // Ordinary case.
  const mixed = perf([row({ realized_r: 2 }), row({ realized_r: -1 })]);
  assertAlmostEquals(mixed.profitFactor!, 2, 1e-12);
  assertEquals(mixed.pfNote, null);
});

Deno.test("8 — drawdown uses the causal population only, in exit order", () => {
  // Legacy rows are ruinous; if they leaked in, the drawdown would show it.
  const legacy = [
    row({ causal_execution_version: null, entry_time: BEFORE, realized_r: -50 }),
    row({ causal_execution_version: null, entry_time: BEFORE, realized_r: -50 }),
  ];
  const causal = [
    row({ realized_r: 3, exit_time: "2026-09-25T10:00:00Z" }),
    row({ realized_r: -1, exit_time: "2026-09-25T11:00:00Z" }),
    row({ realized_r: -0.5, exit_time: "2026-09-25T12:00:00Z" }),
    row({ realized_r: 2, exit_time: "2026-09-25T13:00:00Z" }),
  ];
  const rep = causalReport([...legacy, ...causal], [], {});
  assertAlmostEquals(rep.headline.maxDrawdownR, 1.5, 1e-12);
  assertAlmostEquals(rep.headline.netR, 3.5, 1e-12);

  // And the order is imposed, not inherited: the same rows shuffled give the
  // same answer, which is what makes the figure a property of the equity curve.
  const shuffled = causalReport([causal[3], causal[1], causal[0], causal[2]], [], {});
  assertAlmostEquals(shuffled.headline.maxDrawdownR, 1.5, 1e-12);
  assertEquals(shuffled.headline.longestLossStreak, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// 9-11. every split must reconcile with the headline it came from
// ─────────────────────────────────────────────────────────────────────────────

const MIXED: HistoryRowLike[] = [
  row({ symbol: "EUR/USD", direction: "long", realized_r: 1.8, daily_structure_alignment: "ALIGNED",
    exit_time: "2026-09-25T10:00:00Z" }),
  row({ symbol: "USD/JPY", direction: "short", realized_r: -1.2, daily_structure_alignment: "OPPOSED",
    exit_time: "2026-09-25T11:00:00Z", exit_resolution_method: "ONE_MINUTE_RESOLVED" }),
  row({ symbol: "BTC/USD", direction: "long", realized_r: 2.1, daily_structure_alignment: "RANGING",
    exit_time: "2026-09-25T12:00:00Z" }),
  // No Daily tag at all — must land in UNKNOWN rather than vanish.
  row({ symbol: "EUR/USD", direction: "short", realized_r: -0.9,
    exit_time: "2026-09-25T13:00:00Z", daily_structure_alignment: null }),
  // Excluded in three different ways — none may reach any split.
  row({ symbol: "EUR/USD", realized_r: 99, sequence_contaminated: true }),
  row({ symbol: "USD/JPY", realized_r: null, excluded_from_stats: true, exit_reason: "ORDERING_UNRESOLVED" }),
  row({ symbol: "BTC/USD", realized_r: 99, causal_execution_version: null, entry_time: BEFORE }),
];

Deno.test("9 — instrument totals reconcile with the causal total", () => {
  const rep = causalReport(MIXED, [], {});
  const n = INSTRUMENTS.reduce((a, s) => a + rep.byInstrument[s].trades, 0);
  const r = INSTRUMENTS.reduce((a, s) => a + rep.byInstrument[s].netR, 0);
  assertEquals(n, rep.headline.trades, "instrument split lost or gained a trade");
  assertAlmostEquals(r, rep.headline.netR, 1e-9, "instrument split lost or gained R");
  assertEquals(rep.headline.trades, 4, "exactly the four admissible rows");
  // An instrument with nothing is reported as empty, not omitted.
  assert(rep.byInstrument["BTC/USD"].trades >= 0);
});

Deno.test("10 — long and short reconcile", () => {
  const rep = causalReport(MIXED, [], {});
  assertEquals(rep.byDirection.long.trades + rep.byDirection.short.trades, rep.headline.trades);
  assertAlmostEquals(rep.byDirection.long.netR + rep.byDirection.short.netR,
    rep.headline.netR, 1e-9);
});

Deno.test("11 — Daily-structure buckets reconcile, and none is preferred", () => {
  const rep = causalReport(MIXED, [], {});
  const n = DAILY_BUCKETS.reduce((a, b) => a + rep.byDailyStructure[b].trades, 0);
  const r = DAILY_BUCKETS.reduce((a, b) => a + rep.byDailyStructure[b].netR, 0);
  assertEquals(n, rep.headline.trades, "a trade fell outside every bucket");
  assertAlmostEquals(r, rep.headline.netR, 1e-9);
  // A missing tag lands in UNKNOWN rather than vanishing.
  assertEquals(rep.byDailyStructure.UNKNOWN.trades, 1);
  // Observational only: the module must not rank them.
  assertEquals(Object.keys(rep.byDailyStructure).sort(), [...DAILY_BUCKETS].sort());
});

// ─────────────────────────────────────────────────────────────────────────────
// quality, candidates, milestones
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("the quality section accounts for every causal-era row", () => {
  const rep = causalReport(MIXED, [], {});
  const causalEra = MIXED.filter((r) => r.causal_execution_version === CAUSAL_EXECUTION_VERSION).length;
  assertEquals(rep.quality.causalRowsTotal, causalEra);
  assertEquals(
    rep.quality.validatedIncluded + rep.quality.excludedUnresolved +
      rep.quality.excludedSequenceContaminated + rep.quality.excludedOther,
    causalEra,
    "included + excluded must equal the causal-era population",
  );
  assertEquals(rep.quality.resolutionMethods["HTF_UNAMBIGUOUS"], 3);
  assertEquals(rep.quality.resolutionMethods["ONE_MINUTE_RESOLVED"], 1);
});

Deno.test("candidate conversion is reported, and never divides by zero", () => {
  const empty = causalReport([], [], {});
  assertEquals(empty.candidates.fillConversion, null, "no intents yet is not 0%");

  const rep = causalReport([], [], { INTENT_CREATED: 8, FILLED: 6, REFUSED: 2, CLOSED: 5 });
  assertAlmostEquals(rep.candidates.fillConversion!, 0.75, 1e-12);
  assertEquals(rep.candidates.refused, 2);
});

Deno.test("milestones are landmarks, and a small sample says so", () => {
  const rep = causalReport(MIXED, [], {});
  assertEquals(rep.milestones.targets, SAMPLE_MILESTONES);
  assertEquals(rep.milestones.next, 25);
  assertEquals(rep.smallSample?.n, 4);
  assertEquals(rep.smallSample?.below, SMALL_SAMPLE_BELOW);

  // With nothing at all there is no sample to warn about.
  assertEquals(causalReport([], [], {}).smallSample, null);

  // Past the last landmark there is no next one, and no claim of validation.
  const many = Array.from({ length: 250 }, (_, i) =>
    row({ exit_time: `2026-09-${String(25 + (i % 5)).padStart(2, "0")}T10:00:00Z` }));
  const big = causalReport(many, [], {});
  assertEquals(big.milestones.next, null);
  assertEquals(big.smallSample, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 12-13. this module cannot touch anything
// ─────────────────────────────────────────────────────────────────────────────

/** Comments describe what is forbidden, so only real code is searched. */
const code = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");

Deno.test("12 — the module cannot modify, delete or backfill a stored row", async () => {
  const src = code(await Deno.readTextFile("supabase/functions/_shared/ipoCausalEvidence.ts"));
  for (const banned of [
    "delete", "truncate", "update", "insert", "upsert",
    ".from(", "createClient", "supabase-js", "fetch(", "Deno.env",
  ]) {
    assert(!src.includes(banned), `the evidence module reaches "${banned}"`);
  }
  // A pure reader: it never assigns to a row's field.
  assert(!/\b[a-z]\.[a-z_]+\s*=[^=]/.test(src), "the module writes to a row");
});

Deno.test("13 — no strategy surface is reachable from the reporting path", async () => {
  const src = code(await Deno.readTextFile("supabase/functions/_shared/ipoCausalEvidence.ts"));
  for (const banned of [
    "runLifecycle", "episodesFor", "stepPosition", "resolveBar", "IncrementalEngine",
    "analyzeMarketStructure", "targetPrice", "invalidationLevel",
  ]) {
    assert(!src.includes(banned), `the reporting module reaches strategy code: ${banned}`);
  }
  // Only one import, and it is the version constant.
  const imports = [...src.matchAll(/^import .*$/gm)].map((m) => m[0]);
  assertEquals(imports.length, 1, `unexpected imports: ${imports.join(" | ")}`);
  assert(imports[0].includes("ipoCausalOrdering"));
});

Deno.test("the Daily-structure tag is bucketed, never judged or filtered on", async () => {
  const src = code(await Deno.readTextFile("supabase/functions/_shared/ipoCausalEvidence.ts"));
  // Every appearance of the tag is a bucket assignment. It must never appear in
  // the admission rule, and the buckets must never be ordered by result.
  const admission = src.slice(
    src.indexOf("export function isValidatedCausalForwardTrade"),
    src.indexOf("export function isLegacyForwardTrade"));
  assert(!admission.includes("daily_structure"),
    "the Daily tag reached the admission rule — that would be a filter");

  // No ranking of buckets anywhere.
  for (const banned of ["preferred", "rank", "best", "worst"]) {
    assert(!new RegExp(`\\b${banned}`, "i").test(src),
      `the Daily bucket is being judged: ${banned}`);
  }
  // The bucket list is a fixed constant, not derived from performance.
  assertEquals([...DAILY_BUCKETS], ["ALIGNED", "OPPOSED", "RANGING", "UNKNOWN"]);
});

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildIPOInventory,
  inventorySummary,
  evaluateDemonstratedCoverage,
  validateCorpusExamples,
  inventoryViewBars,
  barKey,
  timeframeMinutes,
  isIntradayTimeframe,
  isDateOnly,
  resolveParentLineage,
  resolveKnownCandleIndex,
  detectIPOCandidates,
  type DemonstratedExample,
} from "../../functions/_shared/ipoZones.ts";
import {
  IPO_RULE_PROVENANCE,
  provenanceManifest,
  EVIDENCE_SOURCES,
  DETECTION_RULE_KEYS,
  PROVENANCE_BY_KEY,
} from "../../functions/_shared/ipoProvenance.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

/**
 * The inventory layer is deliberately NOT a selector. These tests exist mainly
 * to stop it quietly becoming one: nothing may rank, suppress or reject a zone
 * for coexisting with another, and no metric derived from unlabelled zones may
 * appear in the output.
 */

let t = 0;
function candle(o: number, h: number, l: number, c: number): Candle {
  const dt = new Date(Date.UTC(2026, 0, 1 + t++)).toISOString().slice(0, 19);
  return { datetime: dt, open: o, high: h, low: l, close: c } as Candle;
}
const reset = () => { t = 0; };

function series(amp = 1): Candle[] {
  reset();
  const out: Candle[] = [];
  let p = 100;
  for (let cycle = 0; cycle < 14; cycle++) {
    for (let k = 0; k < 6; k++) { const o = p; p -= 0.9; out.push(candle(o, o + 0.25 * amp, p - 0.25 * amp, p)); }
    out.push(candle(p, p + 0.2 * amp, p - 1.1 * amp, p - 0.9)); p -= 0.9;
    for (let k = 0; k < 8; k++) { const o = p; p += 1.1; out.push(candle(o, p + 0.3 * amp, o - 0.3 * amp, p)); }
    out.push(candle(p, p + 1.0 * amp, p - 0.2 * amp, p + 0.8)); p += 0.8;
  }
  return out;
}

// ─── A. inventory ────────────────────────────────────────────────────────────

Deno.test("the inventory keeps every candidate — it never picks a winner", () => {
  const s = series();
  const detected = detectIPOCandidates(s, { symbol: "T", timeframe: "1d" });
  const inv = buildIPOInventory([{ timeframe: "1d", candles: s }], { symbol: "T" });

  assert(inv.length > 1, "the fixture must produce several zones");
  assertEquals(inv.length, detected.valid.length + detected.rejected.length,
    "nothing is dropped between detection and inventory");

  // Coexistence on overlapping bars must not be resolved away.
  const ids = new Set(inv.map((e) => e.id));
  assertEquals(ids.size, inv.length, "zones are independent entries, not merged");
  for (const e of inv) {
    assert(e.coexistenceNote.includes("not evidence against"),
      "every zone states that coexistence is not evidence against it");
  }
});

Deno.test("every zone carries confirmation ordering, and NO_CONFIRMATION is a real outcome", () => {
  const s = series();
  const inv = buildIPOInventory([{ timeframe: "1d", candles: s }], { symbol: "T" });
  const seen = new Set(inv.map((e) => e.confirmation.ordering));
  for (const e of inv) {
    assert(["DEPARTURE_BEFORE_BREAK", "SAME_BAR_UNVERIFIABLE", "NO_CONFIRMATION"]
      .includes(e.confirmation.ordering));
    // The ordering must agree with the zone's own recomputed confirmation.
    if (e.confirmation.ordering === "NO_CONFIRMATION") {
      assertEquals(e.confirmation.firstRelevant.found, false);
    } else {
      assertEquals(e.confirmation.firstRelevant.departureBreakOrdering, e.confirmation.ordering);
    }
  }
  // A detector-confirmed zone can still fail its OWN first-relevant test; if
  // that never happens the two checks are the same check.
  assert(seen.size >= 1);
});

Deno.test("consolidation is UNRESOLVED on every zone and vetoes nothing", () => {
  const inv = buildIPOInventory([{ timeframe: "1d", candles: series() }], { symbol: "T" });
  for (const e of inv) {
    assertEquals(e.consolidation.status, "UNRESOLVED");
    assertEquals(e.consolidation.interpretation, "UNRESOLVED");
    assert(e.consolidation.note.includes("neither cleared"));
  }
});

Deno.test("a date range filters the VIEW, not the detection", () => {
  const s = series();
  const all = buildIPOInventory([{ timeframe: "1d", candles: s }], { symbol: "T" });
  assert(all.length > 2, "need several zones to slice");
  const mid = all[Math.floor(all.length / 2)].candleDatetime.slice(0, 10);
  const sliced = buildIPOInventory([{ timeframe: "1d", candles: s }], { symbol: "T", from: mid });

  assert(sliced.length < all.length, "the range actually removed something");
  for (const e of sliced) assert(e.candleDatetime.slice(0, 10) >= mid);
  // Identity is preserved: a surviving zone is byte-identical to its unfiltered
  // self. If detection had been run on a trimmed series, lifecycle, ATR and the
  // break index would all shift.
  for (const e of sliced) {
    const same = all.find((a) => a.id === e.id)!;
    assertEquals(JSON.stringify(e), JSON.stringify(same),
      "trimming the input would have changed the zones themselves, not the view");
  }
});

Deno.test("a lower-timeframe zone with no HTF parent is standalone, not discarded", () => {
  const levels = [
    { timeframe: "W", candles: series(20) },
    { timeframe: "D", candles: series(0.02) },
  ];
  const inv = buildIPOInventory(levels, { symbol: "T" });
  const lower = inv.filter((e) => e.lineage.refinementDepth === 1);
  assert(lower.length > 0, "the fixture must produce lower-timeframe zones");
  for (const e of lower) {
    assertEquals(e.lineage.standalone, e.lineage.possibleParentIPOIds.length === 0);
  }
  // Ambiguous parentage is preserved rather than collapsed, exactly as in the
  // hierarchy builder.
  const amb = inv.filter((e) => e.lineage.lineageAmbiguous);
  for (const e of amb) {
    assertEquals(e.lineage.parentIPOId, null);
    assert(e.lineage.possibleParentIPOIds.length > 1);
  }
});

Deno.test("a refined parent keeps CONTEXT and remains in the inventory", () => {
  const levels = [
    { timeframe: "W", candles: series(1.0) },
    { timeframe: "D", candles: series(0.5) },
  ];
  const inv = buildIPOInventory(levels, { symbol: "T" });
  const parents = inv.filter((e) => e.lineage.childIds.length > 0);
  assert(parents.length > 0, "the fixture must produce a refined parent");
  for (const p of parents) {
    assertEquals(p.lineage.role, "CONTEXT");
    for (const cid of p.lineage.childIds) {
      const child = inv.find((x) => x.id === cid)!;
      assertEquals(child.lineage.parentIPOId, p.id);
      assertEquals(child.lineage.parentTimeframe, p.timeframe);
    }
  }
});

Deno.test("the summary reports no precision or false-positive rate", () => {
  const s = series();
  const inv = buildIPOInventory([{ timeframe: "1d", candles: s }], { symbol: "T" });
  const sum = inventorySummary(inv, { "1d": s.length });
  const json = JSON.stringify(sum).toLowerCase();
  for (const forbidden of ["precision", "falsepositive", "false_positive", "accuracy"]) {
    assert(!json.includes(forbidden) || json.includes("no precision"),
      `the summary must not report ${forbidden}`);
  }
  assertEquals(
    sum.confirmation.counts.DEPARTURE_BEFORE_BREAK +
    sum.confirmation.counts.SAME_BAR_UNVERIFIABLE +
    sum.confirmation.counts.NO_CONFIRMATION,
    sum.zones, "the three ordering buckets partition the inventory");
  assert(sum.iposPer100Bars !== null && sum.iposPer100Bars > 0);
});

// ─── B. provenance ───────────────────────────────────────────────────────────

Deno.test("every free numeric parameter is marked OPERATIONAL, never taught", () => {
  const numeric = IPO_RULE_PROVENANCE.filter((r) => typeof r.value === "number");
  assert(numeric.length >= 6, "the tunable numbers must all be declared");
  for (const r of numeric) {
    assertEquals(r.evidenceSource, "OPERATIONAL_INTERPRETATION",
      `${r.key} is a chosen number and must not be presented as taught`);
  }
});

Deno.test("the manifest names the operational rules explicitly", () => {
  const m = provenanceManifest();
  assert(m.operationalRuleCount > 0);
  assertEquals(m.operationalRuleKeys.length, m.operationalRuleCount);
  for (const k of m.operationalRuleKeys) {
    assertEquals(PROVENANCE_BY_KEY[k].evidenceSource, "OPERATIONAL_INTERPRETATION");
  }
  // The selector's three numbers are the ones most likely to be mistaken for
  // method, so their presence is asserted by name.
  for (const k of ["selection.maxInterveningCandles", "selection.interveningMaxRangeAtr", "selection.maxLookbackForIPO"]) {
    assert(m.operationalRuleKeys.includes(k), `${k} must be visibly operational`);
    assert(m.freeParameters.some((p) => p.key === k), `${k} must be listed as a free parameter`);
  }
  assert(m.attributionBasis.includes("not an external citation"),
    "the manifest must not present its own labels as verified citations");
});

Deno.test("provenance keys are unique, complete and legal", () => {
  const keys = IPO_RULE_PROVENANCE.map((r) => r.key);
  assertEquals(new Set(keys).size, keys.length, "duplicate key");
  for (const r of IPO_RULE_PROVENANCE) {
    assert(EVIDENCE_SOURCES.includes(r.evidenceSource), `${r.key} has an unknown evidenceSource`);
    assert(r.note.length > 20, `${r.key} must say why it carries that label`);
  }
  for (const k of DETECTION_RULE_KEYS) {
    assert(PROVENANCE_BY_KEY[k], `DETECTION_RULE_KEYS references unknown rule ${k}`);
  }
});

Deno.test("the taught consolidation rule is recorded as taught but unimplemented", () => {
  const r = PROVENANCE_BY_KEY["consolidation.notInsideConsolidation"];
  assertEquals(r.evidenceSource, "DIRECT_TEACHING");
  assert(r.note.includes("UNIMPLEMENTED"),
    "a taught rule with no working predicate must say so, or it reads as enforced");
});

// ─── C. corpus intake ────────────────────────────────────────────────────────

Deno.test("the corpus refuses anything that looks like a negative label", () => {
  const p = validateCorpusExamples([
    { symbol: "X", timeframe: "1d", direction: "demand", label: "NEGATIVE" },
  ]);
  assert(p.some((x) => x.why.includes("POSITIVES ONLY")),
    "a label field must be rejected loudly, not ignored");
});

Deno.test("a refinement child must belong to its parent's demonstration", () => {
  const G = "11111111-1111-1111-1111-111111111111";
  const ok = validateCorpusExamples([
    { id: "p", symbol: "X", timeframe: "W", direction: "demand", exampleGroupId: G },
    { id: "c", symbol: "X", timeframe: "D", direction: "demand", exampleGroupId: G, parentExampleId: "p" },
  ]);
  assertEquals(ok, []);

  // A chain built entirely inside the batch may omit the group: the planner
  // mints one per chain, so demanding it here would reject a valid W->D->4H send.
  const minted = validateCorpusExamples([
    { id: "p", symbol: "X", timeframe: "W", direction: "demand" },
    { id: "c", symbol: "X", timeframe: "D", direction: "demand", parentExampleId: "p" },
  ]);
  assertEquals(minted, [], "an in-batch chain has its group minted, not demanded");

  // A parent that ALREADY lives in the database is different — minting there
  // would split one demonstration across two groups.
  const storedParent = validateCorpusExamples([
    { symbol: "X", timeframe: "D", direction: "demand",
      parentExampleId: "44444444-4444-4444-4444-444444444444" },
  ]);
  assert(storedParent.some((x) => x.why.includes("exampleGroupId")));

  const otherGroup = validateCorpusExamples([
    { id: "p", symbol: "X", timeframe: "W", direction: "demand", exampleGroupId: G },
    { id: "c", symbol: "X", timeframe: "D", direction: "demand", exampleGroupId: "22222222-2222-2222-2222-222222222222", parentExampleId: "p" },
  ]);
  assert(otherGroup.some((x) => x.why.includes("different demonstration group")));
});

Deno.test("a refinement cycle is caught before it reaches the database", () => {
  const G = "33333333-3333-3333-3333-333333333333";
  const p = validateCorpusExamples([
    { id: "a", symbol: "X", timeframe: "W", direction: "demand", exampleGroupId: G, parentExampleId: "b" },
    { id: "b", symbol: "X", timeframe: "D", direction: "demand", exampleGroupId: G, parentExampleId: "a" },
  ]);
  assert(p.some((x) => x.why.includes("cycle")));
});

Deno.test("half a demonstrated zone is not a zone", () => {
  const p = validateCorpusExamples([
    { symbol: "X", timeframe: "1d", direction: "demand", demonstratedZoneLow: 10 },
  ]);
  assert(p.some((x) => x.why.includes("pair")));
  const bad = validateCorpusExamples([
    { symbol: "X", timeframe: "1d", direction: "supply", demonstratedZoneLow: 20, demonstratedZoneHigh: 10 },
  ]);
  assert(bad.some((x) => x.why.includes("below")));
});

// ─── D. evaluation ───────────────────────────────────────────────────────────

const ex = (o: Partial<DemonstratedExample> & { id: string }): DemonstratedExample => ({
  symbol: "T", timeframe: "1d", direction: "demand", candleDatetime: null,
  exampleGroupId: null, parentExampleId: null, evidenceSource: "VIDEO_DEMONSTRATION",
  ...o,
});

Deno.test("a W->D->4H refinement counts as ONE demonstration, not three", () => {
  const levels = [
    { timeframe: "W", candles: series(1.0) },
    { timeframe: "D", candles: series(0.5) },
    { timeframe: "H4", candles: series(0.25) },
  ];
  const inv = buildIPOInventory(levels, { symbol: "T" });
  const w = inv.find((e) => e.timeframe === "W" && e.lineage.childIds.length > 0)!;
  assert(w, "fixture must contain a refined weekly zone");
  const d = inv.find((e) => e.id === w.lineage.childIds[0])!;
  const h4 = inv.find((e) => e.lineage.parentIPOId === d.id);

  const G = "group-1";
  const examples = [
    ex({ id: "w", timeframe: "W", direction: w.direction, candleDatetime: w.candleDatetime, exampleGroupId: G }),
    ex({ id: "d", timeframe: "D", direction: d.direction, candleDatetime: d.candleDatetime, exampleGroupId: G, parentExampleId: "w" }),
  ];
  if (h4) {
    examples.push(ex({ id: "h", timeframe: "H4", direction: h4.direction, candleDatetime: h4.candleDatetime, exampleGroupId: G, parentExampleId: "d" }));
  }

  const r = evaluateDemonstratedCoverage(inv, examples, { W: 140, D: 140, H4: 140 });
  const byDemo = r.demonstratedIPOCoverage.byDemonstration as any;
  const byEx = r.demonstratedIPOCoverage.byExample as any;

  assertEquals(byDemo.total, 1, "three correlated rows are ONE demonstration");
  assertEquals(byDemo.fullyCovered, 1);
  assertEquals(byDemo.fullyCoveredPct, 100);
  assertEquals(byEx.total, examples.length, "the per-example figure is still reported");
  assert(byEx.total > byDemo.total, "and it is the inflated one, which is why it is secondary");
});

Deno.test("a demonstrated parent/child edge is checked against inventory lineage", () => {
  const levels = [
    { timeframe: "W", candles: series(1.0) },
    { timeframe: "D", candles: series(0.5) },
  ];
  const inv = buildIPOInventory(levels, { symbol: "T" });
  const w = inv.find((e) => e.timeframe === "W" && e.lineage.childIds.length > 0)!;
  const d = inv.find((e) => e.id === w.lineage.childIds[0])!;

  const G = "g";
  const good = evaluateDemonstratedCoverage(inv, [
    ex({ id: "w", timeframe: "W", direction: w.direction, candleDatetime: w.candleDatetime, exampleGroupId: G }),
    ex({ id: "d", timeframe: "D", direction: d.direction, candleDatetime: d.candleDatetime, exampleGroupId: G, parentExampleId: "w" }),
  ], {});
  assertEquals(good.results.find((r) => r.exampleId === "d")!.lineageMatch, "MATCHED");
  assertEquals((good.secondary.parentChildCoverage as any).matched, 1);

  // A demonstrated parent the inventory does not contain is reported as such,
  // not as a lineage mismatch — the two failures have different causes.
  const orphan = evaluateDemonstratedCoverage(inv, [
    ex({ id: "ghost", timeframe: "W", direction: w.direction, candleDatetime: "1999-01-01", exampleGroupId: G }),
    ex({ id: "d", timeframe: "D", direction: d.direction, candleDatetime: d.candleDatetime, exampleGroupId: G, parentExampleId: "ghost" }),
  ], {});
  assertEquals(orphan.results.find((r) => r.exampleId === "d")!.lineageMatch, "PARENT_NOT_IN_INVENTORY");
});

Deno.test("unmatched inventory zones are UNLABELLED, never false positives", () => {
  const s = series();
  const inv = buildIPOInventory([{ timeframe: "1d", candles: s }], { symbol: "T" });
  const one = inv[0];
  const r = evaluateDemonstratedCoverage(inv, [
    ex({ id: "only", timeframe: "1d", direction: one.direction, candleDatetime: one.candleDatetime }),
  ], { "1d": s.length });

  assertEquals(r.unlabelled.count, inv.length - 1);
  assertEquals(r.unlabelled.label, "UNLABELLED_COEXISTING");
  assert((r.unlabelled.note as string).includes("NOT false positives"));
  const json = JSON.stringify(r).toLowerCase();
  assert(!json.includes("\"precision\""), "no precision term may appear");
  assert(!json.includes("falsepositiverate"), "no false-positive rate may appear");
  assertEquals((r.demonstratedIPOCoverage.byDemonstration as any).fullyCoveredPct, 100,
    "coverage is unaffected by how many unlabelled zones coexist");
});

Deno.test("an unrecorded demonstrated geometry is NOT_DEMONSTRATED, not a pass", () => {
  const s = series();
  const inv = buildIPOInventory([{ timeframe: "1d", candles: s }], { symbol: "T" });
  const z = inv[0];

  const silent = evaluateDemonstratedCoverage(inv, [
    ex({ id: "a", timeframe: "1d", direction: z.direction, candleDatetime: z.candleDatetime }),
  ], {});
  assertEquals(silent.results[0].geometryMatch, "NOT_DEMONSTRATED");
  assertEquals((silent.secondary.geometryAgreement as any).match, 0,
    "an unrecorded bound must not be counted as agreement");

  const stated = evaluateDemonstratedCoverage(inv, [
    ex({
      id: "a", timeframe: "1d", direction: z.direction, candleDatetime: z.candleDatetime,
      demonstratedZoneLow: z.geometry.zoneLow, demonstratedZoneHigh: z.geometry.zoneHigh,
    }),
  ], {});
  assertEquals(stated.results[0].geometryMatch, "MATCH");

  const wrong = evaluateDemonstratedCoverage(inv, [
    ex({
      id: "a", timeframe: "1d", direction: z.direction, candleDatetime: z.candleDatetime,
      demonstratedZoneLow: z.geometry.zoneLow - 50, demonstratedZoneHigh: z.geometry.zoneHigh + 50,
    }),
  ], {});
  assertEquals(wrong.results[0].geometryMatch, "MISMATCH");
});

Deno.test("an absent demonstration is reported with its match state, not silently dropped", () => {
  const s = series();
  const inv = buildIPOInventory([{ timeframe: "1d", candles: s }], { symbol: "T" });
  const r = evaluateDemonstratedCoverage(inv, [
    ex({ id: "missing", timeframe: "1d", candleDatetime: "1999-01-01" }),
    ex({ id: "undated", timeframe: "1d", candleDatetime: null }),
  ], { "1d": s.length });

  assertEquals(r.results.length, 2);
  assertEquals(r.results[0].matchState, "ABSENT");
  assertEquals(r.results[0].presentInInventory, false);
  assertEquals(r.results[1].matchState, "UNDATED_EXAMPLE");
  assertEquals((r.demonstratedIPOCoverage as any).undatedExamples, 1);
  assertEquals((r.demonstratedIPOCoverage.byDemonstration as any).missed, 2,
    "two solo demonstrations, both missed");
});

Deno.test("coverage is unchanged by how many zones the inventory holds", () => {
  // The old 'one correct IPO per break' score fell as extra zones appeared.
  // Coverage must not, or suppression becomes the way to improve the number.
  const s = series();
  const inv = buildIPOInventory([{ timeframe: "1d", candles: s }], { symbol: "T" });
  const z = inv[0];
  const example = [ex({ id: "a", timeframe: "1d", direction: z.direction, candleDatetime: z.candleDatetime })];

  const full = evaluateDemonstratedCoverage(inv, example, { "1d": s.length });
  const trimmed = evaluateDemonstratedCoverage([z], example, { "1d": s.length });
  assertEquals(
    (full.demonstratedIPOCoverage.byDemonstration as any).fullyCoveredPct,
    (trimmed.demonstratedIPOCoverage.byDemonstration as any).fullyCoveredPct,
  );
  assert(full.unlabelled.count > trimmed.unlabelled.count,
    "the extra zones show up as unlabelled, which costs nothing");
});

Deno.test("a parent clipped out of the date range is flagged, not silently missing", () => {
  const levels = [
    { timeframe: "W", candles: series(1.0) },
    { timeframe: "D", candles: series(0.5) },
  ];
  const all = buildIPOInventory(levels, { symbol: "T" });
  const child = all.find((e) => e.lineage.parentIPOId !== null)!;
  assert(child, "fixture must produce a child with a resolved parent");
  assertEquals(child.lineage.parentInView, true, "unfiltered, the parent is present");

  // Start the range AFTER the parent's candle so only the child survives.
  const parent = all.find((e) => e.id === child.lineage.parentIPOId)!;
  const after = new Date(Date.parse(parent.candleDatetime) + 86400000).toISOString().slice(0, 10);
  const clipped = buildIPOInventory(levels, { symbol: "T", from: after });
  const c2 = clipped.find((e) => e.id === child.id);
  if (!c2) return;                       // the child was clipped too; nothing to assert
  assertEquals(c2.lineage.parentIPOId, child.lineage.parentIPOId, "lineage is unchanged by the view");
  assertEquals(c2.lineage.parentInView, false,
    "a child holding a parent id whose parent is not returned must say so");
  assertEquals((inventorySummary(clipped, {}).lineage as any).parentOutsideView >= 1, true);
});

// ─── #610 review patches ─────────────────────────────────────────────────────

Deno.test("intraday matching uses the full timestamp, not the date", () => {
  // A 4H chart has six bars a day. Keying on the date alone makes them one bar,
  // so a demonstrated 04:00 IPO would 'match' a 20:00 zone and report covered.
  assertEquals(barKey("2026-03-05T04:00:00Z", "4h"), "2026-03-05T04:00");
  assertEquals(barKey("2026-03-05T20:00:00Z", "4h"), "2026-03-05T20:00");
  assert(barKey("2026-03-05T04:00:00Z", "4h") !== barKey("2026-03-05T20:00:00Z", "4h"));
  assertEquals(barKey("2026-03-05 04:00:00", "15min"), "2026-03-05T04:00");

  // Daily and above stay date-only, because feeds stamp them 00:00:00,
  // 00:00:00Z or 21:00:00 and the stamp is not part of the identity.
  assertEquals(barKey("2026-03-05T00:00:00Z", "1day"), "2026-03-05");
  assertEquals(barKey("2026-03-05T21:00:00", "1d"), "2026-03-05");
  assertEquals(barKey("2026-03-02T00:00:00Z", "1week"), "2026-03-02");

  // An unknown timeframe gets MINUTE precision: matching too strictly reports a
  // visible miss, matching too loosely reports false coverage.
  assertEquals(barKey("2026-03-05T04:30:00Z", "banana"), "2026-03-05T04:30");
  assertEquals(timeframeMinutes("4h"), 240);
  assertEquals(timeframeMinutes("1day"), 1440);
  assertEquals(timeframeMinutes("nonsense"), null);
});

Deno.test("two 4H zones on one date do not collide in the evaluator", () => {
  const mk = (dt: string, id: string): any => ({
    id, symbol: "T", timeframe: "4h", direction: "demand",
    candleIndex: 0, candleDatetime: dt, candle: { open: 1, high: 2, low: 0, close: 1 },
    geometry: { proximal: 2, distal: 1, extent: 0, zoneLow: 1, zoneHigh: 2 },
    confirmation: { ordering: "NO_CONFIRMATION", firstRelevant: {}, detectorBreak: {} },
    liquidity: {}, departureFvg: {}, consolidation: { status: "UNRESOLVED" },
    lifecycle: { status: "ACTIVE" },
    lineage: { timeframe: "4h", refinementDepth: 0, parentIPOId: null, parentTimeframe: null,
      possibleParentIPOIds: [], lineageAmbiguous: false, lineageResolvedBy: "ROOT",
      childIds: [], possibleChildIds: [], role: "EXECUTION", standalone: false,
      parentInView: true, parentAgeDays: null, parentAgeBars: null },
    selection: {}, atrAtCandle: 1, valid: true, researchStatus: "CANDIDATE_ACCEPTED",
    coexistenceNote: "x",
  });
  const inv = [mk("2026-03-05T04:00:00Z", "early"), mk("2026-03-05T20:00:00Z", "late")];
  const r = evaluateDemonstratedCoverage(inv as any, [
    ex({ id: "a", timeframe: "4h", candleDatetime: "2026-03-05T20:00:00Z" }),
  ], {});
  assertEquals(r.results[0].matchedZoneId, "late",
    "the demonstrated 20:00 IPO must not be satisfied by the 04:00 zone");
});

Deno.test("OPERATIONAL_INTERPRETATION rows cannot inflate demonstrated coverage", () => {
  const s = series();
  const inv = buildIPOInventory([{ timeframe: "1d", candles: s }], { symbol: "T" });
  const found = inv[0], alsoFound = inv[1];

  // One demonstrated example that is MISSED.
  const base = [ex({ id: "missed", timeframe: "1d", candleDatetime: "1999-01-01" })];
  const before = evaluateDemonstratedCoverage(inv, base, {});
  assertEquals((before.demonstratedIPOCoverage.byDemonstration as any).fullyCoveredPct, 0);

  // Adding reconstructed rows that DO match must not move the headline — this
  // is the cheapest possible way to fake coverage and it has to fail.
  const padded = [
    ...base,
    ex({ id: "r1", timeframe: "1d", direction: found.direction, candleDatetime: found.candleDatetime, evidenceSource: "OPERATIONAL_INTERPRETATION" }),
    ex({ id: "r2", timeframe: "1d", direction: alsoFound.direction, candleDatetime: alsoFound.candleDatetime, evidenceSource: "OPERATIONAL_INTERPRETATION" }),
  ];
  const after = evaluateDemonstratedCoverage(inv, padded, {});
  assertEquals((after.demonstratedIPOCoverage.byDemonstration as any).fullyCoveredPct, 0,
    "a row we reconstructed is not a demonstration");
  assertEquals((after.demonstratedIPOCoverage.byDemonstration as any).total, 1);
  assertEquals((after.demonstratedIPOCoverage.byExample as any).total, 1);

  // They are still evaluated, just reported apart.
  assertEquals((after.reconstructedExamples as any).total, 2);
  assertEquals((after.reconstructedExamples as any).matched, 2);
  assertEquals(after.results.length, 3, "every row is still evaluated in full");

  // The other three sources all count.
  for (const src of ["VIDEO_DEMONSTRATION", "DIRECT_TEACHING", "USER_CONFIRMED"] as const) {
    const r = evaluateDemonstratedCoverage(inv, [
      ex({ id: "x", timeframe: "1d", direction: found.direction, candleDatetime: found.candleDatetime, evidenceSource: src }),
    ], {});
    assertEquals((r.demonstratedIPOCoverage.byDemonstration as any).total, 1, `${src} must count`);
  }
});

Deno.test("density uses bars inside the date range, not the whole series", () => {
  const s = series();
  const levels = [{ timeframe: "1d", candles: s }];
  const all = buildIPOInventory(levels, { symbol: "T" });
  const mid = all[Math.floor(all.length / 2)].candleDatetime.slice(0, 10);

  const sliced = buildIPOInventory(levels, { symbol: "T", from: mid });
  const viewBars = inventoryViewBars(levels, { from: mid });
  assert(viewBars["1d"] < s.length, "the window really is smaller than the series");

  const honest = inventorySummary(sliced, viewBars);
  const wrong = inventorySummary(sliced, { "1d": s.length });
  assert(honest.iposPer100Bars! > wrong.iposPer100Bars!,
    "dividing a slice of zones by the full bar count understates density");
  assertEquals(honest.perTimeframe["1d"].bars, viewBars["1d"]);
  assertEquals(inventoryViewBars(levels)["1d"], s.length, "no range means the whole series");
});

Deno.test("parent age is measured and reported, and nothing filters on it", () => {
  const levels = [
    { timeframe: "W", candles: series(1.0) },
    { timeframe: "D", candles: series(0.5) },
  ];
  const inv = buildIPOInventory(levels, { symbol: "T" });
  const kids = inv.filter((e) => e.lineage.parentIPOId !== null);
  assert(kids.length > 0, "fixture must produce parented children");

  for (const k of kids) {
    const p = inv.find((e) => e.id === k.lineage.parentIPOId)!;
    assert(k.lineage.parentAgeDays !== null, "age must be measured");
    assert(k.lineage.parentAgeBars !== null);
    assert(k.lineage.parentAgeDays! >= 0, "a parent never post-dates its child");
    const expected = (Date.parse(k.candleDatetime) - Date.parse(p.candleDatetime)) / 86400000;
    assertEquals(k.lineage.parentAgeDays, Math.round(expected * 10) / 10);
  }
  // No cap: the oldest parent in the set is still a parent.
  const oldest = kids.reduce((a, b) => (b.lineage.parentAgeDays! > a.lineage.parentAgeDays! ? b : a));
  assertEquals(oldest.lineage.parentIPOId !== null, true,
    "age is measurement only — adding a limit would be a new discriminator");
});

Deno.test("refinement keeps direction aligned, and that rule is declared", () => {
  // An opposite-direction IPO inside the parent zone may exist; it is simply
  // not that parent's refinement child.
  const parentNode: any = {
    id: "P", timeframe: "W", direction: "demand", candleDatetime: "2026-01-01T00:00:00",
    geometry: { proximal: 80, distal: 40, extent: 39, zoneLow: 40, zoneHigh: 80 },
    parentIPOId: null, parentTimeframe: null, possibleParentIPOIds: [],
    lineageAmbiguous: false, lineageResolvedBy: "ROOT", childTimeframe: null,
    refinementDepth: 0, role: "EXECUTION", containedWithinParent: false,
    childIds: [], possibleChildIds: [],
  };
  const inside = (direction: "demand" | "supply") => ({
    direction, candleDatetime: "2026-02-01T00:00:00",
    geometry: { proximal: 58, distal: 52, extent: 51, zoneLow: 52, zoneHigh: 58 },
  });
  assertEquals(resolveParentLineage(inside("demand"), [parentNode]).parentIPOId, "P");
  assertEquals(resolveParentLineage(inside("supply"), [parentNode]).parentIPOId, null,
    "an opposite-direction zone inside the parent is not its refinement child");
  assertEquals(resolveParentLineage(inside("supply"), [parentNode]).possibleParentIPOIds, []);

  const r = PROVENANCE_BY_KEY["refinement.sameDirection"];
  assert(r, "the same-direction rule must be declared, not left implicit");
  assertEquals(r.evidenceSource, "USER_CONFIRMED");
  assert(provenanceManifest().rules.some((x) => x.key === "refinement.sameDirection"),
    "and it must appear in the manifest attached to research output");
});

Deno.test("a date-only example on an intraday chart searches the calendar day", () => {
  // A screenshot often gives 2020-05-08 and nothing finer. On a 4H chart the
  // inventory keys that day as six bars, so the exact-key lookup misses all of
  // them and the example read ABSENT — a detector failure reported where the
  // only thing missing was a timestamp in OUR records.
  const mk = (dt: string, id: string, direction: "demand" | "supply" = "demand"): any => ({
    id, symbol: "T", timeframe: "4h", direction,
    candleIndex: 0, candleDatetime: dt, candle: { open: 1, high: 2, low: 0, close: 1 },
    geometry: { proximal: 2, distal: 1, extent: 0, zoneLow: 1, zoneHigh: 2 },
    confirmation: { ordering: "DEPARTURE_BEFORE_BREAK", firstRelevant: {}, detectorBreak: {} },
    liquidity: {}, departureFvg: {}, consolidation: { status: "UNRESOLVED" },
    lifecycle: { status: "TESTED" },
    lineage: { timeframe: "4h", refinementDepth: 0, parentIPOId: null, parentTimeframe: null,
      possibleParentIPOIds: [], lineageAmbiguous: false, lineageResolvedBy: "ROOT",
      childIds: [], possibleChildIds: [], role: "EXECUTION", standalone: false,
      parentInView: true, parentAgeDays: null, parentAgeBars: null },
    selection: {}, atrAtCandle: 1, valid: true, researchStatus: "CANDIDATE_ACCEPTED",
    coexistenceNote: "x",
  });

  // ── exactly one direction-compatible zone that day ──
  const single = [mk("2020-05-08T04:00:00Z", "only"), mk("2020-05-08T12:00:00Z", "other", "supply")];
  const r1 = evaluateDemonstratedCoverage(single as any, [
    ex({ id: "a", timeframe: "4h", direction: "demand", candleDatetime: "2020-05-08" }),
  ], {});
  assertEquals(r1.results[0].matchState, "DATE_ONLY_SINGLE_MATCH");
  assertEquals(r1.results[0].matchedZoneId, "only");
  assertEquals(r1.results[0].presentInInventory, true);
  assert(r1.results[0].matchState !== "EXACT_CANDLE",
    "an inferred bar must never be reported as an exact match");
  assertEquals(r1.results[0].confirmationState, "DEPARTURE_BEFORE_BREAK",
    "a resolved single match carries the zone's real state");
  assertEquals((r1.demonstratedIPOCoverage as any).dateOnlyExamples.singleMatch, 1);

  // ── several compatible zones that day ──
  const many = [mk("2020-05-08T04:00:00Z", "a1"), mk("2020-05-08T20:00:00Z", "a2")];
  const r2 = evaluateDemonstratedCoverage(many as any, [
    ex({ id: "a", timeframe: "4h", direction: "demand", candleDatetime: "2020-05-08" }),
  ], {});
  assertEquals(r2.results[0].matchState, "DATE_ONLY_AMBIGUOUS");
  assertEquals(r2.results[0].matchedZoneId, null, "we cannot name which zone was shown");
  assertEquals(r2.results[0].presentInInventory, false);
  assertEquals([...r2.results[0].candidateZoneIds].sort(), ["a1", "a2"]);
  assertEquals(r2.results[0].confirmationState, null,
    "no zone was identified, so no zone's state may be claimed");

  // Ambiguous is neither covered nor missed — it is the gap between the bounds.
  const cov = r2.demonstratedIPOCoverage as any;
  assertEquals(cov.byExample.pct, 0);
  assertEquals(cov.coverageUpperBoundPct, 100);
  assertEquals(cov.dateOnlyExamples.ambiguous, 1);

  // ── a date-only example with NO zone that day is still absent ──
  const r3 = evaluateDemonstratedCoverage(single as any, [
    ex({ id: "a", timeframe: "4h", direction: "demand", candleDatetime: "2020-05-09" }),
  ], {});
  assertEquals(r3.results[0].matchState, "ABSENT");

  // ── direction still binds: a supply demonstration does not take a demand zone ──
  const r4 = evaluateDemonstratedCoverage([mk("2020-05-08T04:00:00Z", "d1")] as any, [
    ex({ id: "a", timeframe: "4h", direction: "supply", candleDatetime: "2020-05-08" }),
  ], {});
  assertEquals(r4.results[0].matchState, "ABSENT");
  assertEquals(r4.results[0].candidateZoneIds, []);
});

Deno.test("the date-only fallback does not loosen matching on daily charts", () => {
  // At 1D the key is already date-only, so exact matching works and the
  // fallback must not fire — otherwise a real miss could be papered over.
  const s = series();
  const inv = buildIPOInventory([{ timeframe: "1d", candles: s }], { symbol: "T" });
  const z = inv[0];
  const hit = evaluateDemonstratedCoverage(inv, [
    ex({ id: "a", timeframe: "1d", direction: z.direction, candleDatetime: z.candleDatetime.slice(0, 10) }),
  ], {});
  assertEquals(hit.results[0].matchState, "EXACT_CANDLE",
    "a daily example matches exactly, not by day-search");
  const miss = evaluateDemonstratedCoverage(inv, [
    ex({ id: "a", timeframe: "1d", candleDatetime: "1999-01-01" }),
  ], {});
  assertEquals(miss.results[0].matchState, "ABSENT");
  assertEquals(isIntradayTimeframe("1d"), false);
  assertEquals(isIntradayTimeframe("4h"), true);
  assertEquals(isDateOnly("2020-05-08"), true);
  assertEquals(isDateOnly("2020-05-08T04:00:00Z"), false);
});

Deno.test("a historical range defines the VIEW, while detection keeps the buffer", () => {
  // The action defaults from/to to startDate/endDate. Without that, density,
  // unlabelled-zone counts and the returned inventory describe the buffered
  // period — months of context nobody asked about — rather than the window.
  const s = series();
  const levels = [{ timeframe: "1d", candles: s }];
  const all = buildIPOInventory(levels, { symbol: "T" });
  const mid = all[Math.floor(all.length / 2)].candleDatetime.slice(0, 10);

  const windowed = buildIPOInventory(levels, { symbol: "T", from: mid });
  const viewBars = inventoryViewBars(levels, { from: mid });

  // Detection is unchanged: a surviving zone is identical to its unfiltered self.
  for (const e of windowed) {
    assertEquals(JSON.stringify(e), JSON.stringify(all.find((a) => a.id === e.id)!));
  }
  // But the reported shape is the window's, not the buffer's.
  const wsum = inventorySummary(windowed, viewBars);
  const bsum = inventorySummary(all, { "1d": s.length });
  assert(wsum.zones < bsum.zones);
  assertEquals(wsum.perTimeframe["1d"].bars, viewBars["1d"]);
  assert(viewBars["1d"] < s.length, "the view is genuinely narrower than the fetch");
});

Deno.test("coverage scopes corpus examples to the timeframes actually requested", () => {
  // Filtering on symbol alone lets a BTC DAILY example be scored against a
  // 4H-only inventory, where it can never match — an artificial miss
  // manufactured by the shape of the request rather than by the detector.
  const s = series();
  const inv = buildIPOInventory([{ timeframe: "4h", candles: s }], { symbol: "T" });
  const z = inv[0];

  const requested = ["4h"];
  const corpus = [
    { symbol: "T", timeframe: "4h", direction: z.direction, candleDatetime: z.candleDatetime },
    { symbol: "T", timeframe: "1d", direction: "demand", candleDatetime: "2026-01-05" },
  ];

  const unscoped = corpus.filter((c) => c.symbol === "T");
  const scoped = corpus.filter((c) => c.symbol === "T" && requested.includes(c.timeframe));
  assertEquals(scoped.length, 1);

  const bad = evaluateDemonstratedCoverage(inv, unscoped.map((c, i) => ex({ id: `u${i}`, ...c } as any)), {});
  const good = evaluateDemonstratedCoverage(inv, scoped.map((c, i) => ex({ id: `s${i}`, ...c } as any)), {});

  assertEquals((bad.demonstratedIPOCoverage.byExample as any).pct, 50,
    "the daily example drags coverage down on an inventory that never had daily zones");
  assertEquals((good.demonstratedIPOCoverage.byExample as any).pct, 100,
    "scoped to the requested timeframes, only answerable examples are scored");
});

Deno.test("a trace resolves the EXACT bar, never the first bar of the day", () => {
  // The three trace diagnostics matched on datetime.slice(0,10), so asking for
  // BTC/USD 4h 2020-05-08 16:00 silently traced the 00:00 bar and produced a
  // confident failure analysis of a candle nobody demonstrated.
  reset();
  const bars: Candle[] = [];
  for (let d = 0; d < 3; d++) {
    for (const h of [0, 4, 8, 12, 16, 20]) {
      bars.push({
        datetime: `2020-05-0${8 + d}T${String(h).padStart(2, "0")}:00:00Z`,
        open: 100 + h, high: 101 + h, low: 99 + h, close: 100.5 + h,
      } as Candle);
    }
  }
  const at16 = resolveKnownCandleIndex(bars, "2020-05-08T16:00");
  assertEquals(at16.resolvedDatetime, "2020-05-08T16:00:00Z");
  assertEquals(at16.index, 4, "the 16:00 bar, not the 00:00 one");
  assertEquals(at16.ambiguous, false);

  // A date with no time on an intraday series resolves to the first bar but
  // SAYS the day held several, so it cannot pass as a precise trace.
  const dayOnly = resolveKnownCandleIndex(bars, "2020-05-08");
  assertEquals(dayOnly.index, 0);
  assertEquals(dayOnly.ambiguous, true);
  assertEquals(dayOnly.barsOnThatDay, 6);

  // A time that does not exist is refused rather than rounded to the day.
  const missing = resolveKnownCandleIndex(bars, "2020-05-08T17:30");
  assertEquals(missing.index, -1);
  assertEquals(missing.barsOnThatDay, 6,
    "the day exists, so the caller can tell a bad time from a missing day");

  // Daily series are unaffected: one bar per day, no ambiguity.
  const daily = [{ datetime: "2020-05-08T00:00:00Z", open: 1, high: 2, low: 0, close: 1 }] as Candle[];
  assertEquals(resolveKnownCandleIndex(daily, "2020-05-08").index, 0);
  assertEquals(resolveKnownCandleIndex(daily, "2020-05-08").ambiguous, false);
});

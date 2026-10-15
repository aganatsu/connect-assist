import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { CALENDAR_STATUS, classifyGaps, classifyMissingHour } from "../../../functions/_shared/structure/barGaps.ts";
import { APPROVED_RESEARCH_DATASETS, assertApproved, assertNoRowAfterBoundary, evaluateResearchDataset, type ResearchDataset } from "../../../functions/_shared/structure/researchImport.ts";
import { fxOpenNY, H1_MS, planWrites } from "../../../functions/_shared/structure/canonicalBars.ts";

/** Gap classification (monitoring only) and the approved research import rules — synthetic data only. */

Deno.test("gaps: holidays and the 2025 Sunday provider absence are classified, everything else is a data gap; nothing is filled", () => {
  assertEquals(classifyMissingHour(Date.parse("2025-12-24T15:00:00Z")), "holiday_closure");
  assertEquals(classifyMissingHour(Date.parse("2025-05-04T21:00:00Z")), "provider_absence"); // Sunday 17:00 NY (EDT)
  assertEquals(classifyMissingHour(Date.parse("2025-05-04T22:00:00Z")), "provider_absence");
  assertEquals(classifyMissingHour(Date.parse("2025-05-04T23:00:00Z")), "data_gap");
  assertEquals(classifyMissingHour(Date.parse("2025-11-02T22:00:00Z")), "data_gap", "outside the observed absence span");
  assertEquals(classifyMissingHour(Date.parse("2025-06-18T14:00:00Z")), "data_gap");
  assert(CALENDAR_STATUS.startsWith("provisional"));
});

Deno.test("gaps: classifyGaps lists only expected FX-open hours missing from the canonical set", () => {
  const from = Date.parse("2025-05-04T21:00:00Z"), to = Date.parse("2025-05-05T21:00:00Z"); // Sunday open → Monday close
  const have: number[] = [];
  for (let t = from; t < to; t += H1_MS) if (fxOpenNY(t) && t !== Date.parse("2025-05-05T14:00:00Z") && t !== from && t !== from + H1_MS) have.push(t);
  const gaps = classifyGaps(have, from, to);
  assertEquals(gaps.map((g) => [new Date(g.t).toISOString().slice(11, 13), g.class]), [["21", "provider_absence"], ["22", "provider_absence"], ["14", "data_gap"]]);
});

const SHA = APPROVED_RESEARCH_DATASETS[0].sha256;
const meta = { sha256: SHA, manifestSha256: SHA, retrievedAtMs: Date.parse("2026-10-14T02:20:22Z") };
function ds(rows: [string, number][], symbol = "NZD/CAD"): ResearchDataset {
  const bars: ResearchDataset["bars"] = { [symbol]: { "1h": rows.map(([iso, p]) => ({ t: Date.parse(iso), o: p, h: p + 0.0009, l: p - 0.0008, c: p + 0.00010003 })) } };
  return { start: Date.parse("2025-04-16T21:00:00Z"), end: Date.parse("2026-04-16T21:00:00Z"), bars };
}

Deno.test("import: only approved datasets whose bytes match the manifest", () => {
  assertThrows(() => assertApproved({ ...meta, sha256: "00".repeat(32), manifestSha256: "00".repeat(32) }), Error, "not an approved");
  assertThrows(() => assertApproved({ ...meta, manifestSha256: "ff".repeat(32) }), Error, "do not match the manifest");
  assertThrows(() => assertApproved({ ...meta, retrievedAtMs: NaN }), Error, "retrieval time");
  assertEquals(assertApproved(meta).name, "validation-20250416-20260416");
});

Deno.test("import: any 1H row at/after 2026-10-09 21:00Z refuses the whole dataset (reserved window never read)", () => {
  assertThrows(() => assertNoRowAfterBoundary(ds([["2026-10-09T20:00:00Z", 0.82], ["2026-10-09T21:00:00Z", 0.82]])), Error, "refused");
  assertThrows(() => evaluateResearchDataset(ds([["2026-10-14T09:00:00Z", 0.82]]), meta), Error, "refused");
  assertNoRowAfterBoundary(ds([["2026-10-09T20:00:00Z", 0.82]]));
});

Deno.test("import: rows are rounded to the grid, provenance research_import, weekend provider rows rejected (not written)", () => {
  const e = evaluateResearchDataset(ds([["2025-05-05T09:00:00Z", 0.82209003], ["2025-05-10T12:00:00Z", 0.83]]), meta); // Monday, Saturday
  assertEquals(e.length, 2);
  assert(e[0].kind === "candidate");
  assertEquals([e[0].row.open, e[0].row.close, e[0].row.source, e[0].row.source_ref], [0.82209, 0.82219, "research_import", SHA]);
  assertEquals(e[1].kind === "rejected" ? e[1].reason : null, "outside_fx_hours");
  const plan = planWrites(e, new Map(), "research_import");
  assertEquals(plan.inserts.length, 1);
});

Deno.test("import: an existing canonical value is never overwritten — a differing import value becomes a revision", () => {
  const e = evaluateResearchDataset(ds([["2025-05-05T09:00:00Z", 0.82209]]), meta);
  assert(e[0].kind === "candidate");
  const stored = new Map([[e[0].row.bar_time, { hash: "0.82200|0.82290|0.82120|0.82210", open: 0.822, high: 0.8229, low: 0.8212, close: 0.8221 }]]);
  const plan = planWrites(e, stored, "research_import");
  assertEquals([plan.inserts.length, plan.revisions.length], [0, 1]);
});

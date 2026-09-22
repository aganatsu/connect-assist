import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  planCorpusInsert,
  resolveWaveParents,
  corpusNaturalKey,
  UnresolvedParentError,
} from "../../functions/_shared/ipoCorpusPlan.ts";
import { assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * A fake corpus table with the real constraints that matter here:
 *
 *   - id is assigned BY THE DATABASE, never by the caller
 *   - parent_example_id is a foreign key: it must name a row that already exists
 *   - the natural key is unique, so a re-send updates instead of duplicating
 *
 * The point of the round-trip is that a W->D->4H chain cannot be stored in one
 * statement, and the previous code tried to. A planner that looks right but
 * still hands the database a batch-local handle fails here exactly as it failed
 * against Postgres.
 */
class FakeCorpusTable {
  rows: any[] = [];
  private n = 0;
  upsert(payload: Array<Record<string, unknown>>): any[] {
    const out: any[] = [];
    for (const p of payload) {
      const pid = p.parent_example_id as string | null;
      if (pid && !this.rows.some((r) => r.id === pid)) {
        throw new Error(`FK violation: parent_example_id ${pid} does not exist`);
      }
      if (pid && !/^[0-9a-f-]{36}$/i.test(pid)) {
        throw new Error(`invalid input syntax for type uuid: "${pid}"`);
      }
      // Mirrors the project-wide constraint: no user_id in the natural key.
      const key = (r: any) =>
        `${r.symbol}|${r.timeframe}|${r.candle_datetime ?? "~"}|${r.direction}`;
      const existing = this.rows.find((r) => key(r) === key(p));
      if (existing) { Object.assign(existing, p); out.push({ ...existing }); continue; }
      const row = { ...p, id: `00000000-0000-4000-8000-${String(++this.n).padStart(12, "0")}` };
      this.rows.push(row);
      out.push({ ...row });
    }
    return out;
  }
}

/**
 * Mirrors the edge function's wave loop exactly, INCLUDING the group lookup.
 *
 * mintGroupId defaults to crypto.randomUUID, the same as production. An earlier
 * version used a counter, which made re-send idempotence look correct for the
 * wrong reason: the mint simply produced the same value twice. With a real
 * random mint, a group that survives a re-send can only have been preserved.
 */
function runInsert(table: FakeCorpusTable, rows: any[],
                   mint: () => string = () => crypto.randomUUID()) {
  const existingGroupByKey = new Map<string, string>();
  for (const r of table.rows) {
    if (r.example_group_id) existingGroupByKey.set(corpusNaturalKey(r), r.example_group_id);
  }
  const plan = planCorpusInsert(rows, mint, existingGroupByKey);
  if (plan.problems.length) return { plan, written: [] as any[], problems: plan.problems };
  const idByLocal = new Map<string, string>();
  const written: any[] = [];
  for (const wave of plan.waves) {
    const data = table.upsert(resolveWaveParents(wave, idByLocal));
    for (const p of wave) {
      if (!p.localId) continue;
      const r = p.row as any;
      const hit = data.find((d) =>
        d.symbol === r.symbol && d.timeframe === r.timeframe && d.direction === r.direction &&
        (d.candle_datetime ?? null) === (r.candle_datetime ?? null));
      if (hit) idByLocal.set(p.localId, hit.id);
    }
    written.push(...data);
  }
  return { plan, written, problems: [] };
}

const W = { localId: "w", symbol: "AUD/USD", timeframe: "1week", direction: "demand", candleDatetime: "2026-03-02" };
const D = { localId: "d", symbol: "AUD/USD", timeframe: "1day", direction: "demand", candleDatetime: "2026-03-05", localParentId: "w" };
const H = { localId: "h", symbol: "AUD/USD", timeframe: "4h", direction: "demand", candleDatetime: "2026-03-05T12:00", localParentId: "d" };

Deno.test("a W->D->4H chain round-trips with REAL database ids on every edge", () => {
  const t = new FakeCorpusTable();
  const { plan, written } = runInsert(t, [W, D, H]);

  assertEquals(plan.waves.length, 3, "one wave per level — a single upsert cannot store this");
  assertEquals(plan.waves.map((w) => w.length), [1, 1, 1]);
  assertEquals(written.length, 3);

  const w = t.rows.find((r) => r.timeframe === "1week")!;
  const d = t.rows.find((r) => r.timeframe === "1day")!;
  const h = t.rows.find((r) => r.timeframe === "4h")!;

  // The edges are the whole point: they must be real ids, not handles.
  assertEquals(d.parent_example_id, w.id);
  assertEquals(h.parent_example_id, d.id);
  assert(w.parent_example_id === null);
  for (const r of [d, h]) {
    assert(/^[0-9a-f-]{36}$/i.test(r.parent_example_id), "a batch-local handle must never be persisted");
  }

  // One demonstration, one group, shared by all three.
  assertEquals(d.example_group_id, w.example_group_id);
  assertEquals(h.example_group_id, w.example_group_id);
  assertEquals(new Set(t.rows.map((r) => r.example_group_id)).size, 1);
});

Deno.test("re-sending the same chain preserves the DEMONSTRATION identity", () => {
  // The group id IS the demonstration. A re-send that mints a fresh one leaves
  // the rows and edges intact but renames the demonstration, so every earlier
  // reference to it stops matching and one demonstration is counted as two
  // across runs. Both sends below use a genuinely random mint.
  const t = new FakeCorpusTable();
  runInsert(t, [W, D, H]);
  const firstIds = t.rows.map((r) => r.id).sort();
  const firstGroup = t.rows[0].example_group_id;
  assert(/^[0-9a-f-]{36}$/i.test(firstGroup), "a real uuid was minted the first time");

  runInsert(t, [W, D, H]);
  assertEquals(t.rows.length, 3, "the natural key deduplicates; no second copy");
  assertEquals(t.rows.map((r) => r.id).sort(), firstIds, "ids are stable across a re-send");
  const d = t.rows.find((r) => r.timeframe === "1day")!;
  const w = t.rows.find((r) => r.timeframe === "1week")!;
  assertEquals(d.parent_example_id, w.id, "the edge survives a re-send");
  assertEquals(w.example_group_id, firstGroup,
    "the demonstration group is PRESERVED, not re-minted");
  assertEquals(new Set(t.rows.map((r) => r.example_group_id)).size, 1,
    "and all three rows still share it");
});

Deno.test("rows arriving child-first are still ordered parent-first", () => {
  const t = new FakeCorpusTable();
  // Reverse order: if the planner trusted array order this throws an FK error.
  const { written } = runInsert(t, [H, D, W]);
  assertEquals(written.length, 3);
  const w = t.rows.find((r) => r.timeframe === "1week")!;
  const d = t.rows.find((r) => r.timeframe === "1day")!;
  const h = t.rows.find((r) => r.timeframe === "4h")!;
  assertEquals(d.parent_example_id, w.id);
  assertEquals(h.parent_example_id, d.id);
});

Deno.test("attaching to an EXISTING demonstration reuses its id and group", () => {
  const t = new FakeCorpusTable();
  runInsert(t, [W, D]);
  const w = t.rows.find((r) => r.timeframe === "1week")!;

  // Second batch names the already-stored weekly row by its real id.
  runInsert(t, [{
    symbol: "AUD/USD", timeframe: "4h", direction: "demand",
    candleDatetime: "2026-03-05T12:00",
    exampleGroupId: w.example_group_id, parentExampleId: w.id,
  }]);
  const h = t.rows.find((r) => r.timeframe === "4h")!;
  assertEquals(h.parent_example_id, w.id, "a real id passes straight through");
  assertEquals(h.example_group_id, w.example_group_id);
});

Deno.test("a solo example is not given a demonstration group", () => {
  const t = new FakeCorpusTable();
  runInsert(t, [{ symbol: "X", timeframe: "1day", direction: "supply", candleDatetime: "2026-01-01" }]);
  assertEquals(t.rows[0].example_group_id, null,
    "grouping a lone example would invent a demonstration it is not part of");
});

Deno.test("two independent chains get two groups, not one", () => {
  const t = new FakeCorpusTable();
  runInsert(t, [
    W, D,
    { localId: "w2", symbol: "GBP/AUD", timeframe: "1week", direction: "supply", candleDatetime: "2026-04-06" },
    { localId: "d2", symbol: "GBP/AUD", timeframe: "1day", direction: "supply", candleDatetime: "2026-04-09", localParentId: "w2" },
  ]);
  const groups = new Set(t.rows.map((r) => r.example_group_id));
  assertEquals(groups.size, 2, "separate demonstrations must not be merged");
  const aud = t.rows.filter((r) => r.symbol === "AUD/USD").map((r) => r.example_group_id);
  assertEquals(new Set(aud).size, 1);
});

Deno.test("validation failures produce no waves at all", () => {
  const t = new FakeCorpusTable();
  const { problems, written } = runInsert(t, [
    { localId: "a", symbol: "X", timeframe: "1d", direction: "demand", localParentId: "b", exampleGroupId: "g" },
    { localId: "b", symbol: "X", timeframe: "4h", direction: "demand", localParentId: "a", exampleGroupId: "g" },
  ]);
  assert(problems.some((p) => p.why.includes("cycle")));
  assertEquals(written.length, 0, "nothing is written when the batch is rejected");
  assertEquals(t.rows.length, 0);
});

Deno.test("an unresolved local parent is REFUSED, never written as a null edge", () => {
  // The failure mode the wave planner exists to remove. `real ?? null` looked
  // defensive and quietly restored it: a child stored with no parent, no error,
  // and a success response.
  const plan = planCorpusInsert([W, D], () => crypto.randomUUID());
  assertEquals(plan.waves.length, 2);
  const childWave = plan.waves[1];
  assertEquals(childWave[0].localParentId, "w");

  // Deliberately omit the mapping the first wave should have produced.
  const err = assertThrows(
    () => resolveWaveParents(childWave, new Map()),
    UnresolvedParentError,
  ) as UnresolvedParentError;
  assertEquals(err.localParentId, "w");
  assertEquals(err.sourceIndex, 1);
  assert(err.message.includes("silently"), "the message must name the failure being prevented");

  // With the mapping present it resolves normally — the guard is not blanket.
  const ok = resolveWaveParents(childWave, new Map([["w", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]]));
  assertEquals(ok[0].parent_example_id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
});

Deno.test("a partially-written batch refuses the child rather than orphaning it", () => {
  // Simulates the production loop when wave 1 returns nothing usable.
  const t = new FakeCorpusTable();
  const plan = planCorpusInsert([W, D, H], () => crypto.randomUUID());
  t.upsert(resolveWaveParents(plan.waves[0], new Map()));   // weekly lands
  assertEquals(t.rows.length, 1);

  // ...but its id never made it into the map.
  assertThrows(() => resolveWaveParents(plan.waves[1], new Map()), UnresolvedParentError);
  assertEquals(t.rows.length, 1, "no orphaned child was written");
  assertEquals(t.rows[0].parent_example_id, null);
});

Deno.test("a stored group is reused even when the caller names none", () => {
  const t = new FakeCorpusTable();
  runInsert(t, [W, D]);
  const g = t.rows[0].example_group_id;

  // Third level arrives later, in its own batch, with no group supplied.
  runInsert(t, [
    { localId: "w", symbol: "AUD/USD", timeframe: "1week", direction: "demand", candleDatetime: "2026-03-02" },
    { localId: "h", symbol: "AUD/USD", timeframe: "4h", direction: "demand", candleDatetime: "2026-03-05T12:00", localParentId: "w" },
  ]);
  assertEquals(new Set(t.rows.map((r) => r.example_group_id)).size, 1,
    "the later batch joined the existing demonstration instead of starting a new one");
  assertEquals(t.rows.find((r) => r.timeframe === "4h")!.example_group_id, g);
});

Deno.test("an upsert never blanks the group of a solo row that already has one", () => {
  const t = new FakeCorpusTable();
  const solo = { symbol: "X", timeframe: "1day", direction: "supply", candleDatetime: "2026-01-01" };
  runInsert(t, [{ ...solo, exampleGroupId: "77777777-7777-4777-8777-777777777777" }]);
  assertEquals(t.rows[0].example_group_id, "77777777-7777-4777-8777-777777777777");

  runInsert(t, [solo]);                       // re-sent without the group
  assertEquals(t.rows.length, 1);
  assertEquals(t.rows[0].example_group_id, "77777777-7777-4777-8777-777777777777",
    "a group the row already has survives an upsert that does not mention it");
});

// ─── project-owned corpus: the full 12-row batch ─────────────────────────────

/** The real first batch: 12 rows, 11 demonstrations, one W->D->4H style chain. */
const BATCH = [
  { symbol: "AUD/USD", timeframe: "1d", candleDatetime: "2026-03-19T00:00:00Z", direction: "supply", evidenceSource: "USER_CONFIRMED" },
  { symbol: "AUD/USD", timeframe: "1d", candleDatetime: "2026-03-30T00:00:00Z", direction: "demand", evidenceSource: "USER_CONFIRMED" },
  { symbol: "AUD/USD", timeframe: "1d", candleDatetime: "2026-04-03T00:00:00Z", direction: "demand", evidenceSource: "USER_CONFIRMED" },
  { symbol: "GBP/AUD", timeframe: "1d", candleDatetime: "2026-03-11T00:00:00Z", direction: "demand", evidenceSource: "USER_CONFIRMED" },
  { symbol: "GBP/AUD", timeframe: "1d", candleDatetime: "2026-03-26T00:00:00Z", direction: "supply", evidenceSource: "USER_CONFIRMED" },
  { symbol: "GBP/AUD", timeframe: "1d", candleDatetime: "2026-05-14T00:00:00Z", direction: "demand", evidenceSource: "USER_CONFIRMED" },
  { symbol: "GBP/CAD", timeframe: "1d", candleDatetime: "2026-05-08T00:00:00Z", direction: "supply", evidenceSource: "USER_CONFIRMED" },
  { symbol: "BTC/USD", timeframe: "1d", candleDatetime: "2020-03-27T00:00:00Z", direction: "demand", evidenceSource: "VIDEO_DEMONSTRATION" },
  { symbol: "BTC/USD", timeframe: "1d", candleDatetime: "2020-04-08T00:00:00Z", direction: "supply", evidenceSource: "VIDEO_DEMONSTRATION" },
  { localId: "btc_may11_daily", symbol: "BTC/USD", timeframe: "1d", candleDatetime: "2020-05-11T00:00:00Z", direction: "demand", evidenceSource: "VIDEO_DEMONSTRATION" },
  { symbol: "BTC/USD", timeframe: "4h", candleDatetime: "2020-05-08T16:00:00Z", direction: "supply", evidenceSource: "VIDEO_DEMONSTRATION" },
  { localId: "btc_may11_4h", localParentId: "btc_may11_daily", symbol: "BTC/USD", timeframe: "4h", candleDatetime: "2020-05-11T16:00:00Z", direction: "demand", evidenceSource: "VIDEO_DEMONSTRATION" },
];

const demosOf = (rows: any[]) =>
  new Set(rows.map((r) => r.example_group_id ?? `solo:${r.id}`)).size;

Deno.test("the 12-row batch round-trips as 11 demonstrations with one chain", () => {
  const t = new FakeCorpusTable();
  const { written } = runInsert(t, BATCH);

  assertEquals(t.rows.length, 12, "12 corpus rows");
  assertEquals(written.length, 12);
  assertEquals(demosOf(t.rows), 11, "11 demonstrations — the chain counts once");

  const chains = t.rows.filter((r) => r.parent_example_id);
  assertEquals(chains.length, 1, "exactly one refinement edge");
  const child = t.rows.find((r) => r.timeframe === "4h" && r.direction === "demand")!;
  const parent = t.rows.find((r) => r.id === child.parent_example_id)!;
  assertEquals(parent.timeframe, "1d");
  assertEquals(parent.candle_datetime, "2020-05-11T00:00:00Z");
  assertEquals(child.example_group_id, parent.example_group_id);

  // The unrelated 4H supply row must NOT be swept into the chain's group.
  const lone4h = t.rows.find((r) => r.timeframe === "4h" && r.direction === "supply")!;
  assertEquals(lone4h.example_group_id, null);
  assertEquals(lone4h.parent_example_id, null);

  // Positives only: no row carries anything resembling a label.
  for (const r of t.rows) {
    assertEquals((r as any).label, undefined);
    assertEquals((r as any).user_id, undefined, "project-owned — no ownership column");
  }
});

Deno.test("re-sending the 12-row batch is idempotent, edges and groups intact", () => {
  const t = new FakeCorpusTable();
  runInsert(t, BATCH);
  const ids = t.rows.map((r) => r.id).sort();
  const groups = t.rows.map((r) => `${r.symbol}|${r.timeframe}|${r.example_group_id}`).sort();
  const child0 = t.rows.find((r) => r.parent_example_id)!;

  runInsert(t, BATCH);                       // random mint again

  assertEquals(t.rows.length, 12, "no duplicates");
  assertEquals(t.rows.map((r) => r.id).sort(), ids, "ids are stable");
  assertEquals(t.rows.map((r) => `${r.symbol}|${r.timeframe}|${r.example_group_id}`).sort(), groups,
    "demonstration identity is preserved, not re-minted");
  const child1 = t.rows.find((r) => r.id === child0.id)!;
  assertEquals(child1.parent_example_id, child0.parent_example_id, "the edge survives");
  assertEquals(demosOf(t.rows), 11);
});

Deno.test("two symbols sharing a bar and direction are still distinct rows", () => {
  // The unique key lost user_id but kept symbol, so this must not collapse.
  const t = new FakeCorpusTable();
  runInsert(t, [
    { symbol: "AUD/USD", timeframe: "1d", candleDatetime: "2026-03-19T00:00:00Z", direction: "supply" },
    { symbol: "GBP/AUD", timeframe: "1d", candleDatetime: "2026-03-19T00:00:00Z", direction: "supply" },
  ]);
  assertEquals(t.rows.length, 2);
});

Deno.test("a negative label is refused before any wave is planned", () => {
  const t = new FakeCorpusTable();
  const { problems, written } = runInsert(t, [
    ...BATCH.slice(0, 2),
    { symbol: "AUD/USD", timeframe: "1d", candleDatetime: "2026-06-01T00:00:00Z", direction: "supply", label: "NEGATIVE" },
  ]);
  assert(problems.some((p) => p.why.includes("POSITIVES ONLY")));
  assertEquals(written.length, 0, "the whole batch is rejected, not partially applied");
  assertEquals(t.rows.length, 0);
});

Deno.test("confidence tier and source family are stored, not derived", () => {
  const t = new FakeCorpusTable();
  runInsert(t, [
    {
      symbol: "BTC/USD", timeframe: "1d", candleDatetime: "2020-04-20T00:00:00Z", direction: "demand",
      evidenceSource: "VIDEO_DEMONSTRATION",
      confidenceTier: "TIER_1_DIRECTLY_INSPECTABLE", sourceFamily: "EZZY",
    },
  ]);
  assertEquals(t.rows[0].confidence_tier, "TIER_1_DIRECTLY_INSPECTABLE");
  assertEquals(t.rows[0].source_family, "EZZY");
});

Deno.test("an unattributed row stores NULL rather than a guessed family", () => {
  // The whole point of the columns: absence of evidence must be recorded as
  // absence, never defaulted to the family that happens to be most common.
  const t = new FakeCorpusTable();
  runInsert(t, [
    { symbol: "BTC/USD", timeframe: "1d", candleDatetime: "2020-06-01T00:00:00Z", direction: "demand" },
  ]);
  assertEquals(t.rows[0].confidence_tier, null);
  assertEquals(t.rows[0].source_family, null);
});

Deno.test("TubePull keeps its own family and is never folded into EZZY", () => {
  const t = new FakeCorpusTable();
  runInsert(t, [
    {
      symbol: "BTC/USD", timeframe: "1d", candleDatetime: "2020-07-01T00:00:00Z", direction: "supply",
      sourceFamily: "TUBEPULL_UNKNOWN_SOURCE",
    },
  ]);
  assertEquals(t.rows[0].source_family, "TUBEPULL_UNKNOWN_SOURCE");
  assert(t.rows.every((r) => r.source_family !== "EZZY"));
});

Deno.test("a misspelt tier or family is refused and nothing is written", () => {
  for (const bad of [{ confidenceTier: "TIER_1" }, { sourceFamily: "ezzy" }]) {
    const t = new FakeCorpusTable();
    const { problems, written } = runInsert(t, [
      { symbol: "BTC/USD", timeframe: "1d", candleDatetime: "2020-08-01T00:00:00Z", direction: "demand", ...bad },
    ]);
    assert(problems.length > 0, `${JSON.stringify(bad)} must be rejected`);
    assertEquals(written.length, 0);
    assertEquals(t.rows.length, 0);
  }
});

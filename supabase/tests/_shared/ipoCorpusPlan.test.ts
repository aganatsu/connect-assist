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
      const key = (r: any) =>
        `${r.user_id}|${r.symbol}|${r.timeframe}|${r.candle_datetime ?? "~"}|${r.direction}`;
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
function runInsert(table: FakeCorpusTable, rows: any[], userId = "u1",
                   mint: () => string = () => crypto.randomUUID()) {
  const existingGroupByKey = new Map<string, string>();
  for (const r of table.rows) {
    if (r.user_id === userId && r.example_group_id) {
      existingGroupByKey.set(corpusNaturalKey(r), r.example_group_id);
    }
  }
  const plan = planCorpusInsert(rows, userId, mint, existingGroupByKey);
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
  const plan = planCorpusInsert([W, D], "u1", () => crypto.randomUUID());
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
  const plan = planCorpusInsert([W, D, H], "u1", () => crypto.randomUUID());
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

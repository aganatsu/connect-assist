/**
 * ROUTE 2 ATOMIC FILL — tested against REAL PostgreSQL (PGlite, Postgres 16).
 *
 * The function under test is the migration file itself, applied to the
 * production table definitions (baseline DDL + every later migration that
 * touches these tables). A mock would prove nothing about the property that
 * matters: that "order filled" and "position exists" commit together or not
 * at all.
 *
 * The race it closes, proven on order a439f5bc (USD/JPY short, 2026-09-29):
 * the position was inserted first, bot-scanner reset the order before the
 * guarded "filled" update ran, that update matched zero rows silently, and
 * the order stayed live and fillable for 58 minutes after its position
 * existed.
 *
 * On concurrency: PGlite is one connection, so two claims serialise here. In
 * production Postgres two concurrent UPDATEs of one row also serialise — the
 * second blocks on the row lock and, under READ COMMITTED, re-evaluates its
 * WHERE against the committed version (EvalPlanQual). The guard
 * `status = 'awaiting_confirmation' AND confirmation_arm_count = $expected`
 * therefore fails for the second claimant in both settings; the ordered
 * tests below are exactly that second-claimant view.
 */

import { assertEquals, assert, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
// Loaded from the published build, not `npm:` — this repo has a package.json
// and no deno.json, so Deno resolves npm specifiers from node_modules, which
// the CI Deno job never installs. The wasm and data files resolve relative to
// this module and are fetched at run time (CI grants --allow-net).
import { PGlite } from "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist/index.js";
import { buildEntryTelemetry, entryDecisionSnapshot } from "../../functions/_shared/smcTradeTelemetry.ts";
import { interpretClaim, claimRoute2Fill, describeClaimMiss, type RpcClient } from "../../functions/_shared/route2FillClaim.ts";

const read = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url));
const BASELINE = read("../../migrations/20260914000000_baseline_schema.sql");
const LATER = [
  "../../migrations/20260928140000_smc_trade_telemetry_parity.sql",
  "../../migrations/20260929120000_route2_forward_validation.sql",
  "../../migrations/20260930020000_route2_lifecycle_v2.sql",
  "../../migrations/20260930140000_route2_atomic_fill.sql",
].map(read);

const USER = "57c79dee-db6b-4fae-b34a-4b64ce33ca34";
const OTHER_USER = "11111111-1111-4111-8111-111111111111";

/** CREATE TABLE block for one table, verbatim from the baseline. */
function tableDdl(name: string): string {
  const start = BASELINE.indexOf(`CREATE TABLE IF NOT EXISTS public.${name} (`);
  if (start < 0) throw new Error(`baseline has no CREATE TABLE for ${name}`);
  return BASELINE.slice(start, BASELINE.indexOf("\n);", start) + 3);
}

// PGlite sees Deno's Node-compat globals and would try fs.readFile on its
// wasm/data URLs. Supplying the assets directly sidesteps that detection.
const PGLITE_DIST = "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist";
let assets: Promise<{ wasmModule: WebAssembly.Module; fsBundle: Blob }> | null = null;
const pgliteAssets = () => assets ??= (async () => ({
  wasmModule: await WebAssembly.compile(await (await fetch(`${PGLITE_DIST}/postgres.wasm`)).arrayBuffer()),
  fsBundle: await (await fetch(`${PGLITE_DIST}/postgres.data`)).blob(),
}))();

/**
 * Emscripten decides "am I Node?" from `globalThis.process`, which Deno
 * defines. Taking the Node branch makes it call createRequire() on an https
 * URL and fail. Hide `process` ONLY while PGlite initialises, so it takes the
 * browser branch with the assets supplied above, then restore it.
 */
async function newPglite(): Promise<PGlite> {
  const a = await pgliteAssets();
  const g = globalThis as Record<string, unknown>;
  const desc = Object.getOwnPropertyDescriptor(g, "process");
  Object.defineProperty(g, "process", { value: undefined, configurable: true, writable: true });
  try {
    const db = new PGlite(a);
    await db.waitReady;
    return db;
  } finally {
    if (desc) Object.defineProperty(g, "process", desc); else delete g.process;
  }
}

async function freshDb(): Promise<PGlite> {
  const db = await newPglite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    ${tableDdl("paper_positions")}
    ${tableDdl("pending_orders")}
    ${tableDdl("paper_trade_history")}
    alter table public.paper_positions add constraint paper_positions_pkey primary key (id);
    alter table public.pending_orders add constraint pending_orders_pkey primary key (id);
    ${BASELINE.match(/ALTER TABLE public\.pending_orders ADD CONSTRAINT pending_orders_status_check[^\n]*/)![0]}
    ${BASELINE.match(/CREATE UNIQUE INDEX idx_paper_positions_pending_source[^\n]*/)![0]}
  `);
  for (const sql of LATER) await db.exec(sql);
  return db;
}

/** Insert a pending order in a given state; returns its uuid. */
async function seedPending(db: PGlite, over: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = {
    user_id: USER, bot_id: "smc", order_id: "a439f5bc", symbol: "USD/JPY", direction: "short",
    order_type: "limit", entry_price: 157.6272, current_price: 157.60, stop_loss: 157.8789804, take_profit: 157.35239406,
    size: 1.2, status: "awaiting_confirmation", confirmation_arm_count: 1,
    expires_at: "2026-09-29T11:25:12Z", placed_at: "2026-09-29T10:25:12Z",
    ...over,
  };
  const cols = Object.keys(row);
  const r = await db.query<{ id: string }>(
    `insert into public.pending_orders (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`,
    cols.map((c) => row[c]),
  );
  return r.rows[0].id;
}

/** The position payload exactly as the fill paths build it (same keys). */
function positionPayload(pendingId: string, over: Record<string, unknown> = {}) {
  const now = "2026-09-29T10:27:22.691Z";
  const telemetry = buildEntryTelemetry({
    route: "route2_pending", direction: "short", entryPrice: 157.55707,
    entryStopLoss: 157.8789804, entryTakeProfit: 157.35239406, entryTime: now,
    strategyBarTime: null, pipSize: 0.01, tradingStyle: "scalper", zoneTimeframe: "IZ-FVG",
    configSnapshot: {}, decisionSnapshot: entryDecisionSnapshot({ setupId: "a439f5bc" }),
    strategyVersion: "smc-route2-confirmation-lifecycle-v2", sourcePendingOrderId: pendingId,
  });
  return {
    user_id: USER, position_id: "a439f5bc", symbol: "USD/JPY", direction: "short",
    size: "1.2", ...telemetry, frozen_strategy_context: null,
    entry_price: "157.55707", current_price: "157.55707", stop_loss: "157.8789804",
    take_profit: "157.35239406", open_time: now, signal_reason: JSON.stringify({ confirmationEntry: true }),
    signal_score: "44", order_id: "ord00001", position_status: "open", bot_id: "smc",
    order_type: "limit", trigger_price: "157.6272",
    ...over,
  };
}

const FILL_PATCH = {
  terminal_reason: "FILLED", confirmation_checked_at: "2026-09-29T10:27:22Z",
  confirmation_timeframe: "5m", confirmation_type: "bearish_reversal_pattern", confirmation_tier: 3,
  confirmation_accepted: true, confirmation_accepted_at: "2026-09-29T10:27:22Z",
  trigger_timestamp: "2026-09-29T10:27:22Z", fill_timestamp: "2026-09-29T10:27:22Z",
  fill_price: 157.55707, entry_confirmation: { tier: 3, type: "bearish_reversal_pattern" },
  zone_story_at_confirmation: null, zone_story_at_fill: null,
  fill_reason: "[fast-confirm] bearish_reversal_pattern @ 157.55707",
  filled_at: "2026-09-29T10:27:22Z", resolved_at: "2026-09-29T10:27:22Z",
};

/** Call the SQL function directly. */
async function claim(db: PGlite, pendingId: string, expectedArm: number | null,
  position = positionPayload(pendingId), patch: Record<string, unknown> = FILL_PATCH, user = USER) {
  const r = await db.query<{ r: Record<string, unknown> }>(
    `select public.route2_claim_and_fill($1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb) as r`,
    [pendingId, user, expectedArm, JSON.stringify(patch), JSON.stringify(position)],
  );
  return r.rows[0].r;
}

/** A supabase-shaped client backed by the real function, for claimRoute2Fill. */
const rpcClient = (db: PGlite): RpcClient => ({
  async rpc(_fn, a) {
    try {
      const r = await db.query<{ r: unknown }>(
        `select public.route2_claim_and_fill($1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb) as r`,
        [a.p_pending_id, a.p_user_id, a.p_expected_arm_count, JSON.stringify(a.p_pending_patch), JSON.stringify(a.p_position)],
      );
      return { data: r.rows[0].r, error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message } };
    }
  },
});

const count = async (db: PGlite, sql: string, params: unknown[] = []) =>
  Number((await db.query<{ n: number }>(`select count(*)::int as n from ${sql}`, params)).rows[0].n);
const pendingState = async (db: PGlite, id: string) =>
  (await db.query<{ status: string; confirmation_arm_count: number; fill_price: string | null; filled_at: string | null }>(
    `select status, confirmation_arm_count, fill_price, filled_at from public.pending_orders where id = $1`, [id])).rows[0];

// ─── 1-4. two pollers, one order ────────────────────────────────────────────

Deno.test("1-4 · two pollers claim the same order: exactly one wins, one position", async () => {
  const db = await freshDb();
  const id = await seedPending(db);
  // Both pollers read the same state (arm 1) and both saw a confirmation.
  const [a, b] = await Promise.all([
    claimRoute2Fill(rpcClient(db), { pendingRowId: id, userId: USER, expectedArmCount: 1, pendingPatch: FILL_PATCH, position: positionPayload(id) }),
    claimRoute2Fill(rpcClient(db), { pendingRowId: id, userId: USER, expectedArmCount: 1, pendingPatch: FILL_PATCH, position: positionPayload(id) }),
  ]);
  const outcomes = [a.outcome, b.outcome].sort();
  assertEquals(outcomes, ["filled", "lost_race"], "exactly one claimant must win");
  assertEquals(await count(db, "public.paper_positions where source_pending_order_id = $1", [id]), 1);
  assertEquals(await count(db, "public.paper_positions"), 1, "the loser created nothing");
  const loser = a.outcome === "lost_race" ? a : b;
  assertEquals((loser as { currentStatus: string }).currentStatus, "filled");
  assertEquals((await pendingState(db, id)).status, "filled");
  await db.close();
});

// ─── 5-7. terminal states cannot fill ───────────────────────────────────────

for (const status of ["filled", "cancelled", "expired"]) {
  Deno.test(`5-7 · a ${status} order cannot be filled`, async () => {
    const db = await freshDb();
    const id = await seedPending(db, { status, confirmation_arm_count: 1 });
    const r = await claim(db, id, 1);
    assertEquals(r.outcome, "lost");
    assertEquals(r.current_status, status);
    assertEquals(await count(db, "public.paper_positions"), 0);
    assertEquals((await pendingState(db, id)).status, status, "state must be untouched");
    await db.close();
  });
}

Deno.test("a pending (not yet touched) order cannot be filled either", async () => {
  const db = await freshDb();
  const id = await seedPending(db, { status: "pending", confirmation_arm_count: 0 });
  assertEquals((await claim(db, id, 0)).outcome, "lost");
  assertEquals(await count(db, "public.paper_positions"), 0);
  await db.close();
});

// ─── 8. stale confirmation ──────────────────────────────────────────────────

Deno.test("8 · a reset-and-re-armed order cannot be filled with the stale confirmation", async () => {
  const db = await freshDb();
  const id = await seedPending(db, { confirmation_arm_count: 1 });
  // Poller A read arm 1 and found a confirmation. Before it claims, the other
  // poller resets the hunt and a NEW touch re-arms it — same status, arm 2.
  await db.query(`update public.pending_orders set status='pending' where id=$1`, [id]);
  await db.query(`update public.pending_orders set status='awaiting_confirmation', confirmation_arm_count=2 where id=$1`, [id]);
  const r = await claim(db, id, 1);
  assertEquals(r.outcome, "lost", "status matches, but it is a different hunt");
  assertEquals(r.current_arm_count, 2);
  assertEquals(await count(db, "public.paper_positions"), 0);
  // The CURRENT hunt can still fill with its own confirmation.
  assertEquals((await claim(db, id, 2)).outcome, "filled");
  await db.close();
});

Deno.test("REGRESSION a439f5bc · reset between read and claim => no position, order stays live", async () => {
  const db = await freshDb();
  const id = await seedPending(db, { order_id: "a439f5bc", confirmation_arm_count: 1 });
  // zone-confirmation-scanner has confirmed (arm 1). bot-scanner resets the
  // hunt to 'pending' first. The OLD code had already inserted the position
  // here; the new claim must refuse and create nothing.
  await db.query(`update public.pending_orders set status='pending', zone_touch_time=null where id=$1`, [id]);
  const out = await claimRoute2Fill(rpcClient(db), {
    pendingRowId: id, userId: USER, expectedArmCount: 1, pendingPatch: FILL_PATCH, position: positionPayload(id),
  });
  assertEquals(out.outcome, "lost_race");
  assertEquals(await count(db, "public.paper_positions"), 0, "the position a439f5bc got must NOT exist");
  const st = await pendingState(db, id);
  assertEquals(st.status, "pending", "the order is correctly still live — no orphaned fill");
  assertEquals(st.filled_at, null);
  assert(describeClaimMiss(out as never).includes("lost race"));
  await db.close();
});

// ─── 9. uniqueness ──────────────────────────────────────────────────────────

Deno.test("9 · source_pending_order_id uniqueness blocks a second position, and rolls back the claim", async () => {
  const db = await freshDb();
  const id = await seedPending(db);
  // An orphan already exists for this pending order (the a439f5bc shape),
  // while the order itself still looks fillable.
  const orphan = positionPayload(id, { position_id: "orphan01" });
  const cols = Object.keys(orphan);
  await db.query(
    `insert into public.paper_positions (${cols.join(",")})
     select ${cols.join(",")} from jsonb_populate_record(null::public.paper_positions, $1::jsonb)`,
    [JSON.stringify(orphan)]);
  const r = await claim(db, id, 1);
  assertEquals(r.outcome, "duplicate_position");
  assertEquals(await count(db, "public.paper_positions where source_pending_order_id = $1", [id]), 1);
  assertEquals((await pendingState(db, id)).status, "awaiting_confirmation",
    "the claim must be rolled back with the failed insert");
  await db.close();
});

Deno.test("the caller cannot bind a position to a different pending order", async () => {
  const db = await freshDb();
  const id = await seedPending(db);
  const r = await claim(db, id, 1, positionPayload(id, { source_pending_order_id: crypto.randomUUID() }));
  assertEquals(r.outcome, "filled");
  const got = await db.query<{ s: string }>(`select source_pending_order_id::text as s from public.paper_positions`);
  assertEquals(got.rows[0].s, id, "source_pending_order_id is forced to the claimed row");
  await db.close();
});

// ─── 10. insert failure after claim ─────────────────────────────────────────

Deno.test("10 · a failed position insert leaves NO false fill — the order is still fillable", async () => {
  const db = await freshDb();
  const id = await seedPending(db);
  // Violates paper_positions_initial_risk_positive (telemetry migration).
  const bad = positionPayload(id, { initial_risk_price: -1 });
  await assertRejects(() => claim(db, id, 1, bad));
  let st = await pendingState(db, id);
  assertEquals(st.status, "awaiting_confirmation", "claim rolled back with the insert");
  assertEquals(st.fill_price, null, "no fill telemetry leaked");
  assertEquals(await count(db, "public.paper_positions"), 0);
  // Through the TS wrapper it is a `failed` outcome, never a throw.
  const out = await claimRoute2Fill(rpcClient(db), {
    pendingRowId: id, userId: USER, expectedArmCount: 1, pendingPatch: FILL_PATCH, position: bad,
  });
  assertEquals(out.outcome, "failed");
  // Deterministic recovery: the next poll, with a good payload, fills it.
  assertEquals((await claim(db, id, 1)).outcome, "filled");
  st = await pendingState(db, id);
  assertEquals(st.status, "filled");
  assertEquals(await count(db, "public.paper_positions"), 1);
  await db.close();
});

Deno.test("unknown or generated columns fail loudly and commit nothing", async () => {
  const db = await freshDb();
  const id = await seedPending(db);
  await assertRejects(() => claim(db, id, 1, positionPayload(id, { not_a_column: 1 })), Error, "not writable paper_positions");
  await assertRejects(() => claim(db, id, 1, positionPayload(id, { cross_tf_context_version: "x" })), Error, "not writable paper_positions");
  await assertRejects(() => claim(db, id, 1, positionPayload(id), { ...FILL_PATCH, bogus: 1 }), Error, "not writable pending_orders");
  assertEquals((await pendingState(db, id)).status, "awaiting_confirmation");
  assertEquals(await count(db, "public.paper_positions"), 0);
  await db.close();
});

// ─── identity, typing, permissions ──────────────────────────────────────────

Deno.test("the patch cannot move identity or guarded state", async () => {
  const db = await freshDb();
  const id = await seedPending(db);
  const r = await claim(db, id, 1, positionPayload(id),
    { ...FILL_PATCH, status: "cancelled", user_id: OTHER_USER, order_id: "hijack", confirmation_arm_count: 99 });
  assertEquals(r.outcome, "filled");
  const row = (await db.query<Record<string, unknown>>(
    `select status, user_id::text as u, order_id, confirmation_arm_count as a from public.pending_orders where id=$1`, [id])).rows[0];
  assertEquals(row.status, "filled");
  assertEquals(row.u, USER);
  assertEquals(row.order_id, "a439f5bc");
  assertEquals(row.a, 1);
  await db.close();
});

Deno.test("another user's order cannot be claimed", async () => {
  const db = await freshDb();
  const id = await seedPending(db);
  assertEquals((await claim(db, id, 1, positionPayload(id), FILL_PATCH, OTHER_USER)).outcome, "lost");
  assertEquals(await count(db, "public.paper_positions"), 0);
  await db.close();
});

Deno.test("values land with their real types — the payload the scanners send is valid", async () => {
  const db = await freshDb();
  const id = await seedPending(db);
  assertEquals((await claim(db, id, 1)).outcome, "filled");
  const p = (await db.query<Record<string, unknown>>(
    `select entry_route, strategy_version, initial_risk_price::float8 as risk,
            entry_decision_snapshot->>'setupId' as setup, position_status, open_time
       from public.paper_positions`)).rows[0];
  assertEquals(p.entry_route, "route2_pending");
  assertEquals(p.strategy_version, "smc-route2-confirmation-lifecycle-v2");
  assert(Math.abs((p.risk as number) - 0.3219104) < 1e-6);
  assertEquals(p.setup, "a439f5bc");
  assertEquals(p.position_status, "open");
  const po = (await db.query<Record<string, unknown>>(
    `select terminal_reason, confirmation_tier, fill_price::float8 as fp, entry_confirmation->>'type' as t
       from public.pending_orders where id=$1`, [id])).rows[0];
  assertEquals(po.terminal_reason, "FILLED");
  assertEquals(po.confirmation_tier, 3);
  assertEquals(po.fp, 157.55707);
  assertEquals(po.t, "bearish_reversal_pattern");
  await db.close();
});

Deno.test("only service_role may execute the function", async () => {
  const db = await freshDb();
  const sig = "public.route2_claim_and_fill(uuid, uuid, integer, jsonb, jsonb)";
  const can = async (role: string) =>
    (await db.query<{ ok: boolean }>(`select has_function_privilege($1, $2, 'execute') as ok`, [role, sig])).rows[0].ok;
  assertEquals(await can("service_role"), true);
  assertEquals(await can("anon"), false, "anon must not insert positions for arbitrary users");
  assertEquals(await can("authenticated"), false);
  await db.close();
});

// ─── the scanners' real key sets against the real schema ────────────────────

Deno.test("every key both scanners send exists as a writable column", async () => {
  const db = await freshDb();
  const writable = async (t: string) => new Set((await db.query<{ c: string }>(
    `select column_name as c from information_schema.columns
      where table_schema='public' and table_name=$1 and is_generated='NEVER'`, [t])).rows.map((r) => r.c));
  const pendingCols = await writable("pending_orders");
  const positionCols = await writable("paper_positions");
  /** Top-level keys of `const <decl> = { ... }`, found by brace matching. */
  const keysOf = (src: string, decl: string) => {
    const i = src.indexOf(`const ${decl} = {`);
    assert(i > -1, `${decl} not found`);
    const open = src.indexOf("{", i);
    let depth = 0, j = open;
    for (; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}" && --depth === 0) break;
    }
    const body = src.slice(open + 1, j);
    const keys = [...body.matchAll(/^\s+([a-z_]+):/gm)].map((m) => m[1]);
    assert(keys.length > 5, `${decl}: parsed only ${keys.length} keys — the parser has drifted`);
    return keys;
  };

  for (const [name, rel] of [["bot-scanner", "../../functions/bot-scanner/index.ts"],
    ["zone-confirm", "../../functions/zone-confirmation-scanner/index.ts"]] as const) {
    const src = read(rel);
    for (const k of keysOf(src, "pendingFillPatch")) {
      assert(pendingCols.has(k), `${name}: pendingFillPatch key "${k}" is not a writable pending_orders column`);
    }
    for (const k of keysOf(src, "positionRow")) {
      assert(positionCols.has(k), `${name}: positionRow key "${k}" is not a writable paper_positions column`);
    }
  }
  await db.close();
});

// ─── wrapper behaviour ──────────────────────────────────────────────────────

Deno.test("interpretClaim: only a well-formed `filled` reply is a fill", () => {
  assertEquals(interpretClaim({ outcome: "filled", pending_id: "x", position_row_id: "y" }, null).outcome, "filled");
  assertEquals(interpretClaim({ outcome: "filled" }, null).outcome, "failed", "filled without an id is not trusted");
  assertEquals(interpretClaim({ outcome: "lost", current_status: "cancelled" }, null).outcome, "lost_race");
  assertEquals(interpretClaim({ outcome: "duplicate_position" }, null).outcome, "duplicate_position");
  assertEquals(interpretClaim(null, { message: "boom" }).outcome, "failed");
  assertEquals(interpretClaim({ outcome: "weird" }, null).outcome, "failed");
  assertEquals(interpretClaim(undefined, null).outcome, "failed");
});

Deno.test("claimRoute2Fill never throws, and refuses to run without an id", async () => {
  const throwing: RpcClient = { rpc: () => { throw new Error("network down"); } };
  assertEquals((await claimRoute2Fill(throwing, {
    pendingRowId: "x", userId: "u", expectedArmCount: 1, pendingPatch: {}, position: {},
  })).outcome, "failed");
  const never: RpcClient = { rpc: () => { throw new Error("must not be called"); } };
  assertEquals((await claimRoute2Fill(never, {
    pendingRowId: "", userId: "u", expectedArmCount: 1, pendingPatch: {}, position: {},
  })).outcome, "failed");
});

// ─── the pollers: only a `filled` claim may do anything downstream ──────────

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const POLLERS = [
  ["bot-scanner", strip(read("../../functions/bot-scanner/index.ts"))],
  ["zone-confirm", strip(read("../../functions/zone-confirmation-scanner/index.ts"))],
] as const;

Deno.test("both pollers fill ONLY through the atomic claim, keyed on the row and arm they read", () => {
  for (const [name, src] of POLLERS) {
    assert(/claimRoute2Fill\(supabase, \{/.test(src), `${name} must claim through claimRoute2Fill`);
    assert(/pendingRowId: \(pending as any\)\.id,/.test(src), `${name} must claim by primary key`);
    assert(/expectedArmCount: \(pending as any\)\.confirmation_arm_count \?\? null,/.test(src),
      `${name} must guard on the arm count it read (stale-confirmation protection)`);
    // No residual two-step fill anywhere in the file.
    assert(!/status:\s*"filled"/.test(src), `${name} still writes status "filled" outside the claim`);
  }
});

Deno.test("losing the claim returns BEFORE any reasoning, counter, notification or mirror", () => {
  for (const [name, src] of POLLERS) {
    const claimAt = src.indexOf("const claim = await claimRoute2Fill(");
    const guardAt = src.indexOf('if (claim.outcome !== "filled") {', claimAt);
    assert(claimAt > -1 && guardAt > claimAt, `${name}: claim result must be checked`);
    const guardEnd = src.indexOf("continue;", guardAt);
    assert(guardEnd > guardAt, `${name}: a lost claim must skip the rest of the order`);
    const rest = src.slice(guardEnd);
    // Everything that only makes sense for a real fill happens AFTER the guard…
    for (const marker of ['from("trade_reasonings").insert', "telegram-notify", 'execution_mode === "live"']) {
      const at = src.indexOf(marker, claimAt);
      assert(at > guardEnd, `${name}: "${marker}" must come after the lost-claim guard`);
    }
    // …and nothing between the claim and the guard does any of it.
    const between = src.slice(claimAt, guardAt);
    assert(!/insert\(|telegram|tradesPlaced\+\+|confirmed\+\+|openPos\w*\.push/.test(between),
      `${name}: nothing may run between the claim and its guard`);
    assert(rest.length > 0);
  }
});

Deno.test("zone-confirmation-scanner has no direct paper_positions insert left", () => {
  const zcs = POLLERS[1][1];
  assert(!/from\("paper_positions"\)\.insert/.test(zcs), "its only position write must be the atomic claim");
});

Deno.test("bot-scanner's only direct position insert is the retired Route 1 path", () => {
  const bs = POLLERS[0][1];
  const inserts = [...bs.matchAll(/from\("paper_positions"\)\.insert\(\{([\s\S]{0,500})/g)].map((m) => m[1]);
  assertEquals(inserts.length, 1, "exactly one direct insert should remain");
  assert(/\.\.\.r1Telemetry/.test(inserts[0]), "and it must be Route 1's market-fill insert");
});

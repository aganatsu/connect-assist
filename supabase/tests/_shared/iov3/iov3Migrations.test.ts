/**
 * Impulse-on-V3 step 3 migrations against REAL PostgreSQL (PGlite, Postgres 16), applied on top of PR2:
 *   20261027120000_structure_bars_5m.sql — canonical 5m store (append-only, grid / settled / OHLC CHECKs, service-role only);
 *   20261028000000_iov3_shadow.sql       — the switch + shadow record (append-only except the switch row; owner read via RLS).
 */
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
// @ts-ignore: remote ESM build without type declarations (same import as structureBarsMigration.test.ts)
import { PGlite } from "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist/index.js";

const read = (f: string) => Deno.readTextFileSync(new URL(`../../../migrations/${f}`, import.meta.url));
const PR2 = read("20261015000000_structure_bars_1h.sql"), PR3 = read("20261027000000_structure_v3_state.sql"), M5 = read("20261027120000_structure_bars_5m.sql"), SHADOW = read("20261028000000_iov3_shadow.sql"), ARMB = read("20261027200000_iov3_shadow_arm_b.sql"), ON = read("20261028100000_iov3_on.sql"), BPL = read("20261028200000_broker_price_log.sql");
const PGLITE_DIST = "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist";
let assets: Promise<{ wasmModule: WebAssembly.Module; fsBundle: Blob }> | null = null;
const pgliteAssets = () => assets ??= (async () => ({
  wasmModule: await WebAssembly.compile(await (await fetch(`${PGLITE_DIST}/postgres.wasm`)).arrayBuffer()),
  fsBundle: await (await fetch(`${PGLITE_DIST}/postgres.data`)).blob(),
}))();
const U1 = "00000000-0000-0000-0000-000000000001", U2 = "00000000-0000-0000-0000-000000000002";
// deno-lint-ignore no-explicit-any
async function freshDb(): Promise<any> {
  const a = await pgliteAssets();
  const g = globalThis as Record<string, unknown>;
  const desc = Object.getOwnPropertyDescriptor(g, "process"); // Emscripten must take the browser branch (see route2AtomicFill.test.ts)
  Object.defineProperty(g, "process", { value: undefined, configurable: true, writable: true });
  try {
    const db = new PGlite(a);
    await db.waitReady;
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; grant usage on schema auth to authenticated, service_role;
      create table auth.users (id uuid primary key);
      -- Supabase's auth.uid(): the JWT subject, here taken from a session setting
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant execute on function auth.uid() to authenticated;
      insert into auth.users values ('${U1}'), ('${U2}');`);
    // applied in production order: the arm-B migration was applied after the shadow tables existed
    await db.exec(PR2); await db.exec(PR3); await db.exec(M5); await db.exec(SHADOW); await db.exec(ARMB); await db.exec(ON); await db.exec(BPL);
    return db;
  } finally {
    if (desc) Object.defineProperty(g, "process", desc); else delete g.process;
  }
}

Deno.test("5m store: grid / settled / OHLC / symbol CHECKs; first wins on conflict; append-only; service_role select + insert only", async () => {
  const db = await freshDb();
  const ins = (t: string, obs: string, h = 1.1005, conflict = "") => db.query(`insert into public.structure_bars_5m (symbol, bar_time, open, high, low, close, source, observed_at)
    values ('EUR/USD', $1, 1.1, $3, 1.0995, 1.1002, 'scanner_live', $2) ${conflict}`, [t, obs, h]);
  await ins("2026-11-04 10:00:00+00", "2026-11-04 10:20:00+00");
  await ins("2026-11-04 10:00:00+00", "2026-11-04 10:30:00+00", 1.1009, "on conflict (symbol, bar_time) do nothing");
  assertEquals((await db.query(`select high::float8 h from public.structure_bars_5m`)).rows, [{ h: 1.1005 }], "first wins");
  await assertRejects(() => ins("2026-11-04 10:01:00+00", "2026-11-04 11:00:00+00"), Error, "violates check constraint", "off grid");
  await assertRejects(() => ins("2026-11-04 10:05:00+00", "2026-11-04 10:24:59+00"), Error, "violates check constraint", "not settled");
  await assertRejects(() => ins("2026-11-04 10:10:00+00", "2026-11-04 11:00:00+00", 1.099), Error, "violates check constraint", "ohlc");
  await db.query(`insert into public.structure_bar_5m_revisions (symbol, bar_time, value_hash, open, high, low, close, source, observed_at, canonical_value_hash, max_abs_diff)
                  values ('EUR/USD', '2026-11-04 10:00:00+00', 'x', 1.1, 1.1009, 1.0995, 1.1002, 'scanner_live', '2026-11-04 10:30:00+00', 'y', 0.0004)`);
  for (const t of ["structure_bars_5m", "structure_bar_5m_revisions"]) {
    await assertRejects(() => db.query(`truncate public.${t}`), Error, "append-only");
    await assertRejects(() => db.query(`update public.${t} set symbol = symbol`), Error, "append-only");
    await assertRejects(() => db.query(`delete from public.${t}`), Error, "append-only");
    const g = (await db.query(`select grantee, privilege_type from information_schema.role_table_grants where table_name = $1 and grantee in ('anon','authenticated','service_role') order by 1, 2`, [t])).rows;
    assertEquals(g, [{ grantee: "service_role", privilege_type: "INSERT" }, { grantee: "service_role", privilege_type: "SELECT" }], t);
  }
});

Deno.test("switch + shadow: mode CHECK; only the switch row is updatable; every shadow table is append-only", async () => {
  const db = await freshDb();
  await db.query(`insert into public.structure_mode (user_id, mode) values ($1, 'SHADOW')`, [U1]);
  await db.query(`update public.structure_mode set mode = 'OFF', set_at = now() where user_id = $1`, [U1]);
  await assertRejects(() => db.query(`update public.structure_mode set mode = 'MAYBE' where user_id = $1`, [U1]), Error, "violates check constraint");
  await db.query(`insert into public.iov3_shadow_cohorts (id, user_id, bot_id, started_at, first_decision_at, params, params_hash, engine_version)
                  values ('c1', $1, 'smc', now(), now(), '{}', 'h', 'v')`, [U1]);
  await db.query(`insert into public.iov3_shadow_events (cohort_id, pair, order_id, type, t, user_id, payload) values ('c1', 'EUR/USD', 'o1', 'placed', now(), $1, '{}')`, [U1]);
  await assertRejects(() => db.query(`insert into public.iov3_shadow_events (cohort_id, pair, order_id, type, t, user_id, payload) values ('c1', 'EUR/USD', 'o1', 'executed', now(), $1, '{}')`, [U1]), Error, "violates check constraint");
  await db.query(`insert into public.iov3_shadow_feedback (cohort_id, order_id, user_id, verdict) values ('c1', 'o1', $1, 'right')`, [U1]);
  await assertRejects(() => db.query(`insert into public.iov3_shadow_feedback (cohort_id, order_id, user_id, verdict) values ('c1', 'o1', $1, 'maybe')`, [U1]), Error, "violates check constraint");
  await db.query(`insert into public.structure_mode_log (user_id, bot_id, from_mode, to_mode) values ($1, 'smc', 'OFF', 'SHADOW')`, [U1]);
  await db.query(`insert into public.iov3_shadow_state (cohort_id, pair, seq, user_id, as_of, state) values ('c1', 'EUR/USD', 1, $1, now(), '{}')`, [U1]);
  await db.query(`insert into public.iov3_shadow_decisions (cohort_id, pair, t, user_id, reason) values ('c1', 'EUR/USD', now(), $1, 'no_pois')`, [U1]);
  await db.query(`insert into public.iov3_shadow_audit (cohort_id, pair, kind, ref, detail) values ('c1', 'EUR/USD', 'refused', 'r', '{}')`);
  for (const t of ["structure_mode_log", "iov3_shadow_cohorts", "iov3_shadow_state", "iov3_shadow_decisions", "iov3_shadow_events", "iov3_shadow_feedback", "iov3_shadow_audit"]) {
    assert((await db.query(`select count(*)::int n from public.${t}`)).rows[0].n > 0, `${t} seeded`);
    await assertRejects(() => db.query(`update public.${t} set created_at = created_at`).catch((e: Error) => {
      if (/column "created_at"/.test(e.message)) return db.query(`update public.${t} set ${t === "structure_mode_log" ? "at = at" : t === "iov3_shadow_feedback" ? "at = at" : "recorded_at = recorded_at"}`);
      throw e;
    }), Error, "append-only", t);
    await assertRejects(() => db.query(`delete from public.${t}`), Error, "append-only", t);
    await assertRejects(() => db.query(`truncate public.${t} cascade`), Error, "append-only", t);
  }
});

Deno.test("switch + shadow: the owner reads only their own rows; nothing for anon; no client access to state / audit; no client writes", async () => {
  const db = await freshDb();
  await db.query(`insert into public.structure_mode (user_id, mode) values ($1, 'SHADOW'), ($2, 'OFF')`, [U1, U2]);
  await db.query(`insert into public.iov3_shadow_cohorts (id, user_id, bot_id, started_at, first_decision_at, params, params_hash, engine_version)
                  values ('c1', $1, 'smc', now(), now(), '{}', 'h', 'v'), ('c2', $2, 'smc', now(), now(), '{}', 'h', 'v')`, [U1, U2]);
  await db.exec(`set role authenticated; set request.jwt.claim.sub = '${U1}';`);
  assertEquals((await db.query(`select user_id from public.structure_mode`)).rows, [{ user_id: U1 }]);
  assertEquals((await db.query(`select id from public.iov3_shadow_cohorts`)).rows, [{ id: "c1" }]);
  await assertRejects(() => db.query(`select * from public.iov3_shadow_state`), Error, "permission denied");
  await assertRejects(() => db.query(`select * from public.iov3_shadow_audit`), Error, "permission denied");
  await assertRejects(() => db.query(`update public.structure_mode set mode = 'ON'`), Error, "permission denied");
  await assertRejects(() => db.query(`insert into public.iov3_shadow_feedback (cohort_id, order_id, user_id, verdict) values ('c1', 'o', '${U1}', 'right')`), Error, "permission denied");
  await db.exec(`reset role; set role anon;`);
  await assertRejects(() => db.query(`select * from public.structure_mode`), Error, "permission denied");
  await db.exec(`reset role;`);
});

Deno.test("switch row as the service role: update (mode, set_at) and insert work; an upsert that rewrites the key columns is refused", async () => {
  // Reproduces the 2026-10-26 production error ("permission denied for table structure_mode") the structure-mode function hit
  // with supabase-js upsert(): PostgREST's ON CONFLICT DO UPDATE sets every payload column, including user_id / bot_id.
  const db = await freshDb();
  await db.exec(`set role service_role;`);
  await db.query(`insert into public.structure_mode (user_id, bot_id, mode, set_at) values ($1, 'smc', 'OFF', now())`, [U1]);
  await db.query(`update public.structure_mode set mode = 'SHADOW', set_at = now() where user_id = $1 and bot_id = 'smc'`, [U1]);
  assertEquals((await db.query(`select mode from public.structure_mode where user_id = $1`, [U1])).rows, [{ mode: "SHADOW" }]);
  await assertRejects(() => db.query(`insert into public.structure_mode (user_id, bot_id, mode, set_at) values ($1, 'smc', 'OFF', now())
    on conflict (user_id, bot_id) do update set user_id = excluded.user_id, bot_id = excluded.bot_id, mode = excluded.mode, set_at = excluded.set_at`, [U1]), Error, "permission denied");
  await db.query(`insert into public.structure_mode_log (user_id, bot_id, from_mode, to_mode) values ($1, 'smc', 'OFF', 'SHADOW')`, [U1]);
  await db.exec(`reset role;`);
});

Deno.test("arm B: per-arm keys (same pair + hour for A and B), arm CHECK, existing rows default to A, snapshots accept the internal leg", async () => {
  const db = await freshDb();
  await db.query(`insert into public.iov3_shadow_cohorts (id, user_id, bot_id, started_at, first_decision_at, params, params_hash, engine_version)
                  values ('c1', $1, 'smc', now(), now(), '{}', 'h', 'v')`, [U1]);
  await db.query(`insert into public.iov3_shadow_decisions (cohort_id, pair, t, user_id, reason) values ('c1', 'EUR/USD', '2026-10-27 05:00+00', $1, 'no_pois')`, [U1]);
  await db.query(`insert into public.iov3_shadow_decisions (cohort_id, arm, pair, t, user_id, reason) values ('c1', 'B', 'EUR/USD', '2026-10-27 05:00+00', $1, 'placed')`, [U1]);
  assertEquals((await db.query(`select arm, reason from public.iov3_shadow_decisions order by arm`)).rows, [{ arm: "A", reason: "no_pois" }, { arm: "B", reason: "placed" }]);
  await assertRejects(() => db.query(`insert into public.iov3_shadow_decisions (cohort_id, arm, pair, t, user_id, reason) values ('c1', 'C', 'EUR/USD', now(), $1, 'x')`, [U1]), Error, "violates check constraint");
  await db.query(`insert into public.iov3_shadow_state (cohort_id, arm, pair, seq, user_id, as_of, state) values ('c1', 'A', 'EUR/USD', 1, $1, now(), '{}'), ('c1', 'B', 'EUR/USD', 1, $1, now(), '{}')`, [U1]);
  await db.query(`insert into public.structure_v3_snapshots (symbol, tf, known_at, bar_time, engine_version, trend, state_hash, il_time, il_price, il_x_time, il_x_price)
                  values ('NZD/CHF', '1H', '2026-10-27 01:00+00', '2026-10-27 00:00+00', 'v', 'bull', 'h', '2026-10-02 12:00+00', 0.46338, '2026-10-27 00:00+00', 0.47142)`);
  assertEquals((await db.query(`select il_price::float8 p from public.structure_v3_snapshots`)).rows, [{ p: 0.46338 }]);
});

Deno.test("ON migration: arm A|B only, ON always has an arm, the service role may set arm / on_since / kill_reason but never the keys", async () => {
  const db = await freshDb();
  await db.exec(`set role service_role;`);
  await db.query(`insert into public.structure_mode (user_id, bot_id, mode, set_at) values ($1, 'smc', 'SHADOW', now())`, [U1]);
  await assertRejects(() => db.query(`update public.structure_mode set mode = 'ON' where user_id = $1`, [U1]), Error, "violates check constraint", "ON without an arm");
  await assertRejects(() => db.query(`update public.structure_mode set arm = 'C' where user_id = $1`, [U1]), Error, "violates check constraint");
  await db.query(`update public.structure_mode set mode = 'ON', arm = 'B', on_since = now(), kill_reason = null, set_at = now() where user_id = $1`, [U1]);
  assertEquals((await db.query(`select mode, arm from public.structure_mode where user_id = $1`, [U1])).rows, [{ mode: "ON", arm: "B" }]);
  await db.query(`update public.structure_mode set mode = 'SHADOW', kill_reason = 'ON net -8.10R ≤ -8R' where user_id = $1`, [U1]);
  await assertRejects(() => db.query(`update public.structure_mode set user_id = user_id where user_id = $1`, [U1]), Error, "permission denied");
  await db.exec(`reset role;`);
});

Deno.test("broker price log (4c): service role inserts once per position / connection / event; append-only; owner reads only their own rows", async () => {
  const db = await freshDb();
  const C = "33333333-3333-4333-8333-333333333333";
  const ins = (u: string, ev: string, pos = "4324c6b3") => db.query(`insert into public.broker_price_log (user_id, bot_id, position_id, connection_id, symbol, direction, event, bot_price, broker_price)
    values ($1, 'smc', $2, $3, 'USD/JPY', 'short', $4, 158.54711, 158.561)`, [u, pos, C, ev]);
  await db.exec(`set role service_role;`);
  await ins(U1, "open"); await ins(U1, "close_mirrored"); await ins(U2, "open", "other001");
  await assertRejects(() => ins(U1, "open"), Error, "duplicate key", "once per position / connection / event");
  await assertRejects(() => ins(U1, "closed_somehow", "p3"), Error, "violates check constraint");
  await assertRejects(() => db.query(`update public.broker_price_log set broker_price = 1`), Error, "permission denied", "no update grant");
  await assertRejects(() => db.query(`delete from public.broker_price_log`), Error, "permission denied", "no delete grant");
  await db.exec(`reset role;`); // even the table owner cannot rewrite it: the append-only trigger
  await assertRejects(() => db.query(`update public.broker_price_log set broker_price = 1`), Error, "append-only");
  await assertRejects(() => db.query(`delete from public.broker_price_log`), Error, "append-only");
  await db.exec(`set role authenticated; set request.jwt.claim.sub = '${U1}';`);
  assertEquals((await db.query(`select event from public.broker_price_log order by id`)).rows.map((r: { event: string }) => r.event), ["open", "close_mirrored"]);
  await assertRejects(() => ins(U1, "open", "p4"), Error, "permission denied");
  await db.exec(`reset role;`);
});

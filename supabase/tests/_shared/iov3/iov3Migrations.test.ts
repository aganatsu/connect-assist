/**
 * Impulse-on-V3 step 3 migrations against REAL PostgreSQL (PGlite, Postgres 16), applied on top of PR2:
 *   20261027120000_structure_bars_5m.sql — canonical 5m store (append-only, grid / settled / OHLC CHECKs, service-role only);
 *   20261028000000_iov3_shadow.sql       — the switch + shadow record (append-only except the switch row; owner read via RLS).
 */
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
// @ts-ignore: remote ESM build without type declarations (same import as structureBarsMigration.test.ts)
import { PGlite } from "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist/index.js";

const read = (f: string) => Deno.readTextFileSync(new URL(`../../../migrations/${f}`, import.meta.url));
const PR2 = read("20261015000000_structure_bars_1h.sql"), M5 = read("20261027120000_structure_bars_5m.sql"), SHADOW = read("20261028000000_iov3_shadow.sql");
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
    await db.exec(PR2); await db.exec(M5); await db.exec(SHADOW);
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

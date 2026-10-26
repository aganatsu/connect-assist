/**
 * V3.2c PR3 migration (20261027000000_structure_v3_state.sql) tested against REAL PostgreSQL (PGlite, Postgres 16), applied on
 * top of the PR2 migration whose append-only trigger function it reuses: append-only, CHECKs, grants, ON CONFLICT DO NOTHING.
 */
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
// @ts-ignore: remote ESM build without type declarations (same import as structureBarsMigration.test.ts)
import { PGlite } from "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist/index.js";

const PR2 = Deno.readTextFileSync(new URL("../../../migrations/20261015000000_structure_bars_1h.sql", import.meta.url));
const PR3 = Deno.readTextFileSync(new URL("../../../migrations/20261027000000_structure_v3_state.sql", import.meta.url));
const PGLITE_DIST = "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist";
let assets: Promise<{ wasmModule: WebAssembly.Module; fsBundle: Blob }> | null = null;
const pgliteAssets = () => assets ??= (async () => ({
  wasmModule: await WebAssembly.compile(await (await fetch(`${PGLITE_DIST}/postgres.wasm`)).arrayBuffer()),
  fsBundle: await (await fetch(`${PGLITE_DIST}/postgres.data`)).blob(),
}))();
// deno-lint-ignore no-explicit-any
async function freshDb(): Promise<any> {
  const a = await pgliteAssets();
  const g = globalThis as Record<string, unknown>;
  const desc = Object.getOwnPropertyDescriptor(g, "process"); // Emscripten must take the browser branch (see route2AtomicFill.test.ts)
  Object.defineProperty(g, "process", { value: undefined, configurable: true, writable: true });
  try {
    const db = new PGlite(a);
    await db.waitReady;
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;`);
    await db.exec(PR2);
    await db.exec(PR3);
    return db;
  } finally {
    if (desc) Object.defineProperty(g, "process", desc); else delete g.process;
  }
}
const snap = (p: Record<string, unknown> = {}) => ({
  symbol: "EUR/USD", tf: "1H", known_at: "2026-10-27 10:00:00+00", bar_time: "2026-10-27 09:00:00+00", engine_version: "v3.2c-frozen-20261013",
  trend: "bear", p_time: "2026-09-11 15:00:00+00", p_price: 1.16167, state_hash: "83c80b8a73e598e9", ...p,
});
// deno-lint-ignore no-explicit-any
const insertSnap = (db: any, r: Record<string, unknown>, conflict = "") =>
  db.query(`insert into public.structure_v3_snapshots (symbol, tf, known_at, bar_time, engine_version, trend, p_time, p_price, state_hash)
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9) ${conflict}`, [r.symbol, r.tf, r.known_at, r.bar_time, r.engine_version, r.trend, r.p_time, r.p_price, r.state_hash]);

Deno.test("PR3 migration: snapshots insert; duplicates are ignored on conflict; update / delete / truncate refused on all three tables", async () => {
  const db = await freshDb();
  await insertSnap(db, snap());
  await insertSnap(db, { ...snap(), state_hash: "different" }, "on conflict (symbol, tf, known_at, engine_version) do nothing");
  assertEquals((await db.query(`select state_hash from public.structure_v3_snapshots`)).rows, [{ state_hash: "83c80b8a73e598e9" }], "first wins");
  await db.query(`insert into public.structure_v3_checkpoints (symbol, known_at, engine_version, bars_1h, last_bar_time, d_state_hash)
                  values ('EUR/USD', '2026-10-27 21:00:00+00', 'v3.2c-frozen-20261013', 9440, '2026-10-27 20:00:00+00', 'abc')`);
  await db.query(`insert into public.structure_v3_audit (symbol, kind, tf, known_at, ref, detail) values ('EUR/USD', 'repaint', '1H', '2026-10-27 10:00:00+00', 'a>b', '{}')`);
  for (const t of ["structure_v3_snapshots", "structure_v3_checkpoints", "structure_v3_audit"]) {
    await assertRejects(() => db.query(`update public.${t} set symbol = symbol`), Error, "append-only");
    await assertRejects(() => db.query(`delete from public.${t}`), Error, "append-only");
    await assertRejects(() => db.query(`truncate public.${t}`), Error, "append-only");
  }
});

Deno.test("PR3 migration: CHECKs reject unknown symbol / tf / trend / pending kind / audit kind, pre-epoch bars and known_at ≤ bar_time", async () => {
  const db = await freshDb();
  for (const bad of [{ symbol: "BTC/USD" }, { tf: "15m" }, { trend: "up" }, { bar_time: "2025-04-16 20:00:00+00", known_at: "2025-04-16 21:00:00+00" }, { known_at: "2026-10-27 09:00:00+00" }]) {
    await assertRejects(() => insertSnap(db, snap(bad)), Error, "violates check constraint", JSON.stringify(bad));
  }
  await assertRejects(() => db.query(`insert into public.structure_v3_snapshots (symbol, tf, known_at, bar_time, engine_version, pending_kind, state_hash)
                                      values ('EUR/USD','1H','2026-10-27 10:00:00+00','2026-10-27 09:00:00+00','v','CHOCH','h')`), Error, "violates check constraint");
  await assertRejects(() => db.query(`insert into public.structure_v3_audit (symbol, kind, tf, known_at, ref, detail) values ('EUR/USD','oops','-','2026-10-27 10:00:00+00','x','{}')`), Error, "violates check constraint");
  await insertSnap(db, snap({ trend: null, p_time: null, p_price: null }));
});

Deno.test("PR3 migration: RLS forced; anon / authenticated get nothing; service_role gets select + insert only", async () => {
  const db = await freshDb();
  for (const t of ["structure_v3_snapshots", "structure_v3_checkpoints", "structure_v3_audit"]) {
    const rls = (await db.query(`select relrowsecurity, relforcerowsecurity from pg_class where relname = $1`, [t])).rows[0];
    assertEquals(rls, { relrowsecurity: true, relforcerowsecurity: true }, t);
    const g = (await db.query(`select grantee, privilege_type from information_schema.role_table_grants where table_name = $1 and grantee in ('anon','authenticated','service_role') order by 1, 2`, [t])).rows;
    assertEquals(g, [{ grantee: "service_role", privilege_type: "INSERT" }, { grantee: "service_role", privilege_type: "SELECT" }], t);
  }
});

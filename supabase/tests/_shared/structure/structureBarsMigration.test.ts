/**
 * V3.2c PR2 migration (20261015000000_structure_bars_1h.sql) tested against REAL PostgreSQL (PGlite, Postgres 16):
 * append-only triggers, span / settlement / OHLC / epoch CHECKs, RLS + grants, and ON CONFLICT DO NOTHING semantics.
 */
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
// @ts-ignore: remote ESM build without type declarations (same import as route2AtomicFill.test.ts)
import { PGlite } from "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist/index.js";

const MIGRATION = Deno.readTextFileSync(new URL("../../../migrations/20261015000000_structure_bars_1h.sql", import.meta.url));
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
    await db.exec(MIGRATION);
    return db;
  } finally {
    if (desc) Object.defineProperty(g, "process", desc); else delete g.process;
  }
}
const bar = (p: Record<string, string | number> = {}) => ({
  symbol: "EUR/USD", bar_time: "2026-11-04 09:00:00+00", open: 1.1, high: 1.1009, low: 1.0993, close: 1.1002,
  provider: null, source: "scanner_live", source_ref: null, observed_at: "2026-11-04 10:15:00+00", ...p,
});
// deno-lint-ignore no-explicit-any
const insert = (db: any, r: Record<string, unknown>, conflict = "") =>
  db.query(`insert into public.structure_bars_1h (symbol, bar_time, open, high, low, close, provider, source, source_ref, observed_at)
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ${conflict}`, [r.symbol, r.bar_time, r.open, r.high, r.low, r.close, r.provider, r.source, r.source_ref, r.observed_at]);

Deno.test("valid canonical rows insert; ON CONFLICT DO NOTHING keeps the first value", async () => {
  const db = await freshDb();
  await insert(db, bar());
  await insert(db, bar({ close: 1.1004 }), "on conflict (symbol, bar_time) do nothing");
  const r = await db.query(`select close::text as close, count(*) over () as n from public.structure_bars_1h`);
  assertEquals([r.rows[0].close, Number(r.rows[0].n)], ["1.1002", 1]);
  await db.close();
});

Deno.test("CHECKs: settlement (+15 min), on-the-hour, epoch, OHLC, symbol, source spans incl. the reserved window", async () => {
  const db = await freshDb();
  const bad: [string, Record<string, string | number>][] = [
    ["not settled (+14 min)", { observed_at: "2026-11-04 10:14:00+00" }],
    ["off the hour", { bar_time: "2026-11-04 09:30:00+00", observed_at: "2026-11-04 11:00:00+00" }],
    ["before epoch", { source: "research_import", bar_time: "2025-04-16 20:00:00+00", observed_at: "2026-10-14 00:00:00+00" }],
    ["high below close", { high: 1.1001 }],
    ["unknown symbol", { symbol: "XAU/USD" }],
    ["unknown source", { source: "manual" }],
    ["research_import inside the reserved window", { source: "research_import", bar_time: "2026-10-14 09:00:00+00", observed_at: "2026-10-15 00:00:00+00" }],
    ["research_import at the boundary", { source: "research_import", bar_time: "2026-10-09 21:00:00+00", observed_at: "2026-10-10 00:00:00+00" }],
    ["scanner_live inside the reserved window", { bar_time: "2026-10-20 09:00:00+00", observed_at: "2026-10-20 10:15:00+00" }],
    ["scanner_live in the import span", { bar_time: "2026-10-07 09:00:00+00", observed_at: "2026-10-07 10:15:00+00" }],
    ["smc_scan_bars_fill before the boundary", { source: "smc_scan_bars_fill", bar_time: "2026-10-08 09:00:00+00", observed_at: "2026-10-08 10:15:00+00" }],
  ];
  for (const [name, p] of bad) await assertRejects(() => insert(db, bar(p)), Error, undefined, name);
  await insert(db, bar({ source: "research_import", bar_time: "2026-10-09 20:00:00+00", observed_at: "2026-10-11 18:42:13+00" }));
  await insert(db, bar({ bar_time: "2026-10-25 22:00:00+00", observed_at: "2026-10-25 23:15:00+00" }));
  await db.close();
});

Deno.test("append-only: UPDATE, DELETE and TRUNCATE are refused on all three tables (even for the owner)", async () => {
  const db = await freshDb();
  await insert(db, bar());
  await db.query(`insert into public.structure_bar_revisions (symbol, bar_time, value_hash, open, high, low, close, source, observed_at, canonical_value_hash, max_abs_diff)
                  values ('EUR/USD','2026-11-04 09:00:00+00','h2',1.1,1.1009,1.0993,1.1004,'scanner_live','2026-11-04 12:00:00+00','h1',0.0002)`);
  await db.query(`insert into public.structure_bar_rejections (symbol, bar_time, reason, value_hash, source, observed_at)
                  values ('EUR/USD','2026-11-04 09:00:00+00','not_settled','h0','scanner_live','2026-11-04 10:05:00+00')`);
  for (const t of ["structure_bars_1h", "structure_bar_revisions", "structure_bar_rejections"]) {
    await assertRejects(() => db.query(`update public.${t} set source = source`), Error, "append-only", `${t} update`);
    await assertRejects(() => db.query(`delete from public.${t}`), Error, "append-only", `${t} delete`);
    await assertRejects(() => db.query(`truncate public.${t}`), Error, "append-only", `${t} truncate`);
  }
  await db.close();
});

Deno.test("RLS + grants: anon / authenticated have no access; service_role may only select and insert", async () => {
  const db = await freshDb();
  await insert(db, bar());
  // deno-lint-ignore no-explicit-any
  const priv = async (role: string, p: string) => (await db.query(`select has_table_privilege($1, 'public.structure_bars_1h', $2) as ok`, [role, p])).rows[0].ok as boolean;
  for (const role of ["anon", "authenticated"]) for (const p of ["select", "insert", "update", "delete"]) assertEquals(await priv(role, p), false, `${role} ${p}`);
  assertEquals([await priv("service_role", "select"), await priv("service_role", "insert"), await priv("service_role", "update"), await priv("service_role", "delete")], [true, true, false, false]);
  const rls = await db.query(`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'structure_bars_1h'`);
  assert(rls.rows[0].relrowsecurity && rls.rows[0].relforcerowsecurity);
  await db.exec(`set role service_role`);
  const r = await db.query(`select count(*)::int as n from public.structure_bars_1h`);
  assertEquals(r.rows[0].n, 1, "service_role (bypassrls, as in Supabase) reads");
  await db.exec(`reset role`);
  await db.close();
});

/**
 * STEP 17-C — builds the schema SQL for the two-session concurrency proof.
 *
 * It is the PGlite harness's own setup (supabase/tests/_shared/paperSettlementLedger.test.ts:
 * baseDb + applyMigrations — the same migration files, in the same order, which include the
 * Step 17-C migration) recorded as one SQL script. The harness code is extracted at run
 * time, so the bootstrap always matches the harness and the repo's migrations.
 * buildBootstrapSql() is also exercised in CI (step17cConcurrencyRunner.test.ts).
 *
 *   deno run --allow-read --allow-write supabase/tests/concurrency/step17c/build_bootstrap.ts /tmp/s17c_bootstrap.sql
 */
const HERE = new URL(".", import.meta.url);
const HARNESS = new URL("../../_shared/paperSettlementLedger.test.ts", HERE);
const MIGRATION_17C = new URL("../../../migrations/20261009010000_step17c_atomic_reset.sql", HERE);

export async function buildBootstrapSql(): Promise<string> {
  const s = Deno.readTextFileSync(HARNESS);
  const cut = (from: string, to: string) => {
    const a = s.indexOf(from), b = s.indexOf(to, a);
    if (a < 0 || b < 0) throw new Error(`harness layout changed: cannot find ${from} … ${to}`);
    return s.slice(a, b);
  };
  const consts = cut("const read = (rel: string)", "const USER = ");
  const users = cut("const USER = ", "function tableDdl(");
  const helpers = cut("function tableDdl(name: string)", "const PGLITE_DIST");
  const base = cut("async function baseDb(", "async function freshDb(");
  const harnessUrl = HARNESS.href;
  const mod = [
    consts.replace(/new URL\(rel, import\.meta\.url\)/g, `new URL(rel, ${JSON.stringify(harnessUrl)})`),
    users, helpers,
    base.replace(/async function baseDb\(opts: \{ preFix\?: boolean \} = \{\}\): Promise<PGlite> \{\s*const db = await newPglite\(\);/,
                 "async function baseDb(opts: { preFix?: boolean } = {}): Promise<any> {\n  const db = (globalThis as any).__S17C_DB;")
        .replace("async function applyMigrations(db: PGlite) {", "async function applyMigrations(db: any) {"),
    `export async function build() { const db = (globalThis as any).__S17C_DB; await baseDb({});
       await db.query("insert into public.paper_accounts (user_id, bot_id, balance, peak_balance, daily_pnl_base) values ($1, 'smc', $2, $2, $2)", [USER, 100000]);
       await applyMigrations(db); }`,
  ].join("\n").replace(/: PGlite/g, ": any");
  const out: string[] = [];
  (globalThis as any).__S17C_DB = {
    exec: async (sql: string) => { out.push(sql); },
    query: async (sql: string, params: unknown[] = []) => {
      out.push(sql.replace(/\$(\d+)/g, (_m: string, i: string) => `'${String(params[Number(i) - 1]).replace(/'/g, "''")}'`));
      return { rows: [] };
    },
  };
  const { build } = await import(`data:application/typescript;base64,${btoa(unescape(encodeURIComponent(mod)))}`);
  await build();
  const m17c = Deno.readTextFileSync(MIGRATION_17C);
  const n = out.filter((x) => x === m17c).length;
  if (n !== 1) throw new Error(`expected the harness to apply the Step 17-C migration exactly once, found ${n}`);
  return out.join(";\n\n") + ";\n";
}

if (import.meta.main) {
  const path = Deno.args[0];
  if (!path) { console.error("usage: build_bootstrap.ts <output.sql>"); Deno.exit(2); }
  const sql = await buildBootstrapSql();
  Deno.writeTextFileSync(path, sql);
  console.log(`wrote ${path} (${sql.length} bytes)`);
}

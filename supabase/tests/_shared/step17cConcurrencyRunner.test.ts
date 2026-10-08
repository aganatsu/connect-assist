/**
 * STEP 17-C — keeps the committed two-session runner (supabase/tests/concurrency/step17c/)
 * honest in CI: its schema builder still produces a loadable schema with every 17-C object,
 * the runner's own flows execute (sequentially — real concurrency needs a real server), and
 * its production-refusal guards and scenario coverage stay in place.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PGlite } from "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist/index.js";
import { buildBootstrapSql } from "../concurrency/step17c/build_bootstrap.ts";

const D = "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist";
// deno-lint-ignore no-explicit-any
async function newPglite(): Promise<any> {
  const a = { wasmModule: await WebAssembly.compile(await (await fetch(`${D}/postgres.wasm`)).arrayBuffer()), fsBundle: await (await fetch(`${D}/postgres.data`)).blob() };
  const g = globalThis as Record<string, unknown>; const desc = Object.getOwnPropertyDescriptor(g, "process");
  Object.defineProperty(g, "process", { value: undefined, configurable: true, writable: true });
  try { const db = new PGlite(a); await db.waitReady; return db; } finally { if (desc) Object.defineProperty(g, "process", desc); else delete g.process; }
}

const U = "22222222-2222-4222-8222-222222222222";
const pos = (pid: string) => `insert into public.paper_positions (user_id, bot_id, position_id, order_id, symbol, direction, size, entry_price, stop_loss, take_profit, current_price, open_time, signal_score)
  values ('${U}', 'smc', '${pid}', 'o${pid}', 'USD/JPY', 'long', 1.0, 154.9, 154.694849, 155.507852, 155.53582, '2026-10-08T12:00:00Z', '46') returning id, created_at`;
const order = (oid: string) => `insert into public.pending_orders (user_id, bot_id, order_id, symbol, direction, order_type, entry_price, current_price, stop_loss, take_profit, status, expires_at, dry_run)
  values ('${U}', 'smc', '${oid}', 'EUR/USD', 'long', 'limit', 1.1, 1.101, 1.098, 1.1022, 'pending', now() + interval '8 hours', false) returning id`;
const guarded = `select public.reset_paper_account_if_flat('${U}', 'smc', 100000, 'ci') r`;

Deno.test("runner schema: buildBootstrapSql() loads into Postgres with the 17-C triggers, guarded function, dropped default and ACLs", async () => {
  const sql = await buildBootstrapSql();
  const db = await newPglite();
  await db.exec(sql);
  const r = (await db.query(`select
    (select count(*)::int from pg_trigger where tgname in ('paper_positions_serialize_with_reset', 'pending_orders_serialize_with_reset')) triggers,
    to_regprocedure('public.reset_paper_account_if_flat(uuid,text,numeric,text)') is not null guarded,
    (select column_default from information_schema.columns where table_name = 'paper_positions' and column_name = 'created_at') created_default,
    has_function_privilege('authenticated', 'public.reset_paper_account(uuid,text,numeric,text)', 'execute') client_unguarded`)).rows[0];
  assertEquals([r.triggers, r.guarded, r.created_default, r.client_unguarded], [2, true, null, false]);
  await db.close();
});

Deno.test("runner flows execute (sequentially): writer-then-reset refuses; reset-then-writer lands in the new epoch and is credited", async () => {
  const db = await newPglite();
  await db.exec(await buildBootstrapSql());
  await db.exec(`insert into auth.users (id) values ('${U}'); insert into public.paper_accounts (user_id, bot_id, balance, peak_balance, daily_pnl_base) values ('${U}', 'smc', 104000, 104000, 104000)`);
  // A first: a position, then the reset refuses
  const p = (await db.query(pos("ci1"))).rows[0];
  let g = (await db.query(guarded)).rows[0].r;
  assertEquals([g.reset, g.code, g.exposure.openPositions], [false, "reset_refused_real_exposure", 1]);
  const s1 = (await db.query(`select public.settle_paper_position($1, '${U}', 'smc', '{"exit_price":155.507852,"pnl":871.19,"pnl_pips":60.8,"close_reason":"tp_hit"}'::jsonb, 'scanner_breach_check') r`, [p.id])).rows[0].r;
  assertEquals([s1.code, Number(s1.amount)], ["settled", 871.19]);
  // C1 first: a real order, then the reset refuses
  const o = (await db.query(order("ci1"))).rows[0];
  g = (await db.query(guarded)).rows[0].r;
  assertEquals([g.reset, g.exposure.activeRealOrders], [false, 1]);
  await db.query(`update public.pending_orders set status = 'cancelled', terminal_reason = 'CANCELLED_ZONE_EXIT' where id = $1`, [o.id]);
  // B: reset first, then a position — created_at after ledger_reset_at, credited
  g = (await db.query(guarded)).rows[0].r;
  assertEquals(g.reset, true);
  const p2 = (await db.query(pos("ci2"))).rows[0];
  const after = (await db.query(`select $1::timestamptz > ledger_reset_at ok from public.paper_accounts where user_id = '${U}'`, [p2.created_at])).rows[0].ok;
  assertEquals(after, true);
  const s2 = (await db.query(`select public.settle_paper_position($1, '${U}', 'smc', '{"exit_price":155.507852,"pnl":871.19,"pnl_pips":60.8,"close_reason":"tp_hit"}'::jsonb, 'scanner_breach_check') r`, [p2.id])).rows[0].r;
  assertEquals([s2.code, Number(s2.amount)], ["settled", 871.19]);
  await db.close();
});

const runner = Deno.readTextFileSync(new URL("../concurrency/step17c/two_session_test.py", import.meta.url));

Deno.test("runner safety: refuses without an explicit disposable URI, refuses Supabase hosts / the production ref, refuses a non-empty database", () => {
  assert(runner.includes('REFUSED: set PG_URI to a disposable, empty PostgreSQL database'));
  assert(runner.includes('if os.environ.get("S17C_DISPOSABLE_DB") != "yes":'));
  assert(/PRODUCTION_MARKERS = \("supabase\.co", "supabase\.com", "supabase\.net", "rvouzhacxqlbetwcttoe"\)/.test(runner));
  assert(runner.includes("REFUSED: the target database already has tables in schema public"));
  assert(runner.indexOf("REFUSED: PG_URI points at a Supabase host") < runner.indexOf("M = conn()"), "the host check runs before any connection");
  assert(!/eyJ[A-Za-z0-9_-]{10,}|sbp_[A-Za-z0-9]{10,}|service_role_key/i.test(runner), "no credentials in the runner");
});

Deno.test("runner coverage: A, B, C1, C2, controls, stress and E are all present", () => {
  for (const s of ['writer_first("position", "A-fill-first")', 'reset_first("position", "B-reset-first")', 'writer_first("order", "C1-order-first")',
                   'reset_first("order", "C2-reset-first")', "=== CONTROLS", "=== D: STRESS", "=== E: dry-run orders, system-reset, client access",
                   "a client cannot call the unguarded reset_paper_account", "a client cannot reset ANOTHER user's account",
                   "a client cannot bypass the exposure check", "system-reset path: service_role still calls reset_paper_account",
                   "dry-run orders alone do not block the reset", "no escaped real order", "pg_blocking_pids"]) {
    assert(runner.includes(s), s);
  }
});

Deno.test("runner fixture: Scenario E unlocks the account before its real exposure position (the step 8 entries-lock guard refuses it otherwise)", () => {
  const lock = runner.indexOf('M.execute("update public.paper_accounts set entries_locked = true where user_id = %s", (u,))');
  const unlock = runner.indexOf('M.execute("update public.paper_accounts set entries_locked = false where user_id = %s", (u,))');
  const fixture = runner.indexOf("'cli', 'ocli'");
  assert(lock > 0 && unlock > lock && fixture > unlock, "lock (dry-run case) → unlock → real exposure position, in that order");
  // no other real position / order insert happens between the lock and the unlock
  const between = runner.slice(lock, unlock);
  assert(!/insert into public\.paper_positions/.test(between), "no real position inserted while locked");
  assert(!/order_sql\(u, "[^"]+"\)(?!, dry=True)/.test(between.replace(/order_sql\(u, "dry17c", dry=True\)/, "")), "only the dry-run order is placed while locked");
});

Deno.test("runner fixture, replayed in Postgres: locked → the guard refuses the real position (the first-run failure); unlocked → it inserts and the guarded reset refuses on exposure", async () => {
  const db = await newPglite();
  await db.exec(await buildBootstrapSql());
  await db.exec(`insert into auth.users (id) values ('${U}'); insert into public.paper_accounts (user_id, bot_id, balance, peak_balance, daily_pnl_base) values ('${U}', 'smc', 97000, 97000, 97000);
    update public.paper_accounts set entries_locked = true where user_id = '${U}';`);
  await db.query(order("dryE").replace("false) returning", "true) returning"));
  const g = (await db.query(guarded)).rows[0].r;
  assertEquals([g.reset, g.exposure.activeDryRunOrders], [true, 1], "dry-run only → reset proceeds");
  let refused = "";
  try { await db.query(pos("cliLocked")); } catch (e) { refused = String((e as Error).message); }
  assert(refused.includes("entries locked"), `the step 8 guard refuses a real position on a locked account: ${refused}`);
  await db.exec(`update public.paper_accounts set entries_locked = false where user_id = '${U}'`);
  await db.query(pos("cli"));
  const g2 = (await db.query(guarded)).rows[0].r;
  assertEquals([g2.reset, g2.code, g2.exposure.openPositions], [false, "reset_refused_real_exposure", 1]);
  await db.close();
});

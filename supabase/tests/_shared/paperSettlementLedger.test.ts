/**
 * PAPER SETTLEMENT LEDGER — tested against REAL PostgreSQL (PGlite, Postgres 16).
 *
 * The functions under test are the migration files themselves
 * (20261006000000 timestamps, 20261006010000 ledger), applied to the
 * production table definitions: baseline DDL + every later migration that
 * touches these tables.
 *
 * The failure being made impossible, from the 2026-10-05 snapshot:
 *   USD/JPY long 0e76555c, tp_hit at 155.507852, pnl 871.19.
 *   close_audit_log 708319c2  2026-09-16 18:20:02.533  cycle a3401907
 *   close_audit_log 9590f88a  2026-09-16 18:20:03.280  cycle 7ca700e6
 *   Both cycles credited 871.19. Both history inserts failed (the decision-
 *   contract trigger RAISEd on a frozen-decision.v1 blob). History row
 *   d582c8b5 was backfilled from close_audit_log at 19:10:57 with
 *   closed_at in Postgres text format and no entry_price or size.
 *
 * On concurrency: PGlite is one connection, so two settlements serialise
 * here. In production both RPCs take `SELECT ... FOR UPDATE` on the account
 * row first, so they serialise there too; the second caller sees the state
 * the first committed. The ordered calls below are that second-caller view.
 */

import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PGlite } from "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist/index.js";
import {
  describeSettlementMiss,
  interpretSettlement,
  type RpcClient,
  settlePaperPartial,
  settlePaperPosition,
} from "../../functions/_shared/paperSettlement.ts";
import { buildAttribution } from "../../functions/_shared/attribution.ts";
import { ACTIVE_ORDER_STATUSES, exposureFromRows, resetRefusal } from "../../functions/_shared/accountResetGuard.ts";

const read = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url));
const BASELINE = read("../../migrations/20260914000000_baseline_schema.sql");
const FREEZE_FIX = read("../../migrations/20260916010000_history_insert_ignores_foreign_contract.sql");
const TELEMETRY = read("../../migrations/20260928140000_smc_trade_telemetry_parity.sql");
const MIGRATION_TIMESTAMPS = read("../../migrations/20261006000000_trade_history_timestamps.sql");
const MIGRATION_LEDGER = read("../../migrations/20261006010000_paper_settlement_ledger.sql");
const MIGRATION_MONITOR = read("../../migrations/20261006020000_settlement_monitor_runs.sql");
const MIGRATION_RESET = read("../../migrations/20261006030000_system_reset_workflow.sql");
const MIGRATION_LOCK = read("../../migrations/20261006040000_post_reset_entries_lock.sql");
const MIGRATION_ROLE_FIX = read("../../migrations/20261006060000_fix_jwt_role_detection.sql");
const MIGRATION_SNAPSHOT_FN = read("../../migrations/20261006070000_reset_snapshot_function.sql");
const MIGRATION_DRY_RUN = read("../../migrations/20261007000000_step8_dry_run_orders.sql");
const MIGRATION_STEP15 = read("../../migrations/20261008000000_step15_attribution_schema.sql");
const MIGRATION_STEP15_PR2 = read("../../migrations/20261008010000_step15_pr2_attribution_lifecycle.sql");
const MIGRATION_STEP15_PR3 = read("../../migrations/20261008020000_step15_pr3_outcome_resolver.sql");
// Route 2 columns the PR 2 lifecycle trigger reads (zone_touch_time,
// confirmation_*, terminal_reason, …) and route2_claim_and_fill. Applied in
// date order, as in production.
const ROUTE2_MIGRATIONS = [
  "../../migrations/20260929120000_route2_forward_validation.sql",
  "../../migrations/20260930020000_route2_lifecycle_v2.sql",
  "../../migrations/20260930140000_route2_atomic_fill.sql",
].map(read);
const SCAN_DECISION = read("../../migrations/20260925210000_smc_scan_decision_observability.sql");

const USER = "57c79dee-db6b-4fae-b34a-4b64ce33ca34";
const OTHER_USER = "11111111-1111-4111-8111-111111111111";

function tableDdl(name: string): string {
  const start = BASELINE.indexOf(`CREATE TABLE IF NOT EXISTS public.${name} (`);
  if (start < 0) throw new Error(`baseline has no CREATE TABLE for ${name}`);
  return BASELINE.slice(start, BASELINE.indexOf("\n);", start) + 3);
}
function functionDdl(name: string): string {
  const start = BASELINE.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) throw new Error(`baseline has no function ${name}`);
  const end = BASELINE.indexOf("$function$", BASELINE.indexOf("AS $function$", start) + 13);
  return BASELINE.slice(start, end + "$function$".length) + ";";
}
const line = (re: RegExp) => {
  const m = BASELINE.match(re);
  if (!m) throw new Error(`baseline has no line matching ${re}`);
  return m[0];
};

const PGLITE_DIST = "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist";
let assets: Promise<{ wasmModule: WebAssembly.Module; fsBundle: Blob }> | null = null;
const pgliteAssets = () => assets ??= (async () => ({
  wasmModule: await WebAssembly.compile(await (await fetch(`${PGLITE_DIST}/postgres.wasm`)).arrayBuffer()),
  fsBundle: await (await fetch(`${PGLITE_DIST}/postgres.data`)).blob(),
}))();

/** See route2AtomicFill.test.ts: hide Deno's `process` while PGlite boots. */
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

/**
 * Production tables as they stand before these migrations.
 * `preFix: true` installs the decision-contract trigger as it was on
 * 2026-09-16 — the version that RAISEd and lost the USD/JPY history row.
 */
async function baseDb(opts: { preFix?: boolean } = {}): Promise<PGlite> {
  const db = await newPglite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    -- Supabase's own definitions read the PostgREST request claims.
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    -- Supabase's real auth.role(): the legacy GUC OR request.jwt.claims->>'role'.
    -- Current PostgREST sets ONLY request.jwt.claims; a stub that read only the
    -- legacy GUC hid the 2026-10-06 entries-lock guard bug.
    create function auth.role() returns text language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                         (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')) $$;
    grant usage on schema auth to anon, authenticated, service_role;
    ${tableDdl("paper_accounts")}
    ${tableDdl("paper_positions")}
    ${tableDdl("pending_orders")}
    ${tableDdl("paper_trade_history")}
    ${line(/ALTER TABLE public\.paper_accounts ADD CONSTRAINT paper_accounts_pkey[^\n]*/)}
    ${line(/ALTER TABLE public\.paper_accounts ADD CONSTRAINT paper_accounts_user_id_key[^\n]*/)}
    alter table public.paper_positions add constraint paper_positions_pkey primary key (id);
    alter table public.pending_orders add constraint pending_orders_pkey primary key (id);
    ${line(/ALTER TABLE public\.paper_trade_history ADD CONSTRAINT paper_trade_history_pkey[^\n]*/)}
    ${line(/CREATE UNIQUE INDEX idx_paper_trade_history_final_lifecycle[^\n]*/)}
    ${line(/CREATE UNIQUE INDEX idx_paper_trade_history_source_position[^\n]*/)}
    ${functionDdl("update_updated_at_column")}
    ${line(/CREATE TRIGGER update_paper_accounts_updated_at[^\n]*/)}
    ${functionDdl("freeze_streamlined_decision_origin")}
    ${line(/CREATE TRIGGER trg_freeze_streamlined_decision BEFORE INSERT OR UPDATE ON public\.paper_trade_history[^\n]*/)}
    grant select, insert, update, delete on public.paper_accounts, public.paper_positions, public.paper_trade_history
      to anon, authenticated, service_role;
  `);
  if (!opts.preFix) await db.exec(FREEZE_FIX);
  await db.exec(TELEMETRY);
  for (const m of ROUTE2_MIGRATIONS) await db.exec(m);
  // Production's one-live-order-per-symbol+direction rule (verbatim), which the
  // duplicate path of route2_place_order depends on.
  await db.exec(line(/CREATE UNIQUE INDEX idx_pending_orders_unique_active[^\n]*/));
  return db;
}

async function applyMigrations(db: PGlite) {
  await db.exec(MIGRATION_TIMESTAMPS);
  await db.exec(MIGRATION_LEDGER);
  await db.exec(MIGRATION_MONITOR);
  await db.exec(MIGRATION_RESET);
  await db.exec(MIGRATION_LOCK);
  await db.exec(MIGRATION_ROLE_FIX);
  await db.exec(`${tableDdl("bot_configs")} ${tableDdl("bot_config_change_log")}`);
  await db.exec(MIGRATION_SNAPSHOT_FN);
  await db.exec(MIGRATION_DRY_RUN);
  // Step 15 PR 1. Every settlement test in this file therefore runs against
  // the attribution-aware settlement functions — the legacy (signal_id NULL)
  // path is exactly what those tests exercise.
  await db.exec(`create table if not exists auth.users (id uuid primary key)`); // smc_scan_decision FK target
  await db.query(`insert into auth.users (id) values ($1), ($2) on conflict do nothing`, [USER, OTHER_USER]);
  const sd = SCAN_DECISION.search(/create table if not exists public\.smc_scan_decision \(/i);
  await db.exec(SCAN_DECISION.slice(sd, SCAN_DECISION.indexOf("\n);", sd) + 3));
  await db.exec(MIGRATION_STEP15);
  await db.exec(MIGRATION_STEP15_PR2);
  await db.exec(MIGRATION_STEP15_PR3);
}

async function freshDb(opts: { preFix?: boolean; balance?: number } = {}): Promise<PGlite> {
  const db = await baseDb(opts);
  await db.query(
    `insert into public.paper_accounts (user_id, bot_id, balance, peak_balance, daily_pnl_base) values ($1, 'smc', $2, $2, $2)`,
    [USER, opts.balance ?? 100000],
  );
  await applyMigrations(db);
  return db;
}

/** Open a position; returns its row id. */
async function openPosition(db: PGlite, over: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = {
    user_id: USER, bot_id: "smc", position_id: "0e76555c", order_id: "ord0e765",
    symbol: "USD/JPY", direction: "long", size: 1.0, entry_price: 154.9,
    stop_loss: 154.694849, take_profit: 155.507852, current_price: 155.53582,
    open_time: "2026-09-16T07:40:09.912Z", signal_score: "46", ...over,
  };
  const cols = Object.keys(row);
  const r = await db.query<{ id: string }>(
    `insert into public.paper_positions (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`,
    cols.map((c) => row[c]),
  );
  return r.rows[0].id;
}

/** The close exactly as bot-scanner's breach check computed it on 2026-09-16. */
const usdJpyClose = (over: Record<string, unknown> = {}) => ({
  exit_price: 155.507852, pnl: 871.19, pnl_pips: 60.8, close_reason: "tp_hit", ...over,
});

const rpcClient = (db: PGlite): RpcClient => ({
  async rpc(fn, a) {
    try {
      const r = fn === "settle_paper_position"
        ? await db.query<{ r: unknown }>(
          `select public.settle_paper_position($1::uuid, $2::uuid, $3, $4::jsonb, $5) as r`,
          [a.p_position_row_id, a.p_user_id, a.p_bot_id, JSON.stringify(a.p_history), a.p_source],
        )
        : await db.query<{ r: unknown }>(
          `select public.settle_paper_partial($1::uuid, $2::uuid, $3, $4::numeric, $5, $6::jsonb, $7) as r`,
          [a.p_position_row_id, a.p_user_id, a.p_bot_id, a.p_remaining_size, a.p_position_signal_reason, JSON.stringify(a.p_history), a.p_source],
        );
      return { data: r.rows[0].r, error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message } };
    }
  },
});

const settle = (db: PGlite, rowId: string, history: Record<string, unknown>, source = "scanner_breach_check") =>
  settlePaperPosition(rpcClient(db), { positionRowId: rowId, userId: USER, botId: "smc", history, source });

const balance = async (db: PGlite) =>
  Number((await db.query<{ b: string }>(`select balance::text as b from public.paper_accounts where user_id = $1`, [USER])).rows[0].b);
const peak = async (db: PGlite) =>
  Number((await db.query<{ b: string }>(`select peak_balance::text as b from public.paper_accounts where user_id = $1`, [USER])).rows[0].b);
const count = async (db: PGlite, sql: string, params: unknown[] = []) =>
  Number((await db.query<{ n: number }>(`select count(*)::int as n from ${sql}`, params)).rows[0].n);
const recon = async (db: PGlite) =>
  (await db.query<Record<string, unknown>>(`select * from public.paper_account_reconciliation where user_id = $1`, [USER])).rows[0];
const setGuard = (db: PGlite, mode: "observe" | "enforce") =>
  db.query(`update public.paper_ledger_guard set mode = $1 where id = 1`, [mode]);

// ─── The exact USD/JPY failure ──────────────────────────────────────────────

Deno.test("USD/JPY 0e76555c: two scan cycles settle the same close — credited exactly once", async () => {
  const db = await freshDb();
  const rowId = await openPosition(db);

  const first = await settle(db, rowId, usdJpyClose({ closed_at: "2026-09-16T18:20:02.533Z" }));
  const second = await settle(db, rowId, usdJpyClose({ closed_at: "2026-09-16T18:20:03.280Z" }));

  assertEquals(first.outcome, "settled");
  assertEquals(second.outcome, "already_settled", "the 0.7s-later cycle must not credit");
  assertEquals(await balance(db), 100871.19, "871.19 once — not 1742.38");
  assertEquals(await count(db, "public.paper_trade_history where position_id = '0e76555c'"), 1);
  assertEquals(await count(db, "public.paper_account_ledger where kind = 'close'"), 1);
  assertEquals(await count(db, "public.paper_positions"), 0);
  assertEquals(Number((await recon(db)).drift), 0);
  await db.close();
});

Deno.test("USD/JPY replay with the 09-16 trigger: history insert refused, trade still recorded, no double credit, backfill moves nothing", async () => {
  const db = await freshDb({ preFix: true });
  const rowId = await openPosition(db);
  // The blob that made the pre-fix trigger RAISE.
  const frozen = { contractVersion: "frozen-decision.v1", decisionHash: "x" };

  const first = await settle(db, rowId, usdJpyClose({ streamlined_decision_origin: frozen }));
  assertEquals(first.outcome, "settled");
  if (first.outcome !== "settled") throw new Error("unreachable");
  assert(first.historyFallbackError?.includes("invalid streamlined decision origin"),
    `the refusal is recorded, got ${first.historyFallbackError}`);
  const hist = (await db.query<{ pnl: string; origin: unknown }>(
    `select pnl::text, streamlined_decision_origin as origin from public.paper_trade_history where position_id = '0e76555c'`,
  )).rows;
  assertEquals(hist.length, 1, "the trade is in history despite the trigger");
  assertEquals(Number(hist[0].pnl), 871.19);
  assertEquals(hist[0].origin, null);

  const second = await settle(db, rowId, usdJpyClose({ streamlined_decision_origin: frozen }));
  assertEquals(second.outcome, "already_settled");

  // 19:10:57 — the backfill from close_audit_log 708319c2.
  const bf = (await db.query<{ r: Record<string, unknown> }>(
    `select public.backfill_paper_trade_history($1::uuid, 'smc', $2::jsonb, 'close_audit_log 708319c2') as r`,
    [USER, JSON.stringify({
      position_id: "0e76555c", symbol: "USD/JPY", direction: "long", order_id: "",
      open_time: "2026-09-16 07:40:09.912038+00", closed_at: "2026-09-16 18:20:02.533382+00",
      close_reason: "tp_hit", exit_price: 155.507852, pnl: 871.19, signal_score: "46",
    })],
  )).rows[0].r;
  assertEquals(bf.code, "exists");
  assertEquals(await balance(db), 100871.19);
  assertEquals(await count(db, "public.paper_account_ledger where kind = 'close'"), 1);
  await db.close();
});

Deno.test("a history insert that fails outright rolls the whole settlement back: position kept, balance unchanged", async () => {
  const db = await freshDb();
  const rowId = await openPosition(db);
  await db.exec(`
    create function public.test_refuse_history() returns trigger language plpgsql as
      $$ begin raise exception 'history storage unavailable'; end $$;
    create trigger zz_test_refuse before insert on public.paper_trade_history
      for each row execute function public.test_refuse_history();
  `);

  const r = await settle(db, rowId, usdJpyClose());
  assertEquals(r.outcome, "failed");
  assertEquals(await balance(db), 100000, "no money without a history row");
  assertEquals(await count(db, "public.paper_positions where id = $1", [rowId]), 1, "position stays open for retry");
  assertEquals(await count(db, "public.paper_account_ledger where kind = 'close'"), 0);

  await db.exec(`drop trigger zz_test_refuse on public.paper_trade_history`);
  const retry = await settle(db, rowId, usdJpyClose());
  assertEquals(retry.outcome, "settled");
  assertEquals(await balance(db), 100871.19);
  await db.close();
});

Deno.test("a second open row with the same lifecycle identity is removed without moving money", async () => {
  const db = await freshDb();
  const a = await openPosition(db);
  const b = await openPosition(db); // same position_id, different row
  assertEquals((await settle(db, a, usdJpyClose())).outcome, "settled");
  const r = await settle(db, b, usdJpyClose());
  assertEquals(r.outcome, "already_settled");
  assertEquals(await count(db, "public.paper_positions"), 0, "the leftover row is cleaned up");
  assertEquals(await balance(db), 100871.19);
  await db.close();
});

// ─── Backfill ───────────────────────────────────────────────────────────────

Deno.test("backfill BEFORE settlement writes history only; the settlement links it and credits once", async () => {
  const db = await freshDb();
  const rowId = await openPosition(db);
  // Shaped like d582c8b5: no entry_price, size or pnl_pips.
  const bf = (await db.query<{ r: Record<string, unknown> }>(
    `select public.backfill_paper_trade_history($1::uuid, 'smc', $2::jsonb, 'test') as r`,
    [USER, JSON.stringify({
      position_id: "0e76555c", symbol: "USD/JPY", direction: "long", order_id: "",
      open_time: "2026-09-16 07:40:09.912038+00", closed_at: "2026-09-16 18:20:02.533382+00",
      close_reason: "tp_hit", exit_price: 155.507852, pnl: 871.19,
    })],
  )).rows[0].r;
  assertEquals(bf.code, "inserted");
  assertEquals(bf.already_settled, false);
  assertEquals(await balance(db), 100000, "a backfill never credits");
  assertEquals(await count(db, "public.paper_account_ledger where kind <> 'opening'"), 0);

  const r = await settle(db, rowId, usdJpyClose());
  assertEquals(r.outcome, "settled");
  if (r.outcome !== "settled") throw new Error("unreachable");
  assertEquals(r.linkedExistingHistory, true);
  assertEquals(await count(db, "public.paper_trade_history where position_id = '0e76555c'"), 1, "linked, not duplicated");
  const h = (await db.query<{ entry_price: string; size: string; src: string }>(
    `select entry_price::text, size::text, source_position_row_id::text as src from public.paper_trade_history where position_id = '0e76555c'`,
  )).rows[0];
  assertEquals(Number(h.entry_price), 154.9, "gaps in the backfilled row are filled from the position");
  assertEquals(Number(h.size), 1);
  assertEquals(h.src, rowId);
  assertEquals(await balance(db), 100871.19);
  await db.close();
});

Deno.test("backfill AFTER settlement is refused as a duplicate and moves nothing", async () => {
  const db = await freshDb();
  const rowId = await openPosition(db);
  await settle(db, rowId, usdJpyClose());
  const bf = (await db.query<{ r: Record<string, unknown> }>(
    `select public.backfill_paper_trade_history($1::uuid, 'smc', $2::jsonb, 'test') as r`,
    [USER, JSON.stringify({ position_id: "0e76555c", symbol: "USD/JPY", direction: "long", order_id: "",
      open_time: "2026-09-16T07:40:09Z", closed_at: "2026-09-16T18:20:02Z", close_reason: "tp_hit", pnl: 871.19 })],
  )).rows[0].r;
  assertEquals(bf.code, "exists");
  assertEquals(await balance(db), 100871.19);
  await db.close();
});

Deno.test("backfill is service-role only", async () => {
  const db = await freshDb();
  const can = async (role: string) =>
    (await db.query<{ ok: boolean }>(
      `select has_function_privilege($1, 'public.backfill_paper_trade_history(uuid, text, jsonb, text)', 'execute') as ok`, [role],
    )).rows[0].ok;
  assertEquals(await can("service_role"), true);
  assertEquals(await can("authenticated"), false);
  assertEquals(await can("anon"), false);
  await db.close();
});

// ─── Partial TP ─────────────────────────────────────────────────────────────

Deno.test("partial TP books once; a re-fire books nothing; the final close books the rest", async () => {
  const db = await freshDb();
  const rowId = await openPosition(db, { position_id: "39c5161f", symbol: "EUR/USD", entry_price: 1.1, size: 1.0 });
  const partial = (pnl: number) =>
    settlePaperPartial(rpcClient(db), {
      positionRowId: rowId, userId: USER, botId: "smc", remainingSize: 0.5, positionSignalReason: '{"exitFlags":{"partialTPActivated":true}}',
      history: { exit_price: 1.102, pnl, size: 0.5, pnl_pips: 20 }, source: "paper_trading_partial_tp",
    });

  assertEquals((await partial(100)).outcome, "settled");
  // 39c5161f fired 16 times in 29 minutes on 2026-08-07.
  for (let i = 0; i < 15; i++) assertEquals((await partial(100)).outcome, "already_settled");
  assertEquals(await balance(db), 100100);
  const pos = (await db.query<{ size: string; fired: boolean }>(
    `select size::text, partial_tp_fired as fired from public.paper_positions where id = $1`, [rowId])).rows[0];
  assertEquals(Number(pos.size), 0.5);
  assertEquals(pos.fired, true);

  const fin = await settle(db, rowId, { exit_price: 1.1, pnl: 0, size: 0.5, close_reason: "be_hit" }, "paper_trading_auto");
  assertEquals(fin.outcome, "settled");
  assertEquals(await balance(db), 100100);
  assertEquals(await count(db, "public.paper_trade_history where position_id like '39c5161f%'"), 2);
  assertEquals(await count(db, "public.paper_trade_history where close_reason = 'partial_tp'"), 1);
  assertEquals(Number((await recon(db)).drift), 0);
  assertEquals(Number((await recon(db)).history_rows_without_settlement_this_epoch), 0);
  await db.close();
});

// ─── Balance guard ──────────────────────────────────────────────────────────

Deno.test("observe mode: a direct balance write is allowed but recorded, and shows as drift", async () => {
  const db = await freshDb();
  await db.query(`update public.paper_accounts set balance = balance + 871.19 where user_id = $1`, [USER]);
  assertEquals(await balance(db), 100871.19);
  assertEquals(await count(db, "public.paper_balance_unledgered_writes"), 1);
  const r = await recon(db);
  assertEquals(Number(r.drift), 871.19);
  assertEquals(Number(r.unledgered_writes_this_epoch), 1);
  await db.close();
});

Deno.test("enforce mode: a direct balance write is refused — from the API role and from service code alike", async () => {
  const db = await freshDb();
  await setGuard(db, "enforce");
  await assertRejects(
    () => db.query(`update public.paper_accounts set balance = balance + 871.19 where user_id = $1`, [USER]),
    Error, "settlement ledger",
  );
  await assertRejects(
    () => db.query(`update public.paper_accounts set peak_balance = 999999 where user_id = $1`, [USER]),
    Error, "settlement ledger",
  );
  await db.exec(`set session authorization authenticated`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)`, [USER]);
  await assertRejects(
    () => db.query(`update public.paper_accounts set balance = 1e9 where user_id = $1`, [USER]),
    Error, "settlement ledger",
  );
  await db.exec(`set session authorization postgres`);
  // Non-money columns stay writable.
  await db.query(`update public.paper_accounts set scan_count = scan_count + 1, is_paused = true where user_id = $1`, [USER]);
  assertEquals(await balance(db), 100000);
  // And settlement still works under enforcement.
  const rowId = await openPosition(db);
  assertEquals((await settle(db, rowId, usdJpyClose())).outcome, "settled");
  assertEquals(await balance(db), 100871.19);
  await db.close();
});

Deno.test("the ledger is append-only", async () => {
  const db = await freshDb();
  await assertRejects(() => db.query(`update public.paper_account_ledger set amount = 0`), Error, "append-only");
  await assertRejects(() => db.query(`delete from public.paper_account_ledger`), Error, "append-only");
  // Refused either by the append-only trigger or, since step 15, earlier by
  // Postgres because trade_attribution.ledger_id references the ledger.
  const err = await assertRejects(() => db.query(`truncate public.paper_account_ledger`)) as Error;
  assert(/append-only|referenced in a foreign key/.test(err.message), err.message);
  await db.close();
});

// ─── Reset and epochs ───────────────────────────────────────────────────────

Deno.test("after a reset, a position opened before it cannot move the new balance", async () => {
  const db = await freshDb({ balance: 104979.62 });
  const old = await openPosition(db, { position_id: "chfjpy01", symbol: "CHF/JPY", created_at: "2026-10-04T10:00:00Z" });

  const reset = (await db.query<{ r: Record<string, unknown> }>(
    `select public.reset_paper_account($1::uuid, 'smc', 100000, 'clean start after 2026-10-05 snapshot') as r`, [USER],
  )).rows[0].r;
  assertEquals(reset.code, "reset");
  assertEquals(Number(reset.previous_balance), 104979.62);
  assertEquals(await balance(db), 100000);
  assertEquals(await peak(db), 100000);

  const r = await settle(db, old, { exit_price: 180.0, pnl: -558.4, close_reason: "sl_hit" });
  assertEquals(r.outcome, "settled");
  if (r.outcome !== "settled") throw new Error("unreachable");
  assertEquals(r.preEpoch, true);
  assertEquals(r.amount, 0);
  assertEquals(await balance(db), 100000, "the old trade is recorded but not credited");
  assertEquals(await count(db, "public.paper_trade_history where position_id = 'chfjpy01'"), 1, "the evidence is kept");

  const fresh = await openPosition(db, { position_id: "new00001", symbol: "EUR/USD", entry_price: 1.1 });
  assertEquals((await settle(db, fresh, { exit_price: 1.101, pnl: 100, close_reason: "tp_hit" })).outcome, "settled");
  assertEquals(await balance(db), 100100);

  const rc = await recon(db);
  assertEquals(Number(rc.drift), 0);
  assertEquals(Number(rc.realized_pnl_this_epoch), 100);
  assertEquals(Number(rc.pre_epoch_settlements_this_epoch), 1);
  await db.close();
});

Deno.test("a position open when the ledger is introduced still settles normally", async () => {
  const db = await baseDb();
  await db.query(`insert into public.paper_accounts (user_id, bot_id, balance, peak_balance, daily_pnl_base) values ($1,'smc',104979.62,105500,104979.62)`, [USER]);
  const rowId = await openPosition(db, { created_at: "2026-10-05T11:04:02Z" });
  await applyMigrations(db);
  const r = await settle(db, rowId, usdJpyClose());
  assertEquals(r.outcome, "settled");
  if (r.outcome !== "settled") throw new Error("unreachable");
  assertEquals(r.preEpoch, false);
  assertEquals(await balance(db), 104979.62 + 871.19);
  const opening = (await db.query<{ amount: string }>(`select amount::text from public.paper_account_ledger where kind = 'opening'`)).rows;
  assertEquals(opening.length, 1);
  assertEquals(Number(opening[0].amount), 104979.62, "opening entry records the balance as found");
  await db.close();
});

Deno.test("a new account opens its own epoch with an opening entry", async () => {
  const db = await freshDb();
  await db.query(`insert into public.paper_accounts (user_id, bot_id, balance, peak_balance, daily_pnl_base) values ($1,'smc',10000,10000,10000)`, [OTHER_USER]);
  const rows = (await db.query<{ kind: string; amount: string }>(
    `select kind, amount::text from public.paper_account_ledger where user_id = $1`, [OTHER_USER])).rows;
  assertEquals(rows.map((r) => [r.kind, Number(r.amount)]), [["opening", 10000]]);
  await db.close();
});

// ─── Authorisation ──────────────────────────────────────────────────────────

Deno.test("a signed-in user cannot settle or reset another user's account", async () => {
  const db = await freshDb();
  const rowId = await openPosition(db);
  await db.exec(`set session authorization authenticated`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)`, [OTHER_USER]);
  const r = await settle(db, rowId, usdJpyClose());
  assertEquals(r.outcome, "rejected");
  const reset = (await db.query<{ r: Record<string, unknown> }>(
    `select public.reset_paper_account($1::uuid, 'smc', 1e9, 'x') as r`, [USER])).rows[0].r;
  assertEquals(reset.code, "forbidden");
  // The owner can.
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [USER]);
  assertEquals((await settle(db, rowId, usdJpyClose())).outcome, "settled");
  await db.exec(`set session authorization postgres`);
  assertEquals(await balance(db), 100871.19);
  await db.close();
});

Deno.test("invalid closes are refused without side effects", async () => {
  const db = await freshDb();
  const rowId = await openPosition(db);
  for (const bad of [{ pnl: 871.19, close_reason: "tp_hit" }, { exit_price: 155.5, close_reason: "tp_hit" },
    { exit_price: 155.5, pnl: 1, close_reason: "" }, { exit_price: 155.5, pnl: 1, close_reason: "partial_tp" }]) {
    const r = await settle(db, rowId, bad);
    assertEquals(r.outcome, "rejected", JSON.stringify(bad));
  }
  assertEquals(await count(db, "public.paper_positions"), 1);
  assertEquals(await balance(db), 100000);
  await db.close();
});

Deno.test("finalize_paper_position_close (legacy RPC) now settles through the ledger", async () => {
  const db = await freshDb();
  const rowId = await openPosition(db);
  const call = async () => (await db.query<{ r: Record<string, unknown> }>(
    `select public.finalize_paper_position_close($1::uuid, $2::uuid, 'smc', 155.507852, 871.19, 60.8, 'tp_hit', now()) as r`,
    [rowId, USER])).rows[0].r;
  assertEquals((await call()).closed, true);
  assertEquals((await call()).closed, false);
  assertEquals(await balance(db), 100871.19);
  await db.close();
});

// ─── closed_at / open_time normalisation ────────────────────────────────────

const historyRow = (positionId: string, closedAt: string, openTime: string) => ({
  user_id: USER, bot_id: "smc", position_id: positionId, symbol: "USD/JPY", direction: "long",
  open_time: openTime, closed_at: closedAt, close_reason: "tp_hit", order_id: "", pnl: 1,
});
async function insertTextHistory(db: PGlite, rows: Record<string, unknown>[]) {
  for (const row of rows) {
    const cols = Object.keys(row);
    await db.query(`insert into public.paper_trade_history (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
      cols.map((c) => row[c]));
  }
}

Deno.test("closed_at: all three production formats convert; date filters include backfilled rows; raw text preserved", async () => {
  const db = await baseDb();
  await db.query(`insert into public.paper_accounts (user_id, bot_id, balance, peak_balance, daily_pnl_base) values ($1,'smc',100000,100000,100000)`, [USER]);
  // Exact formats from the 2026-10-05 snapshot.
  await insertTextHistory(db, [
    historyRow("js000001", "2026-09-16T05:59:48.684Z", "2026-09-15T22:02:55.661Z"),
    historyRow("0e76555c", "2026-09-16 18:20:02.533382+00", "2026-09-16 07:40:09.912038+00"),
    historyRow("pg000003", "2026-08-26 12:45:03.304+00", "2026-08-26 06:41:14.049833+00"),
  ]);
  // Before: the text filter the edge functions used drops the backfilled row.
  const before = (await db.query<{ p: string }>(
    `select position_id as p from public.paper_trade_history where closed_at >= '2026-09-16T00:00:00.000Z' order by p`)).rows.map((r) => r.p);
  assertEquals(before, ["js000001"], "precondition: text comparison loses 0e76555c");

  await applyMigrations(db);

  const after = (await db.query<{ p: string }>(
    `select position_id as p from public.paper_trade_history where closed_at >= '2026-09-16T00:00:00.000Z' order by p`)).rows.map((r) => r.p);
  assertEquals(after, ["0e76555c", "js000001"]);
  const day = (await db.query<{ p: string }>(
    `select position_id as p from public.paper_trade_history
      where closed_at >= '2026-09-16T00:00:00Z' and closed_at < '2026-09-17T00:00:00Z' order by closed_at`)).rows.map((r) => r.p);
  assertEquals(day, ["js000001", "0e76555c"], "chronological order is by instant, not by string");

  const raw = (await db.query<{ closed_at_raw: string; open_time_raw: string; t: string }>(
    `select closed_at_raw, open_time_raw, to_char(closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as t
       from public.paper_trade_history where position_id = '0e76555c'`)).rows[0];
  assertEquals(raw.closed_at_raw, "2026-09-16 18:20:02.533382+00");
  assertEquals(raw.open_time_raw, "2026-09-16 07:40:09.912038+00");
  assertEquals(raw.t, "2026-09-16T18:20:02.533382", "microseconds survive");

  // A JS toISOString() written after the migration still lands.
  await insertTextHistory(db, [historyRow("js000004", new Date("2026-10-06T09:00:00Z").toISOString(), "2026-10-06T08:00:00.000Z")]);
  assertEquals(await count(db, "public.paper_trade_history where closed_at >= '2026-10-06'"), 1);
  await db.close();
});

Deno.test("closed_at migration refuses a value with no UTC offset and leaves the column untouched", async () => {
  const db = await baseDb();
  await insertTextHistory(db, [historyRow("nooffset", "2026-09-16 18:20:02", "2026-09-16 07:40:09")]);
  await assertRejects(() => db.exec(MIGRATION_TIMESTAMPS), Error, "without a recognised UTC offset");
  const t = (await db.query<{ t: string }>(
    `select data_type as t from information_schema.columns where table_name = 'paper_trade_history' and column_name = 'closed_at'`)).rows[0].t;
  assertEquals(t, "text");
  await db.close();
});

// ─── The JS wrapper ─────────────────────────────────────────────────────────

Deno.test("interpretSettlement: unrecognised replies fail closed; transport errors never throw", async () => {
  assertEquals(interpretSettlement(null, { message: "boom" }).outcome, "failed");
  assertEquals(interpretSettlement({ settled: true }, null).outcome, "failed", "settled without amount");
  assertEquals(interpretSettlement({ weird: 1 }, null).outcome, "failed");
  assertEquals(interpretSettlement({ settled: false, code: "already_settled" }, null).outcome, "already_settled");
  assertEquals(interpretSettlement({ settled: false, code: "position_missing" }, null).outcome, "rejected");
  const throwing: RpcClient = { rpc: () => { throw new Error("network down"); } };
  const r = await settlePaperPosition(throwing, { positionRowId: "x", userId: USER, botId: "smc", history: {}, source: "t" });
  assertEquals(r.outcome, "failed");
  assert(describeSettlementMiss(r as Exclude<typeof r, { outcome: "settled" }>).includes("nothing committed"));
});

// ─── settlement_monitor_runs ────────────────────────────────────────────────

Deno.test("monitor results: insertable, append-only, one final verdict per epoch", async () => {
  const db = await freshDb();
  const epoch = (await db.query<{ e: string }>(`select ledger_epoch_id::text as e from public.paper_accounts`)).rows[0].e;
  const ins = (mode: string) => db.query(
    `insert into public.settlement_monitor_runs (mode, epoch_id, pass, checks) values ($1, $2::uuid, true, '[]'::jsonb)`, [mode, epoch]);
  await ins("periodic"); await ins("periodic"); await ins("final");
  await assertRejects(() => ins("final"), Error, "duplicate key");
  await assertRejects(() => db.query(`update public.settlement_monitor_runs set pass = false`), Error, "append-only");
  await assertRejects(() => db.query(`delete from public.settlement_monitor_runs`), Error, "append-only");
  assertEquals(await count(db, "public.settlement_monitor_runs"), 3);
  await db.close();
});

Deno.test("every column the monitor and reset functions select exists", async () => {
  const db = await freshDb();
  const src = ["../../functions/settlement-monitor/index.ts", "../../functions/_shared/settlementMonitorLoad.ts", "../../functions/system-reset/index.ts"]
    .map((f) => Deno.readTextFileSync(new URL(f, import.meta.url))).join("\n");
  for (const m of src.matchAll(/from\("([a-z_]+)"\)\s*\n?\s*\.select\("([^"]+)"\)/g)) {
    const [, table, list] = m;
    const cols = new Set((await db.query<{ c: string }>(
      `select column_name as c from information_schema.columns where table_schema in ('public') and table_name = $1`, [table])).rows.map((r) => r.c));
    if (cols.size === 0) continue; // tables outside this harness (user_settings, close_audit_log)
    for (const c of list.split(",").map((x) => x.trim()).filter((x) => x !== "*")) assert(cols.has(c), `${table}.${c} missing`);
  }
  await db.close();
});

// ─── system reset workflow objects ──────────────────────────────────────────

Deno.test("reset workflow: only app_admins are admins; execution ships disabled", async () => {
  const db = await freshDb();
  const admin = async (u: string | null) => (await db.query<{ a: boolean }>(`select public.is_app_admin($1::uuid) as a`, [u])).rows[0].a;
  assertEquals(await admin(USER), true);
  assertEquals(await admin(OTHER_USER), false);
  assertEquals(await admin(null), false);
  const can = async (role: string, fn: string) =>
    (await db.query<{ ok: boolean }>(`select has_function_privilege($1, $2, 'execute') as ok`, [role, fn])).rows[0].ok;
  assertEquals(await can("anon", "public.is_app_admin(uuid)"), false);
  assertEquals(await can("authenticated", "public.accounting_objects_present()"), false);
  const ctl = (await db.query<{ e: boolean }>(`select execute_enabled as e from public.system_reset_controls`)).rows[0].e;
  assertEquals(ctl, false, "the destructive action ships OFF");
  await db.close();
});

Deno.test("reset workflow: every accounting object reports present", async () => {
  const db = await freshDb();
  const o = (await db.query<{ o: Record<string, boolean> }>(`select public.accounting_objects_present() as o`)).rows[0].o;
  assertEquals(Object.entries(o).filter(([, v]) => !v), [], JSON.stringify(o));
  await db.close();
});

Deno.test("reset audit trail: one running at a time, immutable once terminal, never deletable", async () => {
  const db = await freshDb();
  const acct = (await db.query<{ id: string }>(`select id from public.paper_accounts`)).rows[0].id;
  const ins = (status: string) => db.query<{ r: string }>(
    `insert into public.account_reset_runs (account_id, requested_by, requested_at, status) values ($1, $2, now(), $3) returning reset_id as r`,
    [acct, USER, status]);
  const run = (await ins("running")).rows[0].r;
  await assertRejects(() => ins("running"), Error, "duplicate key");
  await db.query(`update public.account_reset_runs set steps = '[{"step":"pause_entries"}]', status = 'failed', failed_step = 'x' where reset_id = $1`, [run]);
  await assertRejects(() => db.query(`update public.account_reset_runs set failure_reason = 'rewrite' where reset_id = $1`, [run]), Error, "immutable");
  await assertRejects(() => db.query(`delete from public.account_reset_runs`), Error, "permanent");
  await assertRejects(() => db.query(`truncate public.account_reset_runs cascade`), Error, "permanent");
  await ins("aborted");
  assertEquals(await count(db, "public.account_reset_runs"), 2);
  await db.close();
});

Deno.test("reset snapshots: append-only", async () => {
  const db = await freshDb();
  const acct = (await db.query<{ id: string }>(`select id from public.paper_accounts`)).rows[0].id;
  const run = (await db.query<{ r: string }>(`insert into public.account_reset_runs (account_id, requested_by, requested_at, status) values ($1,$2,now(),'running') returning reset_id as r`, [acct, USER])).rows[0].r;
  await db.query(`insert into public.account_reset_snapshots (reset_id, account, ledger, reconciliation, period_history, closed_positions, cancelled_orders, cancelled_setups)
    values ($1, '{}', '[]', '{}', '[]', '[]', '[]', '[]')`, [run]);
  await assertRejects(() => db.query(`update public.account_reset_snapshots set config_hash = 'x'`), Error, "append-only");
  await assertRejects(() => db.query(`delete from public.account_reset_snapshots`), Error, "append-only");
  await db.close();
});

// ─── post-reset entries lock ────────────────────────────────────────────────

Deno.test("entries lock: ships off; a signed-in user cannot lift it; the server can set it", async () => {
  const db = await freshDb();
  const lockedOf = async () => (await db.query<{ l: boolean }>(`select entries_locked as l from public.paper_accounts where user_id = $1`, [USER])).rows[0].l;
  assertEquals(await lockedOf(), false, "no behaviour change before the reset");

  // The server (service role) sets it, as the reset does.
  await db.query(`select set_config('request.jwt.claim.role', 'service_role', false)`);
  await db.exec(`set session authorization authenticated`);
  await db.query(`update public.paper_accounts set entries_locked = true, entries_locked_reason = 'reset' where user_id = $1`, [USER]);
  assertEquals(await lockedOf(), true);

  // The account owner, signed in through the API, cannot lift it.
  await db.query(`select set_config('request.jwt.claim.role', 'authenticated', false), set_config('request.jwt.claim.sub', $1, false)`, [USER]);
  await assertRejects(() => db.query(`update public.paper_accounts set entries_locked = false where user_id = $1`, [USER]), Error, "entries lock");
  // …while ordinary fields stay editable (e.g. the app's pause button).
  await db.query(`update public.paper_accounts set is_paused = false where user_id = $1`, [USER]);
  await db.exec(`set session authorization postgres`);
  assertEquals(await lockedOf(), true, "unpausing does not unlock");
  await db.close();
});

Deno.test("entries lock: service role recognised as PostgREST sends it today (request.jwt.claims JSON only) — the 2026-10-06 reset failure", async () => {
  const db = await baseDb();
  await db.query(`insert into public.paper_accounts (user_id, bot_id, balance, peak_balance, daily_pnl_base) values ($1,'smc',100000,100000,100000)`, [USER]);
  await db.exec(MIGRATION_TIMESTAMPS); await db.exec(MIGRATION_LEDGER); await db.exec(MIGRATION_MONITOR); await db.exec(MIGRATION_RESET); await db.exec(MIGRATION_LOCK);
  // NB: in PGlite, `set session authorization postgres` returns to the last role set,
  // not the login role — switch back to postgres explicitly.
  const asApi = async (claims: Record<string, unknown>, sql: string) => {
    await db.exec(`set session authorization authenticated`);
    await db.query(`select set_config('request.jwt.claim.role', '', false), set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
    try { await db.query(sql, [USER]); }
    finally { await db.exec(`set session authorization postgres`); }
  };
  const lockSql = `update public.paper_accounts set entries_locked = true, entries_locked_reason = 'reset' where user_id = $1`;
  // Before the fix: exactly the production error, for a service-role request.
  await assertRejects(() => asApi({ role: "service_role" }, lockSql), Error, "entries lock can only be changed by the server");
  // After the fix: the reset's lock call succeeds…
  await db.exec(MIGRATION_ROLE_FIX);
  await asApi({ role: "service_role" }, lockSql);
  assertEquals((await db.query<{ l: boolean }>(`select entries_locked as l from public.paper_accounts`)).rows[0].l, true);
  // …and a signed-in user, in the same modern form, is still refused.
  await assertRejects(() => asApi({ role: "authenticated", sub: USER }, `update public.paper_accounts set entries_locked = false where user_id = $1`), Error, "entries lock");
  assertEquals((await db.query<{ l: boolean }>(`select entries_locked as l from public.paper_accounts`)).rows[0].l, true);
  await db.close();
});

Deno.test("role-dependent triggers decide on auth.role(), never on the legacy GUC alone", () => {
  const fix = read("../../migrations/20261006060000_fix_jwt_role_detection.sql").replace(/^--.*$/gm, "");
  assert(!/request\.jwt\.claim\.role/.test(fix), "the fix uses auth.role(), not the legacy GUC");
  assert(/COALESCE\(auth\.role\(\), ''\) <> 'service_role'/.test(fix));
});

// ─── in-database reset snapshot ─────────────────────────────────────────────

Deno.test("reset snapshot: built in-DB, compact history with an integrity hash, refuses a non-running run, service-role only", async () => {
  const db = await freshDb();
  const acct = (await db.query<{ id: string }>(`select id from public.paper_accounts`)).rows[0].id;
  // 500 history rows with ~40 KB signal_reason each (~20 MB) — the shape that timed out through the API.
  await db.exec(`alter table public.paper_trade_history disable trigger trg_freeze_streamlined_decision`);
  await db.query(`insert into public.paper_trade_history (user_id, bot_id, position_id, symbol, direction, open_time, closed_at, close_reason, order_id, pnl, signal_reason)
    select $1, 'smc', 'p' || g, 'EUR/USD', 'long', now() - interval '2 days', now() - (g || ' minutes')::interval, 'tp_hit', '', g, repeat('x', 40000)
      from generate_series(1, 500) g`, [USER]);
  await db.exec(`alter table public.paper_trade_history enable trigger trg_freeze_streamlined_decision`);
  await db.query(`insert into public.bot_configs (user_id, config_json) values ($1, '{"tradingStyle":{"mode":"scalper"}}')`, [USER]);
  const run = (await db.query<{ r: string }>(`insert into public.account_reset_runs (account_id, requested_by, requested_at, status) values ($1,$2,now(),'running') returning reset_id as r`, [acct, USER])).rows[0].r;

  const t0 = Date.now();
  const id = (await db.query<{ id: number }>(`select public.take_account_reset_snapshot($1::uuid, '[{"position_id":"x"}]', '[]', '[]') as id`, [run])).rows[0].id;
  const ms = Date.now() - t0;
  const snap = (await db.query<{ n: number; md5: string; bytes: number; has_blob: boolean; cfg: string }>(`
    select (row_counts->>'period_history')::int as n, row_counts->>'period_history_md5' as md5,
           octet_length(period_history::text) as bytes, period_history::text like '%xxxxxxxx%' as has_blob,
           config->'config_json'->'tradingStyle'->>'mode' as cfg
      from public.account_reset_snapshots where id = $1`, [id])).rows[0];
  assertEquals(snap.n, 500, "every history row listed");
  assert(/^[0-9a-f]{32}$/.test(snap.md5), "integrity hash present");
  assertEquals(snap.has_blob, false, "the large text blobs are NOT copied");
  assert(snap.bytes < 500 * 1000, `compact: ${snap.bytes} bytes for 500 rows`);
  assertEquals(snap.cfg, "scalper", "config captured");
  assert(ms < 20000, `fast enough for the API statement timeout: ${ms} ms`);

  await db.query(`update public.account_reset_runs set status = 'failed' where reset_id = $1`, [run]);
  await assertRejects(() => db.query(`select public.take_account_reset_snapshot($1::uuid, '[]', '[]', '[]')`, [run]), Error, "not running");

  const can = async (role: string) => (await db.query<{ ok: boolean }>(
    `select has_function_privilege($1, 'public.take_account_reset_snapshot(uuid, jsonb, jsonb, jsonb)', 'execute') as ok`, [role])).rows[0].ok;
  assertEquals(await can("service_role"), true);
  assertEquals(await can("authenticated"), false);
  assertEquals(await can("anon"), false);
  await db.close();
});

// ─── step 8: dry-run orders + database entries-lock safety net ───────────────

const pendingRow = (over: Record<string, unknown> = {}) => ({
  user_id: USER, bot_id: "smc", order_id: crypto.randomUUID().slice(0, 8), symbol: "EUR/USD", direction: "long",
  order_type: "limit", entry_price: 1.1, current_price: 1.101, stop_loss: 1.098, take_profit: 1.1022,
  status: "pending", expires_at: new Date(Date.now() + 8 * 3600_000).toISOString(), ...over,
});
async function insertPending(db: PGlite, row: Record<string, unknown>): Promise<string> {
  const cols = Object.keys(row);
  return (await db.query<{ id: string }>(
    `insert into public.pending_orders (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`,
    cols.map((c) => row[c]))).rows[0].id;
}
const lock = (db: PGlite, on: boolean) => db.query(`update public.paper_accounts set entries_locked = $1 where user_id = $2`, [on, USER]);

Deno.test("step 8 safety net: while locked, no position and no real order — only dry-run orders", async () => {
  const db = await freshDb();
  await lock(db, true);
  await assertRejects(() => openPosition(db), Error, "entries locked: no new positions");
  await assertRejects(() => insertPending(db, pendingRow()), Error, "only dry-run orders");
  const dryId = await insertPending(db, pendingRow({ dry_run: true, dry_run_context: { legacyWouldAdmit: false } }));
  assert(dryId);
  // The hunt's hypothetical fill is an UPDATE on the dry-run order — allowed.
  await db.query(`update public.pending_orders set status = 'filled', filled_at = now() where id = $1`, [dryId]);
  assertEquals(await count(db, "public.paper_positions"), 0);
  await db.close();
});

Deno.test("step 8 safety net: a dry-run order can never become a position or a real order, even unlocked", async () => {
  const db = await freshDb();
  await lock(db, true);
  const dryId = await insertPending(db, pendingRow({ dry_run: true }));
  await lock(db, false);
  await assertRejects(() => openPosition(db, { source_pending_order_id: dryId }), Error, "dry-run order can never become a position");
  await assertRejects(() => db.query(`update public.pending_orders set dry_run = false where id = $1`, [dryId]), Error, "immutable");
  // Unlocked, ordinary orders and positions work again. (Another symbol: the
  // dry-run order above is still live, and production allows one live order
  // per symbol + direction — idx_pending_orders_unique_active.)
  await insertPending(db, pendingRow({ symbol: "GBP/USD" }));
  await openPosition(db, { position_id: "real0001" });
  assertEquals(await count(db, "public.paper_positions"), 1);
  await db.close();
});

// ─── Step 15 PR 1: attribution schema + settlement support ──────────────────

type Db = Awaited<ReturnType<typeof freshDb>>;

/** An attribution row (sections A–D) plus, optionally, a recorded real fill (F). */
async function insertAttribution(db: Db, over: Record<string, unknown> = {}, fill: Record<string, unknown> | null = {}) {
  const sig = (over.signal_id as string) ?? crypto.randomUUID();
  const row: Record<string, unknown> = {
    signal_id: sig, user_id: USER, bot_id: "smc", symbol: "USD/JPY", direction: "long", dry_run: false,
    scan_cycle_id: crypto.randomUUID(), decision_id: crypto.randomUUID(), decision_at: "2026-10-08T10:00:00Z",
    config_version: "3d5b8fb0d756b3596ed46d133e873a88", strategy_version: "smc-zone-impulse-control-v1",
    sizing_version: "fill_time_v1", stop_version: "route2_limit_anchor_v1", management_version: "none_v1",
    caps_version: "unified_3_1", route: "route2_pending_confirmation", primary_engine: "impulse_zone",
    primary_engine_rule: "primary-engine.v1", game_plan: "{}", impulse: "{}", unified: "{}", score: "{}", gates: "[]",
    legacy_would_admit: false, limit_price: 154.9, stop_price: 154.65, stop_source: "floor", stop_distance_pips: 25,
    target_price: 155.175, raw_rr: 1.1, effective_rr: 1.06, cost_in_price: 0.01, intended_risk_pct: 0.5, intended_risk_usd: 500,
    ...over,
  };
  if (fill) Object.assign(row, {
    order_id: "ordAttr1", order_placed_at: "2026-10-08T10:00:00Z", terminal_status: "filled", terminal_reason: "FILLED",
    terminal_at: "2026-10-08T10:30:00Z", fill_kind: "real", filled_at: "2026-10-08T10:30:00Z",
    fill_price: 154.9, fill_stop_price: 154.65, fill_target_price: 155.175, fill_lots: 3.16, fill_risk_usd: 499.3, fill_risk_pct: 0.4993, ...fill,
  });
  const cols = Object.keys(row);
  await db.query(`insert into public.trade_attribution (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")})`, cols.map((c) => row[c]));
  return sig;
}
const attr = async (db: Db, sig: string) =>
  (await db.query<Record<string, any>>(`select * from public.trade_attribution where signal_id = $1`, [sig])).rows[0];
const events = async (db: Db, sig: string): Promise<{ event_type: string; source: string; detail: any }[]> =>
  (await db.query<{ event_type: string; source: string; detail: any }>(`select event_type, source, detail from public.trade_attribution_events where signal_id = $1 order by id`, [sig])).rows;

Deno.test("step 15: the migration is idempotent (second application changes nothing and does not fail)", async () => {
  const db = await freshDb();
  const objects = async () => (await db.query<{ n: string }>(`
    select string_agg(x, ',' order by x) n from (
      select 'table:' || tablename x from pg_tables where schemaname = 'public' and tablename like 'trade_attribution%'
      union all select 'trigger:' || tgname from pg_trigger where not tgisinternal and tgname like any (array['%attribution%', '%signal_id%', 'tae_%'])
      union all select 'index:' || indexname from pg_indexes where schemaname = 'public' and (indexname like 'ta_%' or indexname like 'tae_%' or indexname like '%_signal%')
      union all select 'column:' || table_name || '.' || column_name from information_schema.columns where table_schema = 'public' and column_name in ('signal_id', 'config_version', 'fill_sizing')
      union all select 'function:' || proname || '/' || pronargs from pg_proc where proname in ('_paper_ledger_post', 'ta_event', 'ta_exit_reason', 'trade_attribution_guard', 'signal_id_immutable')
    ) s`)).rows[0].n;
  const before = await objects();
  await db.exec(MIGRATION_STEP15);
  assertEquals(await objects(), before);
  assert(before.includes("function:_paper_ledger_post/10") && !before.includes("function:_paper_ledger_post/9"), "only the 10-argument ledger post exists");
  for (const t of ["smc_scan_decision", "pending_orders", "paper_positions", "paper_trade_history", "paper_account_ledger"]) {
    assert(before.includes(`column:${t}.signal_id`), t);
  }
  await db.close();
});

Deno.test("step 15: bot_configs.config_version equals the change log's next_hash for the same write", async () => {
  const db = await freshDb();
  await db.exec(`${functionDdl("audit_bot_config_change")}
    ${line(/CREATE TRIGGER audit_bot_config_change [^\n]*/)}`);
  await db.query(`insert into public.bot_configs (user_id, config_json) values ($1, $2::jsonb)`, [USER, JSON.stringify({ b: 2, a: { z: [1, "x"], y: null } })]);
  for (const next of [{ tradingStyle: { mode: "scalper" }, simplification: { capsMode: "unified" } }, { "ü": "unicode", n: 1.10, big: 12345678901234567890 }]) {
    await db.query(`update public.bot_configs set config_json = $1::jsonb where user_id = $2`, [JSON.stringify(next), USER]);
    const r = (await db.query<{ v: string; h: string }>(`
      select c.config_version v, (select next_hash from public.bot_config_change_log order by changed_at desc, id desc limit 1) h
      from public.bot_configs c where user_id = $1`, [USER])).rows[0];
    assertEquals(r.v, r.h);
    assert(/^[0-9a-f]{32}$/.test(r.v));
  }
  await db.close();
});

Deno.test("step 15: a legacy settlement (signal_id NULL) is unchanged — no attribution, no events, NULL signal_id downstream", async () => {
  const db = await freshDb();
  const rowId = await openPosition(db);
  const r = await settle(db, rowId, usdJpyClose());
  assertEquals(r.outcome, "settled");
  assertEquals(await count(db, `public.paper_trade_history where signal_id is null and position_id = '0e76555c'`), 1);
  assertEquals(await count(db, `public.paper_account_ledger where kind = 'close' and signal_id is null`), 1);
  assertEquals(await count(db, `public.trade_attribution`), 0);
  assertEquals(await count(db, `public.trade_attribution_events`), 0);
  assertEquals(await balance(db), 100000 + 871.19);
  await db.close();
});

Deno.test("step 15: an attributed settlement writes history + ledger + attribution in one transaction", async () => {
  const db = await freshDb();
  const sig = await insertAttribution(db);
  const rowId = await openPosition(db, { signal_id: sig, entry_price: 154.9, stop_loss: 154.65, take_profit: 155.175 });
  const r = await settle(db, rowId, { exit_price: 155.175, pnl: 547.6, pnl_pips: 27.5, close_reason: "tp_hit" });
  assertEquals(r.outcome, "settled");
  const h = (await db.query<any>(`select id, signal_id from public.paper_trade_history where position_id = '0e76555c'`)).rows[0];
  const l = (await db.query<any>(`select id, signal_id, history_id from public.paper_account_ledger where kind = 'close'`)).rows[0];
  assertEquals([h.signal_id, l.signal_id, l.history_id], [sig, sig, h.id]);
  const a = await attr(db, sig);
  assertEquals([a.outcome_kind, a.exit_reason, a.close_source, a.history_id, a.ledger_id], ["real", "target", "scanner_breach_check", h.id, l.id]);
  assertEquals(Number(a.realized_pnl_usd), 547.6);
  assert(Math.abs(Number(a.realized_r_gross) - 1.1) < 1e-9, `R gross ${a.realized_r_gross}`);
  assert(Math.abs(Number(a.realized_r_net) - (0.275 - 0.01) / 0.25) < 1e-9, `R net ${a.realized_r_net}`);
  assert(a.closed_at);
  // since PR 2 the position insert itself records position_opened
  assertEquals((await events(db, sig)).map((e: { event_type: string }) => e.event_type), ["position_opened", "closed"]);
  assertEquals(await count(db, `public.paper_positions`), 0);
  await db.close();
});

Deno.test("step 15: when the settlement rolls back, the attribution close rolls back with it (atomic)", async () => {
  const db = await freshDb();
  const sig = await insertAttribution(db);
  const rowId = await openPosition(db, { signal_id: sig });
  // Fail at the LAST statement of the settlement (deleting the position) —
  // after history, ledger and the attribution close have all been written.
  await db.exec(`create function public.boom() returns trigger language plpgsql as $$ begin raise exception 'last-step boom'; end $$;
                 create trigger boom before delete on public.paper_positions for each row execute function public.boom();`);
  const r = await settle(db, rowId, usdJpyClose());
  assert(r.outcome !== "settled");
  assertEquals(await count(db, `public.paper_account_ledger where kind = 'close'`), 0, "ledger rolled back");
  const a = await attr(db, sig);
  assertEquals([a.closed_at, a.outcome_kind, a.history_id, a.ledger_id], [null, null, null, null]);
  assertEquals(await count(db, `public.paper_trade_history`), 0);
  // position_opened was written when the position opened (before this
  // settlement) and correctly survives; nothing from the failed close does.
  assertEquals(await count(db, `public.trade_attribution_events where event_type <> 'position_opened'`), 0);
  assertEquals(await count(db, `public.paper_positions`), 1, "position kept");
  assertEquals(await balance(db), 100000);
  await db.close();
});

Deno.test("step 15: attribution can never block a settlement", async () => {
  const db = await freshDb();
  // (a) attributed position whose attribution has no fill recorded yet → money settles, G not written, event says why
  const s1 = await insertAttribution(db, {}, null);
  const p1 = await openPosition(db, { signal_id: s1 });
  assertEquals((await settle(db, p1, usdJpyClose())).outcome, "settled");
  assertEquals((await attr(db, s1)).closed_at, null);
  assert((await events(db, s1)).find((e) => e.event_type === "closed")!.detail.note.includes("not written"));
  // (b) attribution update itself errors → rolled back to its savepoint, recorded, money still settles
  const s2 = await insertAttribution(db, { symbol: "EUR/USD" });
  const p2 = await openPosition(db, { signal_id: s2, position_id: "pos2", order_id: "ord2", symbol: "EUR/USD" });
  await db.exec(`create function public.ta_boom() returns trigger language plpgsql as $$ begin raise exception 'attribution boom'; end $$;
                 create trigger ta_boom before update on public.trade_attribution for each row execute function public.ta_boom();`);
  assertEquals((await settle(db, p2, usdJpyClose({ pnl: 10 }))).outcome, "settled");
  const ev = (await events(db, s2)).filter((e) => e.event_type === "closed");
  assertEquals(ev.length, 1);
  assert(ev[0].detail.attribution_error.includes("attribution boom"));
  assertEquals(await count(db, `public.paper_account_ledger where kind = 'close' and signal_id = $1`, [s2]), 1);
  await db.close();
});

Deno.test("step 15: duplicate settlement remains impossible for an attributed trade", async () => {
  const db = await freshDb();
  const sig = await insertAttribution(db);
  const rowId = await openPosition(db, { signal_id: sig });
  assertEquals((await settle(db, rowId, usdJpyClose())).outcome, "settled");
  const before = await attr(db, sig);
  const again = await settle(db, rowId, usdJpyClose({ closed_at: "2026-10-08T12:00:01Z" }));
  assertEquals(again.outcome, "already_settled");
  assertEquals(await count(db, `public.paper_account_ledger where kind = 'close'`), 1);
  assertEquals(await count(db, `public.paper_trade_history where close_reason <> 'partial_tp'`), 1);
  assertEquals(await balance(db), 100000 + 871.19);
  assertEquals(JSON.stringify(await attr(db, sig)), JSON.stringify(before), "attribution untouched by the repeat");
  assertEquals((await events(db, sig)).map((e: { event_type: string }) => e.event_type), ["position_opened", "closed"]);
  await db.close();
});

Deno.test("step 15: every close source maps to its exit reason and keeps the signal id", async () => {
  const db = await freshDb();
  const cases: [string, string, string][] = [
    ["paper_trading_manual", "manual", "manual"], ["prop_firm_emergency", "prop_firm_emergency", "prop_firm_emergency"],
    ["kill_switch", "kill_switch", "kill_switch"], ["account_reset_flatten", "account_reset_flatten", "reset_flatten"],
    ["paper_trading_auto", "sl_hit", "stop"], ["scanner_breach_check", "tp_hit", "target"], ["scanner_reverse_signal", "reverse_signal", "reverse_signal"],
  ];
  let i = 0;
  for (const [source, reason, expected] of cases) {
    i++;
    const sig = await insertAttribution(db, { symbol: `SYM${i}` }, { order_id: `ord${i}` });
    const rowId = await openPosition(db, { signal_id: sig, position_id: `pos${i}`, order_id: `ord${i}`, symbol: `SYM${i}` });
    const exit = reason === "sl_hit" ? 154.65 : 155.0;
    assertEquals((await settle(db, rowId, { exit_price: exit, pnl: reason === "sl_hit" ? -499.3 : 100, close_reason: reason }, source)).outcome, "settled", source);
    const a = await attr(db, sig);
    assertEquals([a.exit_reason, a.close_source], [expected, source], source);
    assertEquals(await count(db, `public.paper_account_ledger where signal_id = $1 and source = $2`, [sig, source]), 1);
    if (reason === "sl_hit") assert(Math.abs(Number(a.realized_r_gross) + 1) < 1e-9, "a stop at the fill stop is exactly −1R");
  }
  await db.close();
});

Deno.test("step 15: an attributed partial TP carries the signal id to its history and ledger rows", async () => {
  const db = await freshDb();
  const sig = await insertAttribution(db);
  const rowId = await openPosition(db, { signal_id: sig });
  const r = await settlePaperPartial(rpcClient(db), { positionRowId: rowId, userId: USER, botId: "smc", remainingSize: 0.5,
    positionSignalReason: null, history: { exit_price: 155.2, pnl: 150, size: 0.5, pnl_pips: 30 }, source: "paper_trading_partial_tp" });
  assertEquals(r.outcome, "settled");
  assertEquals(await count(db, `public.paper_trade_history where close_reason = 'partial_tp' and signal_id = $1`, [sig]), 1);
  assertEquals(await count(db, `public.paper_account_ledger where kind = 'partial' and signal_id = $1`, [sig]), 1);
  assertEquals((await events(db, sig)).map((e: { event_type: string }) => e.event_type), ["position_opened", "partial_close"]);
  assertEquals((await attr(db, sig)).closed_at, null, "a partial is not the close");
  await db.close();
});

Deno.test("step 15: attribution rows cannot be deleted or illegally mutated; events are append-only; signal ids are fixed", async () => {
  const db = await freshDb();
  const sig = await insertAttribution(db, {}, null);
  // immutable (A–D)
  for (const sql of [`stop_price = 1`, `primary_engine = 'unified'`, `config_version = '00000000000000000000000000000000'`, `gates = '[{"x":1}]'`, `created_at = now()`]) {
    await assertRejects(() => db.query(`update public.trade_attribution set ${sql} where signal_id = $1`, [sig]), Error, "immutable");
  }
  // write-once (E–G): first write ok, same value ok, different value refused
  await db.query(`update public.trade_attribution set order_id = 'o1' where signal_id = $1`, [sig]);
  await db.query(`update public.trade_attribution set order_id = 'o1' where signal_id = $1`, [sig]);
  await assertRejects(() => db.query(`update public.trade_attribution set order_id = 'o2' where signal_id = $1`, [sig]), Error, "write-once");
  await assertRejects(() => db.query(`update public.trade_attribution set order_id = null where signal_id = $1`, [sig]), Error, "write-once");
  // constraints
  await assertRejects(() => db.query(`update public.trade_attribution set superseded_by_signal_id = signal_id where signal_id = $1`, [sig]));
  await assertRejects(() => db.query(`update public.trade_attribution set closed_at = now() where signal_id = $1`, [sig]), Error, "ta_close_requires_fill");
  // no delete / truncate
  await assertRejects(() => db.query(`delete from public.trade_attribution where signal_id = $1`, [sig]), Error, "append-only");
  const t = await assertRejects(() => db.query(`truncate public.trade_attribution`)) as Error;
  assert(/append-only|referenced in a foreign key/.test(t.message));
  // events append-only
  await db.query(`select public.ta_event($1, 'closed', 'test', '{}'::jsonb, null)`, [sig]);
  await assertRejects(() => db.query(`update public.trade_attribution_events set source = 'x'`), Error, "append-only");
  await assertRejects(() => db.query(`delete from public.trade_attribution_events`), Error, "append-only");
  // signal_id fixed on lifecycle rows; unknown ids refused by FK
  const rowId = await openPosition(db, { signal_id: sig });
  const other = await insertAttribution(db, { symbol: "EUR/USD" }, null);
  await assertRejects(() => db.query(`update public.paper_positions set signal_id = $1 where id = $2`, [other, rowId]), Error, "immutable");
  await assertRejects(() => openPosition(db, { signal_id: crypto.randomUUID(), position_id: "x2", order_id: "x2" }));
  // client roles cannot write attribution
  await db.exec(`set role authenticated`);
  await assertRejects(() => db.query(`insert into public.trade_attribution (signal_id) values (gen_random_uuid())`));
  await db.exec(`set role postgres`);
  await db.close();
});

Deno.test("step 15: the pre-check refuses to overwrite a settlement function that was changed outside the repo", async () => {
  const db = await freshDb(); // first application already passed the pre-check against the 20261006010000 bodies
  const body = (await db.query<{ s: string }>(`select prosrc s from pg_proc where proname = 'settle_paper_partial'`)).rows[0].s;
  // simulate a hand edit in production: same function, one extra comment line
  const def = (await db.query<{ d: string }>(`select pg_get_functiondef('public.settle_paper_partial'::regproc) d`)).rows[0].d;
  await db.exec(def.replace(body, body.replace("BEGIN", "BEGIN\n  -- hand edit")));
  await assertRejects(() => db.exec(MIGRATION_STEP15), Error, "settle_paper_partial differs from the expected source");
  await db.close();
});

// ─── Step 15 PR 2: order / position lifecycle + atomic placement ────────────

const CFG32 = "3d5b8fb0d756b3596ed46d133e873a88";
let orderSeq = 0;
/** A realistic attribution payload, built by the production builder. */
function attrPayload(over: Partial<Parameters<typeof buildAttribution>[0]> = {}) {
  return buildAttribution({
    signalId: crypto.randomUUID(), decisionId: crypto.randomUUID(), scanCycleId: crypto.randomUUID(), userId: USER, botId: "smc",
    symbol: "CHF/JPY", direction: "long", dryRun: false, decisionAt: "2026-10-08T10:00:00Z", configVersion: CFG32,
    strategyVersion: "smc-zone-impulse-control-v1",
    switches: { sizingMode: "fill_time", riskPercent: 0.5, maxLotsPerTrade: 20, stopAnchor: "limit", unifiedModifiersEnabled: false },
    legacyRiskPercent: 0.5, management: {}, caps: { mode: "unified", maxOpenPositions: 3, maxPerSymbol: 1 }, impulseSlCapMultiplier: 1.5,
    riskProfileVersion: "rp1:abc", entrySource: "refinedEntry", izGateMode: "hard", gamePlanEnabled: true,
    gamePlanContext: { bias: "bearish", biasConfidence: 36, isFocusPair: true },
    directionVerdict: { verdict: "long", confidence: 75, agreement: 0.5 },
    impulse: { hasZone: true, selectedTF: "1H", impulse: { high: 190.49909, low: 189.9432, direction: "bullish" },
      bestZone: { type: "ob", low: 189.99417, high: 190.14972, fibLevel: 0.786, refinedEntry: 190.142885, totalScore: 3.5 } },
    unifiedDetected: null, gateScore: 61.6, decisionScoreGate: { mode: "log", score: 63.35, threshold: 20, wouldBlock: false },
    factors: [{ name: "Order Block", present: true, weight: 1, tier: 1 }], tieredScoring: { tier1Count: 2, tier2Count: 5 },
    gates: [{ gateId: "reaction", passed: true, loggedOnly: true, wouldBlock: true, reason: "[logged only — would block] Reaction" },
            { passed: true, reason: "0/3 positions" }, { passed: true, reason: "0/1 for CHF/JPY" }],
    ictFvgGate: { mode: "off", wouldBlock: false }, orderRR: { rawRR: 1.1, effectiveRR: 1.0, costInPrice: 0.025, wouldBlock: false, min: 1, mode: "order_geometry" },
    loggedOnlyWouldBlock: [{ gateId: "reaction", reason: "Reaction" }],
    riskGate: { enabled: true, allowed: true, reason: "ok", severity: "ok" },
    zoneId: "CHF/JPY|1H|long|189.9942|190.1497", entryDepth: 0.55,
    limitPrice: 190.142885, stopPrice: 189.892885, targetPrice: 190.417885, pipSize: 0.01,
    route2Stop: { anchor: "limit", floorPips: 25, capPips: 66.71, limit: { source: "floor", riskPips: 25 }, market: { sl: 189.93208 } },
    plannedSizing: { lots: 3.16, uncappedLots: 3.16, riskPercentTarget: 0.5, riskUsdTarget: 500 }, balance: 100000,
    expiresAt: "2026-10-08T18:00:00Z", ...over,
  });
}
function orderRow(over: Record<string, unknown> = {}) {
  orderSeq++;
  return {
    user_id: USER, bot_id: "smc", order_id: `o${orderSeq}`, symbol: "CHF/JPY", direction: "long", order_type: "limit",
    entry_price: 190.142885, current_price: 190.2, stop_loss: 189.892885, take_profit: 190.417885, size: 3.16,
    status: "pending", placed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 8 * 3600e3).toISOString(),
    expiry_minutes: 480, dry_run: false, signal_score: 61.6, ...over,
  };
}
async function place(db: Db, attribution: Record<string, unknown> | null, order: Record<string, unknown>, supersede: unknown[] = []) {
  return (await db.query<{ r: any }>(`select public.route2_place_order($1::jsonb, $2::jsonb, $3::jsonb) r`,
    [JSON.stringify(attribution), JSON.stringify(order), JSON.stringify(supersede)])).rows[0].r;
}
const orderBy = async (db: Db, orderId: string) =>
  (await db.query<any>(`select * from public.pending_orders where order_id = $1`, [orderId])).rows[0];
const evTypes = async (db: Db, sig: string) => (await events(db, sig)).map((e: { event_type: string }) => e.event_type);
/** Every A–D column of an attribution row (the immutable part). */
async function planOf(db: Db, sig: string) {
  const a = await attr(db, sig);
  const keep = ["signal_id", "symbol", "direction", "dry_run", "config_version", "primary_engine", "contributors", "game_plan", "impulse",
    "unified", "score", "gates", "risk_gate", "legacy_would_admit", "limit_price", "stop_price", "stop_source", "stop_distance_pips",
    "target_price", "raw_rr", "effective_rr", "intended_risk_pct", "intended_risk_usd", "planned_lots", "supersedes_signal_ids", "created_at"];
  return JSON.stringify(Object.fromEntries(keep.map((k) => [k, a[k]])));
}

Deno.test("step 15 PR 2: the lifecycle migration is idempotent", async () => {
  const db = await freshDb();
  await db.exec(MIGRATION_STEP15_PR2);
  const t = await db.query<{ n: string }>(`select string_agg(tgname, ',' order by tgname) n from pg_trigger where tgname in ('pending_orders_attribution','paper_positions_attribution')`);
  assertEquals(t.rows[0].n, "paper_positions_attribution,pending_orders_attribution");
  assertEquals((await db.query<{ n: number }>(`select count(*)::int n from pg_proc where proname = 'route2_place_order'`)).rows[0].n, 1);
  await db.close();
});

Deno.test("step 15 PR 2: one signal_id survives decision → order → touch → reset → confirm → real fill → position → close", async () => {
  const db = await freshDb();
  const a = attrPayload();
  const sig = a.signal_id as string;
  const r = await place(db, a, orderRow({ order_id: "realA" }));
  assertEquals([r.outcome, r.attribution, r.signal_id], ["placed", "written", sig]);
  // the decision row written at the end of the cycle names the same signal
  await db.query(`insert into public.smc_scan_decision (id, scan_cycle_id, user_id, bot_id, symbol, signal_id) values ($1, $2, $3, 'smc', 'CHF/JPY', $4)`,
    [a.decision_id, a.scan_cycle_id, USER, sig]);
  // touch → reset → touch again → confirm
  await db.query(`update public.pending_orders set status = 'awaiting_confirmation', zone_touch_time = now() - interval '3 minutes', confirmation_arm_count = 1 where order_id = 'realA'`);
  await db.query(`update public.pending_orders set status = 'pending', reset_reason = 'zone_exit' where order_id = 'realA'`);
  await db.query(`update public.pending_orders set status = 'awaiting_confirmation', zone_touch_time = now(), confirmation_arm_count = 2 where order_id = 'realA'`);
  const o = await orderBy(db, "realA");
  // real fill: the claim RPC updates the order and inserts the position in ONE transaction
  const claim = (await db.query<{ r: any }>(`select public.route2_claim_and_fill($1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb) r`, [o.id, USER, 2,
    JSON.stringify({ terminal_reason: "FILLED", confirmation_accepted: true, confirmation_accepted_at: new Date().toISOString(), confirmation_tier: 3,
      confirmation_type: "bullish_reversal_pattern", confirmation_timeframe: "5m", fill_price: 190.1643, filled_at: new Date().toISOString(),
      resolved_at: new Date().toISOString(),
      fill_sizing: { lots: 2.91, uncappedLots: 2.9177, riskUsdActual: 498.67, riskPercentActual: 0.4987, capReason: null, stopDistancePips: 27.14, insideFloor: false } }),
    JSON.stringify({ user_id: USER, bot_id: "smc", position_id: "posRealA", order_id: "realA", symbol: "CHF/JPY", direction: "long", size: "2.91",
      entry_price: "190.1643", current_price: "190.1643", stop_loss: "189.892885", take_profit: "190.417885", open_time: new Date().toISOString(),
      signal_score: "61.6", position_status: "open", signal_id: sig })])).rows[0].r;
  assertEquals(claim.outcome, "filled");
  const pos = (await db.query<any>(`select id, signal_id from public.paper_positions where position_id = 'posRealA'`)).rows[0];
  let at = await attr(db, sig);
  assertEquals([pos.signal_id, at.order_id, at.terminal_status, at.fill_kind, Number(at.fill_price), Number(at.fill_lots), at.position_row_id, at.fill_inside_floor],
               [sig, "realA", "filled", "real", 190.1643, 2.91, pos.id, false]);
  assert(at.touched_at && at.confirmed_at);
  // close → history + ledger carry the same signal
  assertEquals((await settle(db, pos.id, { exit_price: 189.892885, pnl: -498.67, close_reason: "sl_hit" }, "paper_trading_auto")).outcome, "settled");
  at = await attr(db, sig);
  const h = (await db.query<any>(`select signal_id from public.paper_trade_history where position_id = 'posRealA'`)).rows[0];
  const l = (await db.query<any>(`select signal_id from public.paper_account_ledger where position_id = 'posRealA' and kind = 'close'`)).rows[0];
  const d = (await db.query<any>(`select signal_id from public.smc_scan_decision where id = $1`, [a.decision_id])).rows[0];
  assertEquals([d.signal_id, h.signal_id, l.signal_id, at.exit_reason], [sig, sig, sig, "stop"]);
  assert(Math.abs(Number(at.realized_r_gross) + 1) < 1e-9);
  assertEquals(await evTypes(db, sig), ["order_inserted", "touched", "reset", "touched", "confirmed", "filled", "position_opened", "closed"]);
  await db.close();
});

Deno.test("step 15 PR 2: dry-run fill is hypothetical and can never become a position", async () => {
  const db = await freshDb();
  await db.query(`update public.paper_accounts set entries_locked = true where user_id = $1`, [USER]);
  const a = attrPayload({ dryRun: true });
  const sig = a.signal_id as string;
  assertEquals((await place(db, a, orderRow({ order_id: "dryA", dry_run: true }))).outcome, "placed");
  await db.query(`update public.pending_orders set status = 'awaiting_confirmation', zone_touch_time = now() where order_id = 'dryA'`);
  await db.query(`update public.pending_orders set status = 'filled', filled_at = now(), fill_price = 190.1643, terminal_reason = 'FILLED',
     confirmation_accepted_at = now(), fill_sizing = '{"lots":2.91,"riskUsdActual":498.67,"riskPercentActual":0.4987,"stopDistancePips":27.14,"insideFloor":false}'
     where order_id = 'dryA'`);
  const at = await attr(db, sig);
  assertEquals([at.terminal_status, at.fill_kind, Number(at.fill_lots), at.position_row_id], ["hypothetical_fill", "hypothetical", 2.91, null]);
  // the database refuses any position for it — entries locked AND dry-run
  const o = await orderBy(db, "dryA");
  await assertRejects(() => openPosition(db, { position_id: "x", order_id: "dryA", source_pending_order_id: o.id, signal_id: sig }));
  await db.query(`update public.paper_accounts set entries_locked = false where user_id = $1`, [USER]);
  await assertRejects(() => openPosition(db, { position_id: "x", order_id: "dryA", source_pending_order_id: o.id, signal_id: sig }), Error, "dry-run");
  // a real fill kind can never be written onto a dry-run attribution
  await assertRejects(() => db.query(`update public.trade_attribution set outcome_kind = 'real' where signal_id = $1`, [sig]));
  await db.close();
});

Deno.test("step 15 PR 2: a same-price refresh is an event; the attribution plan is untouched", async () => {
  const db = await freshDb();
  const a = attrPayload();
  const sig = a.signal_id as string;
  await place(db, a, orderRow({ order_id: "refA" }));
  const before = await planOf(db, sig);
  await db.query(`update public.pending_orders set stop_loss = 189.88, take_profit = 190.43, size = 3.10, signal_score = 64 where order_id = 'refA'`);
  assertEquals(await planOf(db, sig), before);
  const ev = (await events(db, sig)).find((e) => e.event_type === "refreshed_in_place")!;
  assertEquals([Number(ev.detail.old.stop), Number(ev.detail.new.stop), Number(ev.detail.old.size), Number(ev.detail.new.size)], [189.892885, 189.88, 3.16, 3.1]);
  // non-geometry updates (polls) add no events
  await db.query(`update public.pending_orders set last_touch_checked_at = now() where order_id = 'refA'`);
  assertEquals((await evTypes(db, sig)).filter((t: string) => t === "refreshed_in_place").length, 1);
  await db.close();
});

Deno.test("step 15 PR 2: supersede links both directions in one transaction", async () => {
  const db = await freshDb();
  const a1 = attrPayload(); const s1 = a1.signal_id as string;
  await place(db, a1, orderRow({ order_id: "supOld" }));
  const a2 = attrPayload({ limitPrice: 190.2 }); const s2 = a2.signal_id as string;
  const r = await place(db, a2, orderRow({ order_id: "supNew", entry_price: 190.2 }), [{ order_id: "supOld", cancel_reason: "Superseded by new setup (test)" }]);
  assertEquals([r.outcome, r.superseded], ["placed", ["supOld"]]);
  const old = await attr(db, s1); const neu = await attr(db, s2);
  assertEquals([old.terminal_status, old.superseded_by_signal_id, old.terminal_reason], ["superseded", s2, "CANCELLED_SUPERSEDED"]);
  assertEquals(neu.supersedes_signal_ids, [s1]);
  const oo = await orderBy(db, "supOld");
  assertEquals([oo.status, oo.terminal_reason, oo.cancel_reason, !!oo.resolved_at], ["cancelled", "CANCELLED_SUPERSEDED", "Superseded by new setup (test)", true]);
  assertEquals((await evTypes(db, s1)).at(-1), "superseded");
  // a legacy order (no signal_id) is superseded exactly as before; the new row simply links to nothing
  await db.query(`update public.pending_orders set status = 'cancelled' where order_id = 'supNew'`);
  await db.query(`insert into public.pending_orders (user_id, bot_id, order_id, symbol, direction, order_type, entry_price, current_price, stop_loss, take_profit, size, status, placed_at, expires_at)
                  values ($1, 'smc', 'legacyOld', 'CHF/JPY', 'long', 'limit', 190, 190.1, 189.7, 190.3, 1, 'pending', now(), now() + interval '8 hours')`, [USER]);
  const a3 = attrPayload(); const s3 = a3.signal_id as string;
  assertEquals((await place(db, a3, orderRow({ order_id: "afterLegacy" }), [{ order_id: "legacyOld", cancel_reason: "Superseded" }])).outcome, "placed");
  assertEquals((await orderBy(db, "legacyOld")).status, "cancelled");
  assertEquals((await attr(db, s3)).supersedes_signal_ids, []);
  await db.close();
});

Deno.test("step 15 PR 2: a re-detection of a live (armed) setup keeps the tracked identity; nothing new is created", async () => {
  const db = await freshDb();
  const a1 = attrPayload(); const s1 = a1.signal_id as string;
  await place(db, a1, orderRow({ order_id: "liveA" }));
  await db.query(`update public.pending_orders set status = 'awaiting_confirmation', zone_touch_time = now() where order_id = 'liveA'`);
  const before = await attr(db, s1);
  const a2 = attrPayload();
  const r = await place(db, a2, orderRow({ order_id: "dupB" }));
  assertEquals([r.outcome, r.existing_order_id, r.existing_signal_id], ["duplicate", "liveA", s1]);
  assertEquals(await count(db, `public.trade_attribution where signal_id = $1`, [a2.signal_id]), 0, "no orphan attribution");
  assertEquals(await count(db, `public.pending_orders where order_id = 'dupB'`), 0);
  assertEquals(JSON.stringify(await attr(db, s1)), JSON.stringify(before), "the tracked setup is untouched");
  // the decision for the re-detection links to the tracked setup
  await db.query(`insert into public.smc_scan_decision (scan_cycle_id, user_id, bot_id, symbol, signal_id) values (gen_random_uuid(), $1, 'smc', 'CHF/JPY', $2)`, [USER, r.existing_signal_id]);
  assertEquals(await count(db, `public.smc_scan_decision where signal_id = $1`, [s1]), 1);
  await db.close();
});

Deno.test("step 15 PR 2: cancellations and expiry record terminal attribution", async () => {
  const db = await freshDb();
  const cases: [string, Record<string, unknown>, string][] = [
    ["DIRECTION_FLIP", { status: "cancelled", terminal_reason: "CANCELLED_DIRECTION_FLIP", thesis_cancel_reason: "thesis_invalid:direction_flip" }, "invalidated"],
    ["IMPULSE", { status: "cancelled", terminal_reason: "CANCELLED_IMPULSE_BROKEN" }, "invalidated"],
    ["EXPIRED", { status: "expired", terminal_reason: "EXPIRED_NEVER_TOUCHED" }, "expired"],
    ["CAP", { status: "cancelled", terminal_reason: "CANCELLED_POSITION_CAP" }, "blocked_caps"],
    ["MANUAL", { status: "cancelled", cancel_reason: "user cancelled" }, "cancelled"],
  ];
  for (const [name, patch, expected] of cases) {
    const a = attrPayload({ symbol: `SYM${name}` }); const sig = a.signal_id as string;
    await place(db, a, orderRow({ order_id: `c${name}`, symbol: `SYM${name}` }));
    const sets = Object.keys(patch).map((k, i) => `${k} = $${i + 2}`).join(", ");
    await db.query(`update public.pending_orders set ${sets}, resolved_at = now() where order_id = $1`, [`c${name}`, ...Object.values(patch)]);
    const at = await attr(db, sig);
    assertEquals([at.terminal_status, at.fill_kind, at.closed_at], [expected, null, null], name);
    assert(at.terminal_at, name);
    // terminal is write-once: a later status change cannot rewrite it
    await db.query(`update public.pending_orders set status = 'expired' where order_id = $1`, [`c${name}`]);
    assertEquals((await attr(db, sig)).terminal_status, expected, `${name} stays`);
  }
  await db.close();
});

Deno.test("step 15 PR 2: legacy historical rows (no signal_id) still work through every lifecycle path", async () => {
  const db = await freshDb();
  // a pre-step-15 order, as it exists in production today
  await db.query(`insert into public.pending_orders (user_id, bot_id, order_id, symbol, direction, order_type, entry_price, current_price, stop_loss, take_profit, size, status, placed_at, expires_at)
                  values ($1, 'smc', 'legacyR', 'CHF/JPY', 'long', 'limit', 190, 190.1, 189.7, 190.3, 1, 'pending', now(), now() + interval '8 hours')`, [USER]);
  await db.query(`update public.pending_orders set status = 'awaiting_confirmation', zone_touch_time = now(), stop_loss = 189.8 where order_id = 'legacyR'`);
  await db.query(`update public.pending_orders set status = 'cancelled', terminal_reason = 'CANCELLED_ZONE_EXIT' where order_id = 'legacyR'`);
  const pid = await openPosition(db, { position_id: "legacyPos", order_id: "legacyPos" });
  assertEquals((await settle(db, pid, usdJpyClose())).outcome, "settled");
  assertEquals(await count(db, `public.trade_attribution`), 0);
  assertEquals(await count(db, `public.trade_attribution_events`), 0);
  await db.close();
});

Deno.test("step 15 PR 2 (fail closed): invalid attribution → NO new order, NO supersede cancel, nothing written", async () => {
  const db = await freshDb();
  const a0 = attrPayload(); const s0 = a0.signal_id as string;
  await place(db, a0, orderRow({ order_id: "liveOld" }));
  const bad = { ...attrPayload(), config_version: "not-a-hash" };
  const r = await place(db, bad, orderRow({ order_id: "badAttr" }), [{ order_id: "liveOld", cancel_reason: "Superseded" }]);
  assertEquals(r.outcome, "attribution_write_failed");
  assert(String(r.error).includes("config_version"), r.error);
  assertEquals(await count(db, `public.pending_orders where order_id = 'badAttr'`), 0, "no order");
  assertEquals(await count(db, `public.trade_attribution where signal_id = $1`, [bad.signal_id]), 0, "no attribution row");
  assertEquals((await orderBy(db, "liveOld")).status, "pending", "the order it would have superseded is still live");
  assertEquals((await attr(db, s0)).superseded_by_signal_id, null);
  // no attribution at all → refused too, nothing written
  const m = await place(db, null, orderRow({ order_id: "noAttr", symbol: "EUR/USD" }));
  assertEquals(m.outcome, "attribution_missing");
  assertEquals(await count(db, `public.pending_orders where order_id = 'noAttr'`), 0);
  assertEquals(await count(db, `public.pending_orders where signal_id is null and order_id in ('badAttr','noAttr')`), 0, "never an unattributed new order");
  await db.close();
});

Deno.test("step 15 PR 2 (fail closed): an attribution INSERT the database rejects → NO new order", async () => {
  const db = await freshDb();
  await db.exec(`create function public.ta_ins_boom() returns trigger language plpgsql as $$ begin raise exception 'attribution store unavailable'; end $$;
                 create trigger ta_ins_boom before insert on public.trade_attribution for each row execute function public.ta_ins_boom();`);
  const a = attrPayload();
  const r = await place(db, a, orderRow({ order_id: "insFail" }));
  assertEquals(r.outcome, "attribution_write_failed");
  assert(String(r.error).includes("attribution store unavailable"));
  assertEquals(await count(db, `public.pending_orders`), 0, "no order");
  // other errors (e.g. the entries lock) still surface as errors, exactly as an insert failure did
  await db.exec(`drop trigger ta_ins_boom on public.trade_attribution`);
  await db.query(`update public.paper_accounts set entries_locked = true where user_id = $1`, [USER]);
  await assertRejects(() => place(db, attrPayload(), orderRow({ order_id: "lockedReal", dry_run: false })), Error, "entries locked");
  assertEquals(await count(db, `public.pending_orders`), 0);
  await db.close();
});

Deno.test("step 15 PR 2 (fail open after placement): a failing attribution write never blocks cancel, fill, position or settlement", async () => {
  const db = await freshDb();
  // attribution UPDATE that errors: order cancel and position insert still go through
  const a = attrPayload(); const sig = a.signal_id as string;
  await place(db, a, orderRow({ order_id: "trgA", symbol: "EUR/USD" }));
  await db.exec(`create function public.ta_boom2() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$;
                 create trigger ta_boom2 before update on public.trade_attribution for each row execute function public.ta_boom2();`);
  await db.query(`update public.pending_orders set status = 'cancelled', terminal_reason = 'CANCELLED_DIRECTION_FLIP' where order_id = 'trgA'`);
  assertEquals((await orderBy(db, "trgA")).status, "cancelled");
  const pid = await openPosition(db, { position_id: "trgPos", order_id: "trgPos", signal_id: sig });
  assert(pid);
  await db.close();
});

Deno.test("step 15 PR 2: a position deleted without settlement is recorded, not lost", async () => {
  const db = await freshDb();
  const a = attrPayload(); const sig = a.signal_id as string;
  await place(db, a, orderRow({ order_id: "delA" }));
  await openPosition(db, { position_id: "delPos", order_id: "delA", signal_id: sig });
  await db.query(`delete from public.paper_positions where position_id = 'delPos'`);
  assertEquals((await evTypes(db, sig)).at(-1), "position_deleted_unsettled");
  await db.close();
});

Deno.test("step 15 PR 2 (fail open after placement): a real fill and its settlement go through even if every attribution write fails", async () => {
  const db = await freshDb();
  const a = attrPayload(); const sig = a.signal_id as string;
  await place(db, a, orderRow({ order_id: "fillOpen" }));
  await db.query(`update public.pending_orders set status = 'awaiting_confirmation', zone_touch_time = now(), confirmation_arm_count = 1 where order_id = 'fillOpen'`);
  // from here on every write to attribution AND its event log fails
  await db.exec(`create function public.ta_all_boom() returns trigger language plpgsql as $$ begin raise exception 'attribution down'; end $$;
                 create trigger ta_all_boom before update on public.trade_attribution for each row execute function public.ta_all_boom();
                 create trigger tae_all_boom before insert on public.trade_attribution_events for each row execute function public.ta_all_boom();`);
  const o = await orderBy(db, "fillOpen");
  const claim = (await db.query<{ r: any }>(`select public.route2_claim_and_fill($1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb) r`, [o.id, USER, 1,
    JSON.stringify({ terminal_reason: "FILLED", fill_price: 190.15, filled_at: new Date().toISOString(), confirmation_accepted_at: new Date().toISOString() }),
    JSON.stringify({ user_id: USER, bot_id: "smc", position_id: "posOpen", order_id: "fillOpen", symbol: "CHF/JPY", direction: "long", size: "1",
      entry_price: "190.15", current_price: "190.15", stop_loss: "189.892885", take_profit: "190.417885", open_time: new Date().toISOString(),
      signal_score: "60", position_status: "open", signal_id: sig })])).rows[0].r;
  assertEquals(claim.outcome, "filled", "fill not blocked");
  const pid = (await db.query<any>(`select id from public.paper_positions where position_id = 'posOpen'`)).rows[0].id;
  assertEquals((await settle(db, pid, { exit_price: 190.417885, pnl: 267, close_reason: "tp_hit" })).outcome, "settled", "settlement not blocked");
  assertEquals(await count(db, `public.paper_account_ledger where kind = 'close' and signal_id = $1`, [sig]), 1, "money moved, id still carried");
  await db.close();
});

// ─── Step 15 PR 3: hypothetical outcome functions ───────────────────────────

async function hypotheticalFill(db: Db, symbol = "GBP/USD") {
  await db.query(`update public.paper_accounts set entries_locked = true where user_id = $1`, [USER]);
  const a = attrPayload({ dryRun: true, symbol }); const sig = a.signal_id as string;
  await place(db, a, orderRow({ order_id: `h_${symbol}`, symbol, dry_run: true }));
  await db.query(`update public.pending_orders set status = 'filled', filled_at = '2026-10-07T18:22:01Z', fill_price = 1.32175, terminal_reason = 'FILLED',
     fill_sizing = '{"lots":2.49,"riskUsdActual":499.245,"riskPercentActual":0.4992}' where order_id = $1`, [`h_${symbol}`]);
  return sig;
}
const outcome = (over: Record<string, unknown> = {}) => JSON.stringify({ method: "bar_replay_5m.v1", exit_reason: "hypothetical_stop",
  exit_price: 189.892885, closed_at: "2026-10-07T20:00:00Z", r_gross: -1, r_net: -1.05, pnl_usd: -499.245, pnl_net_usd: -524.2, margin_pips: 2.1, ...over });

Deno.test("step 15 PR 3: the hypothetical close is written exactly once; a second call changes nothing", async () => {
  const db = await freshDb();
  const sig = await hypotheticalFill(db);
  assertEquals((await db.query<{ r: string }>(`select public.attribution_resolve_hypothetical($1, $2::jsonb) r`, [sig, outcome()])).rows[0].r, "resolved");
  const first = await attr(db, sig);
  assertEquals([first.outcome_kind, first.exit_reason, Number(first.realized_r_gross), Number(first.realized_pnl_usd), first.close_source],
               ["hypothetical", "hypothetical_stop", -1, -499.245, "attribution_outcome_resolver"]);
  const again = (await db.query<{ r: string }>(`select public.attribution_resolve_hypothetical($1, $2::jsonb) r`,
    [sig, outcome({ exit_reason: "hypothetical_target", r_gross: 1.6 })])).rows[0].r;
  assertEquals(again, "not_resolved");
  assertEquals(JSON.stringify(await attr(db, sig)), JSON.stringify(first), "write-once: unchanged");
  assertEquals((await evTypes(db, sig)).filter((t: string) => t === "outcome_resolved").length, 1);
  assertEquals(await count(db, `public.paper_positions`), 0, "no position");
  await db.close();
});

Deno.test("step 15 PR 3: only hypothetical fills can be resolved; never before the fill; only hypothetical exit reasons", async () => {
  const db = await freshDb();
  // a real (non-dry-run) attributed order with a recorded real fill
  const a = attrPayload(); const sig = a.signal_id as string;
  await place(db, a, orderRow({ order_id: "realH" }));
  await db.query(`update public.pending_orders set status = 'filled', filled_at = now(), fill_price = 190.15, terminal_reason = 'FILLED' where order_id = 'realH'`);
  assertEquals((await db.query<{ r: string }>(`select public.attribution_resolve_hypothetical($1, $2::jsonb) r`, [sig, outcome()])).rows[0].r, "not_resolved");
  const h = await hypotheticalFill(db, "EUR/USD");
  assertEquals((await db.query<{ r: string }>(`select public.attribution_resolve_hypothetical($1, $2::jsonb) r`, [h, outcome({ closed_at: "2026-10-07T18:00:00Z" })])).rows[0].r, "not_resolved", "closed before the fill");
  await assertRejects(() => db.query(`select public.attribution_resolve_hypothetical($1, $2::jsonb)`, [h, outcome({ exit_reason: "manual" })]), Error, "not a hypothetical outcome");
  await assertRejects(() => db.query(`select public.attribution_resolve_hypothetical($1, $2::jsonb)`, [h, outcome({ r_gross: null })]), Error, "required");
  await db.close();
});

Deno.test("step 15 PR 3: a deferral is recorded once per gap and stops once resolved; functions are service-role only", async () => {
  const db = await freshDb();
  const sig = await hypotheticalFill(db);
  for (let k = 0; k < 3; k++) {
    await db.query(`select public.attribution_defer_hypothetical($1, '2026-10-07T18:40:00Z', '{"reason":"missing 5m bar"}'::jsonb)`, [sig]);
  }
  await db.query(`select public.attribution_defer_hypothetical($1, '2026-10-07T19:10:00Z', '{"reason":"missing 5m bar"}'::jsonb)`, [sig]);
  assertEquals((await evTypes(db, sig)).filter((t: string) => t === "outcome_deferred_data_gap").length, 2, "one event per distinct gap");
  assertEquals((await attr(db, sig)).closed_at, null, "a deferral never writes an outcome");
  await db.query(`select public.attribution_resolve_hypothetical($1, $2::jsonb)`, [sig, outcome()]);
  assertEquals((await db.query<{ r: string }>(`select public.attribution_defer_hypothetical($1, now(), '{}'::jsonb) r`, [sig])).rows[0].r, "not_applicable");
  for (const role of ["anon", "authenticated"]) {
    for (const fn of ["public.attribution_resolve_hypothetical(uuid, jsonb)", "public.attribution_defer_hypothetical(uuid, timestamptz, jsonb)"]) {
      assertEquals((await db.query<{ ok: boolean }>(`select has_function_privilege($1, $2, 'execute') ok`, [role, fn])).rows[0].ok, false, `${role} ${fn}`);
    }
  }
  await db.close();
});


// ─── Step 16-D: real-exposure guard on balance resets (real Postgres) ───────

/** The paper-trading reset path: guard first (same rows readExposure fetches), then reset_paper_account. */
async function guardedReset(db: PGlite, amount = 100000) {
  const pos = (await db.query(`select id from public.paper_positions where user_id = $1`, [USER])).rows;
  const ord = (await db.query<{ status: string; dry_run: boolean | null }>(
    `select id, status, dry_run from public.pending_orders where user_id = $1 and status = any($2::text[])`,
    [USER, [...ACTIVE_ORDER_STATUSES]])).rows;
  const exposure = exposureFromRows(pos, ord);
  const refusal = resetRefusal(exposure);
  if (refusal) return { reset: false as const, refusal, exposure };
  const r = (await db.query<{ r: Record<string, unknown> }>(
    `select public.reset_paper_account($1::uuid, 'smc', $2, 'step16d test') as r`, [USER, amount])).rows[0].r;
  return { reset: r.code === "reset", exposure, r };
}
const snapshotAccount = async (db: PGlite) => JSON.stringify((await db.query(
  `select balance, peak_balance, daily_pnl_base, ledger_epoch_id, ledger_reset_at, is_paused from public.paper_accounts where user_id = $1`, [USER])).rows[0]);

Deno.test("step 16-D defect: a reset with a REAL position open is refused, so its close is credited in full — not posted as $0", async () => {
  const db = await freshDb({ balance: 104979.62 });
  const pos = await openPosition(db, { position_id: "chfjpy16", symbol: "CHF/JPY" });
  const before = await snapshotAccount(db);
  const ledgerBefore = await count(db, "public.paper_account_ledger");

  const g = await guardedReset(db);
  assertEquals(g.reset, false);
  if (g.reset) throw new Error("unreachable");
  assertEquals(g.refusal.code, "reset_refused_real_exposure");
  assertEquals(g.exposure, { openPositions: 1, activeRealOrders: 0, activeDryRunOrders: 0 });
  assertEquals(await snapshotAccount(db), before, "refusal: zero changes — same balance, peak, epoch");
  assertEquals(await count(db, "public.paper_account_ledger"), ledgerBefore, "no reset entry written");
  assertEquals(await count(db, "public.paper_positions"), 1, "the position is not deleted");

  // the position then closes normally inside the CURRENT epoch: full P/L, not pre-epoch
  const r = await settle(db, pos, { exit_price: 180.0, pnl: -558.4, close_reason: "sl_hit" });
  assertEquals(r.outcome, "settled");
  if (r.outcome !== "settled") throw new Error("unreachable");
  assertEquals(r.preEpoch, false, "not a pre-epoch close");
  assertEquals(r.amount, -558.4, "the loss is credited, not $0");
  assertEquals(await balance(db), 104979.62 - 558.4);

  // now flat → the same reset proceeds exactly as before (new epoch, balance set)
  const g2 = await guardedReset(db);
  assertEquals(g2.reset, true);
  assertEquals(await balance(db), 100000);
  await db.close();
});

Deno.test("step 16-D: an active REAL order (pending or armed) refuses the reset; nothing changes", async () => {
  for (const status of ["pending", "awaiting_confirmation"]) {
    const db = await freshDb();
    await insertPending(db, pendingRow({ status, dry_run: false }));
    const before = await snapshotAccount(db);
    const g = await guardedReset(db, 50000);
    assertEquals(g.reset, false, status);
    assertEquals(g.exposure, { openPositions: 0, activeRealOrders: 1, activeDryRunOrders: 0 });
    assertEquals(await snapshotAccount(db), before, `${status}: zero changes`);
    assertEquals(await count(db, "public.pending_orders where status = $1", [status]), 1, "the order is untouched");
    await db.close();
  }
});

Deno.test("step 16-D: dry-run orders alone do NOT block; the reset proceeds as before and the dry-run orders are left running", async () => {
  const db = await freshDb();
  await db.query(`update public.paper_accounts set entries_locked = true where user_id = $1`, [USER]);
  const a = await insertPending(db, pendingRow({ symbol: "EUR/USD", dry_run: true }));
  const b = await insertPending(db, pendingRow({ symbol: "GBP/USD", dry_run: true, status: "awaiting_confirmation" }));
  const epochBefore = (await db.query<{ e: string }>(`select ledger_epoch_id e from public.paper_accounts where user_id = $1`, [USER])).rows[0].e;
  const g = await guardedReset(db, 100000);
  assertEquals(g.reset, true);
  assertEquals(g.exposure, { openPositions: 0, activeRealOrders: 0, activeDryRunOrders: 2 });
  const epochAfter = (await db.query<{ e: string }>(`select ledger_epoch_id e from public.paper_accounts where user_id = $1`, [USER])).rows[0].e;
  assert(epochAfter !== epochBefore, "a new ledger epoch, exactly as a flat reset does today");
  const st = (await db.query<{ id: string; status: string }>(`select id, status from public.pending_orders where id = any($1::uuid[]) order by symbol`, [[a, b]])).rows;
  assertEquals(st.map((x) => x.status), ["pending", "awaiting_confirmation"], "dry-run orders not cancelled");
  await db.close();
});

Deno.test("step 16-D: mixed real + dry-run exposure refuses; a flat account (only terminal orders) resets as today", async () => {
  const db = await freshDb();
  await insertPending(db, pendingRow({ symbol: "USD/JPY", dry_run: false, entry_price: 158, current_price: 158.1, stop_loss: 157.75, take_profit: 158.5 }));
  await db.query(`update public.paper_accounts set entries_locked = true where user_id = $1`, [USER]);
  await insertPending(db, pendingRow({ symbol: "EUR/USD", dry_run: true }));
  const g = await guardedReset(db);
  assertEquals([g.reset, g.exposure], [false, { openPositions: 0, activeRealOrders: 1, activeDryRunOrders: 1 }]);

  const flat = await freshDb({ balance: 98000 });
  await insertPending(flat, pendingRow({ status: "cancelled", dry_run: false }));
  const g2 = await guardedReset(flat, 100000);
  assertEquals(g2.reset, true);
  assertEquals([await balance(flat), await peak(flat)], [100000, 100000]);
  await db.close(); await flat.close();
});

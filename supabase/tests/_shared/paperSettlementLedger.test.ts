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

const read = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url));
const BASELINE = read("../../migrations/20260914000000_baseline_schema.sql");
const FREEZE_FIX = read("../../migrations/20260916010000_history_insert_ignores_foreign_contract.sql");
const TELEMETRY = read("../../migrations/20260928140000_smc_trade_telemetry_parity.sql");
const MIGRATION_TIMESTAMPS = read("../../migrations/20261006000000_trade_history_timestamps.sql");
const MIGRATION_LEDGER = read("../../migrations/20261006010000_paper_settlement_ledger.sql");
const MIGRATION_MONITOR = read("../../migrations/20261006020000_settlement_monitor_runs.sql");

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
    create function auth.role() returns text language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
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
  return db;
}

async function applyMigrations(db: PGlite) {
  await db.exec(MIGRATION_TIMESTAMPS);
  await db.exec(MIGRATION_LEDGER);
  await db.exec(MIGRATION_MONITOR);
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
  await db.exec(`reset session authorization`);
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
  await assertRejects(() => db.query(`truncate public.paper_account_ledger`), Error, "append-only");
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
  await db.exec(`reset session authorization`);
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

Deno.test("every column the settlement-monitor function selects exists", async () => {
  const db = await freshDb();
  const src = Deno.readTextFileSync(new URL("../../functions/settlement-monitor/index.ts", import.meta.url));
  for (const m of src.matchAll(/from\("([a-z_]+)"\)\s*\n?\s*\.select\("([^"]+)"\)/g)) {
    const [, table, list] = m;
    const cols = new Set((await db.query<{ c: string }>(
      `select column_name as c from information_schema.columns where table_schema in ('public') and table_name = $1`, [table])).rows.map((r) => r.c));
    if (cols.size === 0) continue; // tables outside this harness (user_settings, close_audit_log)
    for (const c of list.split(",").map((x) => x.trim())) assert(cols.has(c), `${table}.${c} missing`);
  }
  await db.close();
});

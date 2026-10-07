import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PGlite } from "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist/index.js";
const R = new URL("../../supabase/migrations/", import.meta.url).pathname;
const BASE = Deno.readTextFileSync(R + "20260914000000_baseline_schema.sql");
const ddl = (t: string) => { const i = BASE.indexOf(`CREATE TABLE IF NOT EXISTS public.${t} (`); return BASE.slice(i, BASE.indexOf("\n);", i) + 3); };
const MIG = Deno.readTextFileSync(new URL("./PROPOSED_full_design_trade_attribution.sql", import.meta.url).pathname);
const LEDGER = Deno.readTextFileSync(R + "20261006010000_paper_settlement_ledger.sql");
const DIST = "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist";
async function db() {
  const a = { wasmModule: await WebAssembly.compile(await (await fetch(`${DIST}/postgres.wasm`)).arrayBuffer()), fsBundle: await (await fetch(`${DIST}/postgres.data`)).blob() };
  const g = globalThis as any; const d = Object.getOwnPropertyDescriptor(g, "process");
  Object.defineProperty(g, "process", { value: undefined, configurable: true, writable: true });
  try { const x = new PGlite(a); await x.waitReady; return x; } finally { if (d) Object.defineProperty(g, "process", d); else delete g.process; }
}
const U = "57c79dee-db6b-4fae-b34a-4b64ce33ca34";
Deno.test({ name: "step 15 migration runs, guards hold", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const x = await db();
  await x.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    create function auth.role() returns text language sql stable as $$ select 'service_role' $$;
    ${ddl("paper_accounts")} ${ddl("paper_positions")} ${ddl("pending_orders")} ${ddl("paper_trade_history")} ${ddl("bot_configs")} ${ddl("bot_config_change_log")}
    alter table public.paper_positions add constraint pp_pk primary key (id);
    alter table public.pending_orders add constraint po_pk primary key (id);
    alter table public.paper_trade_history add constraint pth_pk primary key (id);
    alter table public.paper_accounts add constraint pa_pk primary key (id);
`);
  const SD = Deno.readTextFileSync(R + "20260925210000_smc_scan_decision_observability.sql");
  const si = SD.search(/create table (if not exists )?public\.smc_scan_decision \(/i);
  await x.exec(SD.slice(si, SD.indexOf("\n);", si) + 3));
  // the ledger table only (first CREATE TABLE in the settlement migration)
  const li = LEDGER.indexOf("CREATE TABLE IF NOT EXISTS public.paper_account_ledger (");
  await x.exec(LEDGER.slice(li, LEDGER.indexOf("\n);", li) + 3));
  await x.exec(`alter table public.pending_orders add column if not exists dry_run boolean not null default false, add column if not exists dry_run_context jsonb, add column if not exists confirmation_accepted_at timestamptz, add column if not exists confirmation_tier int, add column if not exists confirmation_type text, add column if not exists confirmation_timeframe text, add column if not exists zone_touch_time timestamptz, add column if not exists reset_reason text, add column if not exists thesis_cancel_reason text, add column if not exists terminal_reason text, add column if not exists resolved_at timestamptz, add column if not exists filled_at timestamptz, add column if not exists fill_price numeric, add column if not exists signal_score numeric;`);
  await x.exec(MIG); await x.exec(MIG); // idempotent
  // canonical hash = md5(config_json::text), same as the change-log trigger
  await x.query(`insert into public.bot_configs (user_id, config_json) values ($1, '{"b": 2, "a": {"x": [1, 2]}}')`, [U]);
  const h = (await x.query<any>(`select config_version, md5(config_json::text) m from public.bot_configs`)).rows[0];
  assertEquals(h.config_version, h.m);
  const sig = crypto.randomUUID();
  const base = `insert into public.trade_attribution (signal_id,user_id,bot_id,symbol,direction,dry_run,scan_cycle_id,decision_id,decision_at,config_version,strategy_version,sizing_version,stop_version,management_version,caps_version,route,primary_engine,primary_engine_rule,game_plan,impulse,unified,score,gates,legacy_would_admit,limit_price,stop_price,stop_source,stop_distance_pips,target_price,raw_rr,effective_rr,intended_risk_pct,intended_risk_usd)
    values ($1,'${U}','smc','CHF/JPY','long',true,gen_random_uuid(),gen_random_uuid(),now(),'${h.m}','v','fill_time_v1','route2_limit_anchor_v1','none_v1','unified_3_1','route2_pending_confirmation','impulse_zone','r1','{}','{}','{}','{}','[]',false,190.142885,189.892885,'floor',25,190.417885,1.1,1.0,0.5,500)`;
  await x.query(base, [sig]);
  // order insert → E via trigger
  await x.query(`insert into public.pending_orders (user_id,order_id,symbol,direction,order_type,entry_price,current_price,stop_loss,take_profit,size,status,placed_at,expires_at,dry_run,signal_id,bot_id) values ($1,'77134ab8','CHF/JPY','long','limit',190.142885,190.2,189.892885,190.417885,3.16,'pending',now(),now()+interval '8h',true,$2,'smc')`, [U, sig]);
  let r = (await x.query<any>(`select order_id, order_placed_at is not null p from public.trade_attribution where signal_id=$1`, [sig])).rows[0];
  assertEquals([r.order_id, r.p], ["77134ab8", true]);
  // same-price refresh → event, plan unchanged
  await x.query(`update public.pending_orders set stop_loss=189.88, size=3.1 where order_id='77134ab8'`);
  const ev = (await x.query<any>(`select event_type from public.trade_attribution_events where signal_id=$1 order by id`, [sig])).rows.map((e: any) => e.event_type);
  assertEquals(ev, ["order_inserted", "refreshed_in_place"]);
  assertEquals(Number((await x.query<any>(`select stop_price from public.trade_attribution where signal_id=$1`, [sig])).rows[0].stop_price), 189.892885);
  // immutable + write-once
  await assertRejects(() => x.query(`update public.trade_attribution set stop_price=1 where signal_id=$1`, [sig]));
  await assertRejects(() => x.query(`update public.trade_attribution set order_id='zzz' where signal_id=$1`, [sig]));
  await assertRejects(() => x.query(`delete from public.trade_attribution where signal_id=$1`, [sig]));
  // touch, confirm, hypothetical fill via the order row
  await x.query(`update public.pending_orders set status='awaiting_confirmation', zone_touch_time=now() where order_id='77134ab8'`);
  await x.query(`update public.pending_orders set status='filled', filled_at=now(), fill_price=190.1643, confirmation_accepted_at=now(), confirmation_tier=3, terminal_reason='FILLED',
     dry_run_context='{"fillSizing":{"lots":2.91,"uncappedLots":2.9177,"riskUsdActual":498.67,"riskPercentActual":0.4987}}' where order_id='77134ab8'`);
  r = (await x.query<any>(`select terminal_status, fill_kind, fill_lots, touched_at is not null t, confirmed_at is not null c from public.trade_attribution where signal_id=$1`, [sig])).rows[0];
  assertEquals([r.terminal_status, r.fill_kind, Number(r.fill_lots), r.t, r.c], ["hypothetical_fill", "hypothetical", 2.91, true, true]);
  // hypothetical outcome, once
  const o = { method: "bar_replay_5m.v1", closed_at: new Date().toISOString(), exit_price: 189.892885, exit_reason: "hypothetical_stop", pnl_usd: -498.67, r_gross: -1, r_net: -1.09 };
  assertEquals((await x.query<any>(`select public.attribution_resolve_hypothetical($1,$2::jsonb) r`, [sig, JSON.stringify(o)])).rows[0].r, "resolved");
  assertEquals((await x.query<any>(`select public.attribution_resolve_hypothetical($1,$2::jsonb) r`, [sig, JSON.stringify(o)])).rows[0].r, "already_resolved_or_not_hypothetical");
  // supersede: new row first, link, then cancel old
  const s2 = crypto.randomUUID(), s3 = crypto.randomUUID();
  await x.query(base, [s2]);
  await x.query(`insert into public.pending_orders (user_id,order_id,symbol,direction,order_type,entry_price,current_price,stop_loss,take_profit,size,status,placed_at,expires_at,dry_run,signal_id,bot_id) values ($1,'old1','CHF/JPY','long','limit',1,1,0.9,1.1,1,'pending',now(),now(),true,$2,'smc')`, [U, s2]);
  await x.query(base.replace("supersedes_signal_ids", "supersedes_signal_ids"), [s3]);
  await x.query(`update public.trade_attribution set superseded_by_signal_id=$2 where signal_id=$1`, [s2, s3]);
  await x.query(`update public.pending_orders set status='cancelled', terminal_reason='CANCELLED_SUPERSEDED' where order_id='old1'`);
  r = (await x.query<any>(`select terminal_status, superseded_by_signal_id from public.trade_attribution where signal_id=$1`, [s2])).rows[0];
  assertEquals([r.terminal_status, r.superseded_by_signal_id], ["superseded", s3]);
  // signal_id immutable on lifecycle rows
  await assertRejects(() => x.query(`update public.pending_orders set signal_id=$1 where order_id='old1'`, [s3]));
  await x.close();
}});

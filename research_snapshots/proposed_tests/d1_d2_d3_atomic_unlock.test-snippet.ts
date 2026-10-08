// D1 / D2 / D3 / atomic-unlock checks (2026-10-08), as run: appended to the END of
// supabase/tests/_shared/paperSettlementLedger.test.ts (uses its freshDb, functionDdl, place, attrPayload,
// orderRow, orderBy, USER). Reads the proposed SQL from research_snapshots/. Result: 55/55 PASS (revised D2).
// Harness notes: service_role gets production-like grants + BYPASSRLS; clients run under SET LOCAL SESSION AUTHORIZATION (PostgREST's session_user is
// 'authenticator', never 'postgres'); PGlite needs an explicit `set session authorization postgres` after.

Deno.test("TEMP D1/D2/D3 + atomic unlock", async () => {
  const P = "/Users/akpedoemichael/Projects/connect-assist/research_snapshots/";
  const D1 = Deno.readTextFileSync(P + "proposed_migrations/20261009020000_d1_revoke_legacy_exposure_rpcs.sql");
  const D2 = Deno.readTextFileSync(P + "proposed_migrations/20261009030000_d2_d3_real_exposure_admission.sql");
  const T = "99914b932bd37a50b983c5e7c90ae93b";
  const un = Deno.readTextFileSync(P + "UNLOCK_ATOMIC_AT_ZERO_DRY.sql").replaceAll("1037e6170289f865e4d6618dcf28b94d", T);
  const unTx = un.slice(0, un.lastIndexOf("\nselect "));
  const rl = Deno.readTextFileSync(P + "RELOCK_IMMEDIATE.sql");
  const LEGACY = ["finalize_market_entry", "finalize_pending_order_fill", "finalize_live_broker_position", "retarget_pending_to_impulse_candidate"];
  const SIG: Record<string, string> = {
    finalize_market_entry: "public.finalize_market_entry(uuid,text,text,jsonb,jsonb,integer,integer,boolean,boolean)",
    finalize_pending_order_fill: "public.finalize_pending_order_fill(uuid,uuid,text,numeric,numeric,text,jsonb,text,jsonb,integer,integer,boolean)",
    finalize_live_broker_position: "public.finalize_live_broker_position(uuid,text,text)",
    retarget_pending_to_impulse_candidate: "public.retarget_pending_to_impulse_candidate(uuid,uuid,text)" };
  const ord = (oid: string, dry: boolean, bot = "smc", sym = "EUR/USD", dir = "long", status = "pending") => `insert into public.pending_orders (user_id, bot_id, order_id, symbol, direction, order_type, entry_price, current_price, stop_loss, take_profit, status, expires_at, dry_run)
    values ('${USER}', '${bot}', '${oid}', '${sym}', '${dir}', 'limit', 1.1, 1.101, 1.098, 1.1022, '${status}', now() + interval '8 hours', ${dry}) returning id`;
  const manual = (pid: string) => `insert into public.paper_positions (user_id, position_id, symbol, direction, size, frozen_strategy_context, entry_price, current_price, stop_loss, take_profit, open_time, signal_reason, signal_score, order_id, position_status)
    values ('${USER}', '${pid}', 'EUR/USD', 'long', '1', null, '1.1', '1.1', '1.098', '1.1022', now(), '', '0', 'm${pid}', 'open') returning id`;
  const srvPos = (pid: string, bot = "smc") => `insert into public.paper_positions (user_id, bot_id, position_id, order_id, symbol, direction, size, entry_price, stop_loss, take_profit, current_price, open_time, signal_score)
    values ('${USER}', '${bot}', '${pid}', '${pid}', 'USD/JPY', 'long', 1, 154.9, 154.69, 155.5, 155.5, now(), '46') returning id`;
  const as = async (db: any, role: "authenticated" | "service_role" | "anon", sql: string, params: unknown[] = []) => {
    await db.exec(`begin; set local session authorization ${role}; select set_config('request.jwt.claim.sub', '${role === "service_role" ? "" : USER}', true);
      select set_config('request.jwt.claims', '{"role":"${role}"${role === "service_role" ? "" : `,"sub":"${USER}"`}}', true);`);
    let err = "", rows: any[] = []; try { rows = (await db.query(sql, params)).rows; } catch (e) { err = (e as Error).message; }
    await db.exec(err ? "rollback" : "commit"); await db.exec("set session authorization postgres"); return { err, rows };
  };
  const run = async (db: any, sql: string) => { let m = ""; try { await db.exec(sql); } catch (e) { m = (e as Error).message; } await db.exec("rollback").catch(() => {}); return m; };
  let fails = 0; const ok = (c: boolean, m: string) => { console.log(c ? "  PASS" : "  FAIL", m); if (!c) fails++; };
  const mk = async (opts: { d1?: boolean; d2?: boolean } = {}) => {
    const db = await freshDb();
    await db.query(`select public.reset_paper_account('${USER}', 'smc', 100000, 'harness reset baseline')`);
    await db.exec(`update public.paper_ledger_guard set mode = 'enforce' where id = 1;
      update public.paper_accounts set is_paused = true, entries_locked = true where user_id = '${USER}';
      insert into public.bot_configs (id, user_id, config_json) values ('327912ae-4e5b-4677-ad04-7c5d566f7990', '${USER}', '{}'::jsonb);
      grant all on public.pending_orders to anon, authenticated, service_role;
      grant all on all tables in schema public to service_role; grant usage on schema public to service_role;
      alter role service_role bypassrls;`); // Supabase: service_role has BYPASSRLS // production baseline grants
    await db.exec(`set check_function_bodies = off`);
    for (const f of LEGACY) await db.exec(functionDdl(f) + `\nGRANT EXECUTE ON FUNCTION ${SIG[f]} TO PUBLIC, anon, authenticated, service_role;`); // production defaults
    await db.exec(`set check_function_bodies = on`);
    if (opts.d1) await db.exec(D1);
    if (opts.d2) await db.exec(D2);
    return db;
  };
  const priv = async (db: any) => (await db.query(`select ${LEGACY.map((f) => `has_function_privilege('anon', '${SIG[f]}', 'execute') or has_function_privilege('authenticated', '${SIG[f]}', 'execute') as ${f}`).join(", ")}`)).rows[0] as Record<string, boolean>;

  // ── D1 ──
  { const db = await mk();
    ok(Object.values(await priv(db)).every((v) => v === true), "D1 before: anon/authenticated CAN execute all four legacy SECURITY DEFINER exposure RPCs (the production state)");
    await db.exec(D1);
    const after = await priv(db);
    const svc = (await db.query(`select ${LEGACY.map((f) => `has_function_privilege('service_role', '${SIG[f]}', 'execute') as ${f}`).join(", ")}`)).rows[0] as Record<string, boolean>;
    const cfg = (await db.query(`select bool_and(prosecdef and proconfig @> array['search_path=public']) ok from pg_proc where oid in (${LEGACY.map((f) => `'${SIG[f]}'::regprocedure`).join(",")})`)).rows[0] as any;
    ok(Object.values(after).every((v) => v === false) && Object.values(svc).every((v) => v === true) && cfg.ok === true,
       "D1 after: no anon/authenticated/PUBLIC EXECUTE on any of the four; service_role keeps it; SECURITY DEFINER + search_path=public unchanged");
    const call = await as(db, "authenticated", `select public.finalize_live_broker_position('${USER}', 'smc', 'x')`);
    const callAnon = await as(db, "anon", `select public.retarget_pending_to_impulse_candidate(gen_random_uuid(), '${USER}', 'smc')`);
    ok(call.err.includes("permission denied") && callAnon.err.includes("permission denied"), `D1: client calls refused (${call.err.slice(0, 40)} / ${callAnon.err.slice(0, 40)})`);
    ok((await run(db, D1)) === "", "D1 is re-runnable (idempotent)");
    await db.close(); }
  { const db = await mk(); await db.exec(`alter function ${SIG.finalize_market_entry} reset search_path`);
    const m = await run(db, D1); ok(m.startsWith("D1_ABORTED"), `D1 precheck aborts on an unexpected function config: ${m.slice(0, 70)}`); await db.close(); }

  // ── D3 reproduction (17-C only, no D2): a real exposure row under a bot id with no account bypasses the locked account ──
  { const db = await mk({ d1: true });
    const p = await as(db, "service_role", srvPos("ghostpos", "ghost"));
    const o = await as(db, "service_role", ord("ghostord", false, "ghost"));
    const c = await as(db, "authenticated", manual("cl0").replace("(user_id, position_id", "(user_id, bot_id, position_id").replace(`'${USER}', 'cl0'`, `'${USER}', 'ghost', 'cl0'`));
    ok(p.err === "" && o.err === "" && c.err === "", `D3 REPRODUCED while the SMC account is LOCKED: server ghost-bot position ${p.err ? "refused" : "CREATED"}, real ghost-bot order ${o.err ? "refused" : "CREATED"}, client ghost-bot position ${c.err ? "refused" : "CREATED"}`);
    await db.close(); }

  // ── D2 + D3 ──
  const db = await mk({ d1: true, d2: true });
  // locked: experiment path
  ok((await as(db, "service_role", ord("dry1", true, "smc", "GBP/USD"))).err === "", "dry-run experiment: server dry-run order placed while locked");
  const place1s = await as(db, "service_role", `select public.route2_place_order($1::jsonb, $2::jsonb, '[]'::jsonb) r`, [JSON.stringify(attrPayload({ dryRun: true, symbol: "CHF/JPY" })), JSON.stringify(orderRow({ dry_run: true, order_id: "rpcdry" }))]);
  const place1 = place1s.err ? { outcome: place1s.err } : place1s.rows[0].r;
  const dryUpd = await as(db, "service_role", `update public.pending_orders set status = 'awaiting_confirmation', zone_touch_time = now() where order_id = 'rpcdry'`);
  ok(dryUpd.err === "", `dry-run experiment: server hunt update of a dry-run order while locked ✓ ${dryUpd.err}`);
  ok(place1.outcome === "placed", `dry-run experiment: route2_place_order as service_role while locked: ${place1.outcome}`);
  ok((await as(db, "service_role", ord("lockedreal", false, "smc", "NZD/CAD"))).err.includes("entries locked"), "locked: server real order still refused by the entries lock");
  // D3 closed
  ok((await as(db, "service_role", srvPos("ghostpos2", "ghost"))).err.includes("needs a paper account"), "D3: server real position under a bot id with no account → refused");
  ok((await as(db, "service_role", ord("ghostord2", false, "ghost"))).err.includes("needs a paper account"), "D3: server real order under a bot id with no account → refused");
  // unlock (atomic) — needs zero dry-run orders
  await db.exec(`update public.pending_orders set status = 'expired', terminal_reason = 'EXPIRED_NEVER_TOUCHED' where dry_run`);
  let m = await run(db, unTx); ok(m === "", `atomic unlock succeeds with D1 + D2 in place and zero dry-run orders: ${m}`);
  // D2 after unlock: client cannot create / activate; legitimate client updates and close still work
  ok((await as(db, "authenticated", manual("cl1"))).err.includes("server-only"), "D2: client manual place_order (exact column set) → refused, even unlocked");
  ok((await as(db, "authenticated", ord("cl2", false, "smc", "USD/JPY", "short"))).err.match(/permission denied|server-only/) !== null, "D2: client real pending order → refused");
  ok((await as(db, "authenticated", ord("cl3", true, "smc", "NZD/CHF"))).err.match(/permission denied|server-only/) !== null, "D2: client dry-run order → refused (could absorb real setups)");
  const rOrd = (await as(db, "service_role", ord("real1", false, "smc", "USD/JPY", "short"))); ok(rOrd.err === "", `after unlock: server real strategy order placed ${rOrd.err}`);
  const place2 = await place(db, attrPayload({ symbol: "CHF/JPY" }), orderRow({ order_id: "rpcreal" }));
  ok(place2.outcome === "placed", `after unlock: route2_place_order real order placed: ${place2.outcome}`);
  await db.query(`update public.pending_orders set status = 'cancelled', terminal_reason = 'CANCELLED_ZONE_EXIT' where order_id = 'real1'`);
  ok((await as(db, "authenticated", `update public.pending_orders set status = 'pending' where order_id = 'real1'`)).err.match(/permission denied|server-only/) !== null, "D2: client re-activation cancelled → pending → refused");
  ok((await as(db, "authenticated", `update public.pending_orders set status = 'triggered' where order_id = 'real1'`)).err.match(/permission denied|server-only/) !== null, "D2: client re-activation cancelled → triggered → refused");
  // Route 2 fill by the server (claim RPC)
  const o = await orderBy(db, "rpcreal");
  await db.query(`update public.pending_orders set status = 'awaiting_confirmation', zone_touch_time = now(), confirmation_arm_count = 1 where order_id = 'rpcreal'`);
  const claim = (await db.query<{ r: any }>(`select public.route2_claim_and_fill($1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb) r`, [o.id, USER, 1,
    JSON.stringify({ terminal_reason: "FILLED", fill_price: 190.1643, filled_at: new Date().toISOString(), resolved_at: new Date().toISOString() }),
    JSON.stringify({ user_id: USER, bot_id: "smc", position_id: "posR", order_id: "rpcreal", symbol: "CHF/JPY", direction: "long", size: "2.91",
      entry_price: "190.1643", current_price: "190.1643", stop_loss: "189.892885", take_profit: "190.417885", open_time: new Date().toISOString(), signal_score: "61.6", position_status: "open" })])).rows[0].r;
  ok(claim.outcome === "filled", `Route 2 fill (route2_claim_and_fill, server) still creates the position: ${claim.outcome}`);
  // legitimate client flows on the position: price refresh, SL/TP edit, manual close (settle RPC)
  const upd = await as(db, "authenticated", `update public.paper_positions set current_price = '190.2', stop_loss = '189.95' where position_id = 'posR' returning id`);
  ok(upd.err === "" && upd.rows.length === 1, `client position UPDATE (status refresh / update_position SL-TP edit) still allowed ${upd.err}`);
  const pid = (await db.query<any>(`select id from public.paper_positions where position_id = 'posR'`)).rows[0].id;
  const st = await as(db, "authenticated", `select public.settle_paper_position($1, '${USER}', 'smc', '{"exit_price":190.2,"pnl":166.2,"close_reason":"manual"}'::jsonb, 'paper_trading_manual_close') r`, [pid]);
  ok(st.err === "" && st.rows[0].r.code === "settled", `client manual close via settle_paper_position still works: ${st.err || st.rows[0].r.code}`);
  // ── revised D2: pending_orders read-only for clients ──
  await db.query(`update public.pending_orders set status = 'awaiting_confirmation', zone_touch_time = now(), confirmation_arm_count = 1 where order_id = 'real1'`).catch(() => {});
  const act = await as(db, "service_role", ord("act1", false, "smc", "GBP/USD", "long"));
  ok(act.err === "", `service_role INSERT real order (after unlock) ${act.err}`);
  const act2 = await as(db, "service_role", ord("act2", false, "smc", "NZD/CAD", "short"));
  await as(db, "service_role", `update public.pending_orders set status = 'awaiting_confirmation', zone_touch_time = now(), confirmation_arm_count = 1 where order_id = 'act2'`);
  const before = JSON.stringify((await db.query(`select * from public.pending_orders where order_id in ('act1','act2') order by order_id`)).rows);
  for (const [label, sql] of [
    ["insert", ord("cl9", false, "smc", "EUR/USD", "short")],
    ["entry_price", `update public.pending_orders set entry_price = 1.2 where order_id = 'act1'`],
    ["stop_loss", `update public.pending_orders set stop_loss = 1.05 where order_id = 'act1'`],
    ["take_profit", `update public.pending_orders set take_profit = 1.3 where order_id = 'act1'`],
    ["direction", `update public.pending_orders set direction = 'short' where order_id = 'act1'`],
    ["symbol", `update public.pending_orders set symbol = 'USD/JPY' where order_id = 'act1'`],
    ["size", `update public.pending_orders set size = 50 where order_id = 'act1'`],
    ["expires_at", `update public.pending_orders set expires_at = now() + interval '30 days' where order_id = 'act1'`],
    ["pending → awaiting_confirmation", `update public.pending_orders set status = 'awaiting_confirmation' where order_id = 'act1'`],
    ["awaiting_confirmation → pending", `update public.pending_orders set status = 'pending' where order_id = 'act2'`],
    ["active → cancelled", `update public.pending_orders set status = 'cancelled' where order_id = 'act1'`],
    ["dry_run flag", `update public.pending_orders set dry_run = true where order_id = 'act1'`],
    ["delete", `delete from public.pending_orders where order_id = 'act1'`],
  ] as [string, string][]) {
    const r = await as(db, "authenticated", sql);
    ok(/permission denied|server-only/.test(r.err), `D2 client ${label} → refused (${r.err.slice(0, 50)})`);
  }
  const anonW = await as(db, "anon", `update public.pending_orders set stop_loss = 1.05 where order_id = 'act1'`);
  ok(anonW.err.includes("permission denied"), `D2 anon update → refused (${anonW.err.slice(0, 40)})`);
  ok(JSON.stringify((await db.query(`select * from public.pending_orders where order_id in ('act1','act2') order by order_id`)).rows) === before, "D2: both active orders byte-identical after every client attempt");
  const sel = await as(db, "authenticated", `select order_id from public.pending_orders where order_id in ('act1','act2')`);
  ok(sel.err === "" && sel.rows.length === 2, `D2 client SELECT own pending orders still works (${sel.rows.length} rows)`);
  // defence in depth: a SECURITY DEFINER function a client can call bypasses table privileges — the row trigger still refuses
  await db.exec(`create function public.tmp_definer_bypass() returns void language sql security definer as $$ update public.pending_orders set stop_loss = 1.0 where order_id = 'act1' $$;
    grant execute on function public.tmp_definer_bypass() to authenticated;`);
  const byp = await as(db, "authenticated", `select public.tmp_definer_bypass()`);
  ok(byp.err.includes("server-only"), `D2 depth: client via a SECURITY DEFINER function → refused by the row trigger (${byp.err.slice(0, 50)})`);
  await db.exec(`drop function public.tmp_definer_bypass()`);
  // server paths: scanner-style updates, cancel, delete — as service_role
  for (const [label, sql] of [
    ["touch (pending → awaiting, arm)", `update public.pending_orders set status = 'awaiting_confirmation', zone_touch_time = now(), confirmation_arm_count = 1 where order_id = 'act1'`],
    ["reset (awaiting → pending)", `update public.pending_orders set status = 'pending', reset_reason = 'zone_exit' where order_id = 'act1'`],
    ["same-level refresh (score/price/SL/TP/size)", `update public.pending_orders set signal_score = 70, current_price = 1.1005, stop_loss = 1.0975, take_profit = 1.1025, size = 2 where order_id = 'act1'`],
    ["supersede / cancel", `update public.pending_orders set status = 'cancelled', terminal_reason = 'CANCELLED_SUPERSEDED', cancel_reason = 'Superseded', resolved_at = now() where order_id = 'act1'`],
    ["expire", `update public.pending_orders set status = 'expired', terminal_reason = 'EXPIRED_AFTER_TOUCH_NO_CONFIRMATION', resolved_at = now() where order_id = 'act2'`],
    ["delete (cleanup)", `delete from public.pending_orders where order_id = 'act2'`],
  ] as [string, string][]) {
    const r = await as(db, "service_role", sql);
    ok(r.err === "", `server ${label} ✓ ${r.err}`);
  }
  // route2_place_order + route2_claim_and_fill as service_role (not the postgres session)
  const pl = await as(db, "service_role", `select public.route2_place_order($1::jsonb, $2::jsonb, '[]'::jsonb) r`,
    [JSON.stringify(attrPayload({ symbol: "EUR/USD", direction: "short" })), JSON.stringify(orderRow({ order_id: "svcplace", symbol: "EUR/USD", direction: "short", entry_price: 1.1, current_price: 1.099, stop_loss: 1.102, take_profit: 1.0978 }))]);
  ok(pl.err === "" && pl.rows[0].r.outcome === "placed", `route2_place_order as service_role ✓ ${pl.err || pl.rows[0].r.outcome}`);
  const so = await orderBy(db, "svcplace");
  await as(db, "service_role", `update public.pending_orders set status = 'awaiting_confirmation', zone_touch_time = now(), confirmation_arm_count = 1 where order_id = 'svcplace'`);
  const cf = await as(db, "service_role", `select public.route2_claim_and_fill($1::uuid, $2::uuid, 1, $3::jsonb, $4::jsonb) r`, [so.id, USER,
    JSON.stringify({ terminal_reason: "FILLED", fill_price: 1.1, filled_at: new Date().toISOString(), resolved_at: new Date().toISOString() }),
    JSON.stringify({ user_id: USER, bot_id: "smc", position_id: "posSvc", order_id: "svcplace", symbol: "EUR/USD", direction: "short", size: "1",
      entry_price: "1.1", current_price: "1.1", stop_loss: "1.102", take_profit: "1.0978", open_time: new Date().toISOString(), signal_score: "61.6", position_status: "open" })]);
  ok(cf.err === "" && cf.rows[0].r.outcome === "filled", `route2_claim_and_fill as service_role ✓ ${cf.err || cf.rows[0].r.outcome}`);
  const upd2 = await as(db, "authenticated", `update public.paper_positions set current_price = '1.0995' where position_id = 'posSvc' returning id`);
  ok(upd2.err === "" && upd2.rows.length === 1, `client paper_positions UPDATE still allowed after revised D2 ${upd2.err}`);
  // re-lock
  const r9 = (await db.query(rl)).rows[0] as any;
  ok(r9.entries_locked && r9.is_paused && (await as(db, "service_role", ord("afterlock", false, "smc", "GBP/USD", "short"))).err.includes("entries locked"), "re-lock: server real order refused again; dry-run allowed again");
  await db.close();

  // atomic unlock refuses without D1 / without D2
  for (const [name, o2] of [["without D2", { d1: true }], ["without D1", { d2: true }]] as [string, any][]) {
    const t = await mk(o2); const mm = await run(t, unTx);
    ok(mm.startsWith("UNLOCK_ABORTED") && mm.includes(name === "without D2" ? "D2/D3" : "D1 not applied"), `atomic unlock refuses ${name}: ${mm.slice(0, 80)}`);
    await t.close();
  }
  { const t = await mk({ d1: true, d2: true }); await t.exec(`grant update on public.pending_orders to authenticated`);
    const mm = await run(t, unTx); ok(mm.includes("client write privileges on pending_orders"), `atomic unlock refuses if client UPDATE on pending_orders is re-granted (triggers intact): ${mm.slice(0, 60)}`); await t.close(); }
  console.log(fails ? `${fails} FAIL(S)` : "ALL D1/D2/D3/UNLOCK CHECKS PASS");
  if (fails) throw new Error("checks failed");
});

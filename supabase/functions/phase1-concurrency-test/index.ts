// TEMPORARY — Phase 1 concurrency test harness. Deployed briefly, then deleted.
// Gate: requires exact match of PHASE1_TEST_SECRET header. No JWT trust.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-phase1-test-secret",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const provided = req.headers.get("x-phase1-test-secret") ?? "";
  const expected = Deno.env.get("PHASE1_TEST_SECRET") ?? "";
  if (!expected || provided.length !== expected.length) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...cors, "Content-Type": "application/json" } });
  }
  // constant-time-ish compare
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  const ts = Date.now();
  const runId = crypto.randomUUID();
  const TEST_BOT_ID = `test_ccy_${ts}_${runId.slice(0, 8)}`;
  const email = `ccy-test+${ts}-${runId.slice(0, 8)}@lovable.test`;

  const evidence: Record<string, unknown> = { runId, ts, TEST_BOT_ID, email };
  let TEST_USER_ID = "";
  let pendingUuid = "";

  try {
    // 1) Create synthetic auth user
    const { data: userData, error: userErr } = await admin.auth.admin.createUser({
      email,
      password: crypto.randomUUID() + crypto.randomUUID(),
      email_confirm: true,
      user_metadata: { purpose: "phase1_concurrency_test", runId, ts },
    });
    if (userErr || !userData?.user) throw new Error(`createUser failed: ${userErr?.message}`);
    TEST_USER_ID = userData.user.id;
    evidence.TEST_USER_ID = TEST_USER_ID;

    // 2) Create synthetic paper_accounts row
    const { data: acct, error: acctErr } = await admin.from("paper_accounts").insert({
      user_id: TEST_USER_ID,
      bot_id: TEST_BOT_ID,
      balance_old: "100000",
      peak_balance_old: "100000",
      balance: 100000,
      peak_balance: 100000,
      daily_pnl_base_old: "0",
      daily_pnl_base: 0,
      daily_pnl_date: new Date().toISOString().slice(0, 10),
      daily_pnl_base_date: new Date().toISOString().slice(0, 10),
      is_running: true,
      is_paused: false,
      kill_switch_active: false,
      scan_count: 0,
      signal_count: 0,
      rejected_count: 0,
      execution_mode: "paper",
      enable_orphan_close: false,
    }).select().single();
    if (acctErr) throw new Error(`paper_accounts insert failed: ${acctErr.message}`);
    evidence.paper_account_id = acct.id;

    // Two independent clients for genuine concurrency
    const clientA = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
    const clientB = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    // 3) TEST A — market entry collision
    const sourceKey = `ccy_${runId}_A`;
    const authorization = { authorized: true, source: "phase1_concurrency_test", runId, ts, nonce: crypto.randomUUID() };
    const position = {
      symbol: "EURUSD",
      direction: "long",
      entry_price: 1.08,
      stop_loss: 1.078,
      take_profit: 1.085,
      size: "0.01",
      position_id: `ccy_pos_A_${runId}`,
      order_id: `ccy_ord_A_${runId}`,
      current_price: 1.08,
      signal_reason: { test: "phase1", runId },
      signal_score: "0",
      open_time: new Date().toISOString(),
    };
    const marketArgs = {
      p_user_id: TEST_USER_ID,
      p_bot_id: TEST_BOT_ID,
      p_source_candidate_key: sourceKey,
      p_position: position,
      p_authorization: authorization,
      p_max_open_positions: 50,
      p_max_per_symbol: 50,
      p_allow_same_direction: true,
      p_close_on_reverse: false,
    };
    const [marketA, marketB] = await Promise.all([
      clientA.rpc("finalize_market_entry", marketArgs),
      clientB.rpc("finalize_market_entry", marketArgs),
    ]);
    evidence.market_test = {
      source_candidate_key: sourceKey,
      resultA: { data: marketA.data, error: marketA.error?.message ?? null },
      resultB: { data: marketB.data, error: marketB.error?.message ?? null },
    };

    // 4) TEST B — pending order fill collision
    const pendingOrderId = `ccy_pending_B_${runId}`;
    const nowIso = new Date().toISOString();
    const expiryIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { data: pending, error: pendingErr } = await admin.from("pending_orders").insert({
      user_id: TEST_USER_ID,
      bot_id: TEST_BOT_ID,
      order_id: pendingOrderId,
      symbol: "GBPUSD",
      direction: "long",
      order_type: "limit",
      entry_price: 1.25,
      current_price: 1.25,
      stop_loss: 1.248,
      take_profit: 1.255,
      size: 0.01,
      status: "awaiting_confirmation",
      expiry_minutes: 60,
      from_watchlist: false,
      placed_at: nowIso,
      expires_at: expiryIso,
      signal_reason: { test: "phase1", runId },
      signal_score: 0,
    }).select().single();
    if (pendingErr) throw new Error(`pending_orders insert failed: ${pendingErr.message}`);
    pendingUuid = pending.id;
    evidence.pending_order_uuid = pendingUuid;

    const pendingArgs = {
      p_pending_id: pendingUuid,
      p_user_id: TEST_USER_ID,
      p_bot_id: TEST_BOT_ID,
      p_fill_price: 1.25,
      p_current_price: 1.25,
      p_position_order_id: `ccy_posord_B_${runId}`,
      p_signal_reason: { test: "phase1", runId },
      p_fill_reason: "phase1_concurrency_test",
      p_authorization: { ...authorization, test: "pending" },
      p_max_open_positions: 50,
      p_max_per_symbol: 50,
      p_allow_same_direction: true,
    };
    const [pendA, pendB] = await Promise.all([
      clientA.rpc("finalize_pending_order_fill", pendingArgs),
      clientB.rpc("finalize_pending_order_fill", pendingArgs),
    ]);
    evidence.pending_test = {
      pending_uuid: pendingUuid,
      resultA: { data: pendA.data, error: pendA.error?.message ?? null },
      resultB: { data: pendB.data, error: pendB.error?.message ?? null },
    };

    // 5) Verifications — scoped to TEST_USER_ID + TEST_BOT_ID
    const scope = (q: any) => q.eq("user_id", TEST_USER_ID).eq("bot_id", TEST_BOT_ID);

    const mkPos = await admin.from("paper_positions").select("*").eq("source_candidate_key", sourceKey).eq("user_id", TEST_USER_ID);
    const pendPos = await admin.from("paper_positions").select("*").eq("source_pending_order_id", pendingUuid).eq("user_id", TEST_USER_ID);
    const allPos = await scope(admin.from("paper_positions").select("*"));
    const ledger = await scope(admin.from("broker_execution_ledger").select("*"));
    const closeLog = await scope(admin.from("close_audit_log").select("*"));
    const pendingFinal = await admin.from("pending_orders").select("status,fill_reason,final_authorization,filled_at").eq("id", pendingUuid).single();

    evidence.verifications = {
      market_position_count: mkPos.data?.length ?? 0,
      market_position_final_authorization: mkPos.data?.[0]?.final_authorization ?? null,
      pending_position_count: pendPos.data?.length ?? 0,
      pending_position_final_authorization: pendPos.data?.[0]?.final_authorization ?? null,
      all_positions_for_test_bot_count: allPos.data?.length ?? 0,
      broker_execution_ledger_count: ledger.data?.length ?? 0,
      close_audit_log_count: closeLog.data?.length ?? 0,
      pending_final_state: pendingFinal.data ?? null,
    };
  } catch (e) {
    evidence.error = (e as Error).message;
  } finally {
    // 6) Cleanup — strictly scoped to synthetic user
    const cleanup: Record<string, unknown> = {};
    try {
      if (TEST_USER_ID) {
        const delPos = await admin.from("paper_positions").delete().eq("user_id", TEST_USER_ID);
        cleanup.paper_positions = { error: delPos.error?.message ?? null };
        const delPend = await admin.from("pending_orders").delete().eq("user_id", TEST_USER_ID);
        cleanup.pending_orders = { error: delPend.error?.message ?? null };
        const delAcct = await admin.from("paper_accounts").delete().eq("user_id", TEST_USER_ID);
        cleanup.paper_accounts = { error: delAcct.error?.message ?? null };

        // Post-cleanup zero-row confirmation
        const zPos = await admin.from("paper_positions").select("id").eq("user_id", TEST_USER_ID);
        const zPend = await admin.from("pending_orders").select("id").eq("user_id", TEST_USER_ID);
        const zAcct = await admin.from("paper_accounts").select("id").eq("user_id", TEST_USER_ID);
        const zLedger = await admin.from("broker_execution_ledger").select("id").eq("user_id", TEST_USER_ID);
        cleanup.zero_row_confirm = {
          paper_positions: zPos.data?.length ?? -1,
          pending_orders: zPend.data?.length ?? -1,
          paper_accounts: zAcct.data?.length ?? -1,
          broker_execution_ledger: zLedger.data?.length ?? -1,
        };

        const delUser = await admin.auth.admin.deleteUser(TEST_USER_ID);
        cleanup.auth_user_delete = { error: delUser.error?.message ?? null };

        // 404 confirmation
        const check = await admin.auth.admin.getUserById(TEST_USER_ID);
        cleanup.auth_user_after_delete = { data: check.data?.user?.id ?? null, error: check.error?.message ?? null };
      } else {
        cleanup.skipped = "no TEST_USER_ID (setup failed before user creation)";
      }
    } catch (e) {
      cleanup.exception = (e as Error).message;
    }
    evidence.cleanup = cleanup;
  }

  return new Response(JSON.stringify(evidence, null, 2), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
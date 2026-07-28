// TEMPORARY: Phase 1 market-entry concurrency test. Do not commit.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TEST_SECRET = Deno.env.get("PHASE1_MARKET_TEST_SECRET")!;

Deno.serve(async (req) => {
  const provided = req.headers.get("x-phase1-test-secret") ?? "";
  if (!TEST_SECRET || provided !== TEST_SECRET) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
  }

  const evidence: Record<string, unknown> = {};
  const ts = Date.now();
  const runId = `mkt_${ts}_${crypto.randomUUID().slice(0, 8)}`;
  const email = `phase1-mkt+${ts}@lovable.test`;
  const password = crypto.randomUUID() + crypto.randomUUID();
  const botId = `test_market_${ts}`;
  const candKey = `ccy_test_${ts}_A`;

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let testUserId = "";
  try {
    // 1. Create synthetic auth user
    const { data: userData, error: userErr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { purpose: "phase1_market_concurrency_test", runId, ts },
    });
    if (userErr || !userData.user) throw new Error("create_user_failed: " + JSON.stringify(userErr));
    testUserId = userData.user.id;
    evidence.runId = runId;
    evidence.testUserId = testUserId;
    evidence.testBotId = botId;
    evidence.sourceCandidateKey = candKey;

    // 2. Create synthetic paper account
    const { error: acctErr } = await admin.from("paper_accounts").insert({
      user_id: testUserId, bot_id: botId, execution_mode: "paper",
      is_running: true, is_paused: false, kill_switch_active: false,
      balance: 100000, peak_balance: 100000,
      balance_old: "100000", peak_balance_old: "100000",
      scan_count: 0, signal_count: 0, rejected_count: 0,
      daily_pnl_base_old: "0", daily_pnl_date: new Date().toISOString().slice(0, 10),
      enable_orphan_close: false,
    });
    if (acctErr) throw new Error("account_insert_failed: " + JSON.stringify(acctErr));

    // 3. Two independent clients, genuinely concurrent RPC calls
    const clientA = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const clientB = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    const payload = {
      p_user_id: testUserId, p_bot_id: botId,
      p_source_candidate_key: candKey,
      p_position: {
        symbol: "EURUSD", direction: "long",
        entry_price: 1.0800, stop_loss: 1.0780, take_profit: 1.0850,
        size: 0.01,
        position_id: `ccy_pos_A_${ts}`, order_id: `ccy_ord_A_${ts}`,
      },
      p_authorization: {
        authorized: true, source: "phase1_market_concurrency_test",
        runId, ts, nonce: crypto.randomUUID(),
      },
      p_max_open_positions: 50,
      p_max_per_symbol: 50,
      p_allow_same_direction: true,
      p_close_on_reverse: false,
    };

    const [resA, resB] = await Promise.all([
      clientA.rpc("finalize_market_entry", payload),
      clientB.rpc("finalize_market_entry", payload),
    ]);
    evidence.rpcA = { data: resA.data, error: resA.error };
    evidence.rpcB = { data: resB.data, error: resB.error };

    // 4. Verify DB state
    const { data: positions } = await admin.from("paper_positions")
      .select("id, source_candidate_key, final_authorization, symbol, direction, size, entry_price")
      .eq("user_id", testUserId).eq("bot_id", botId);
    evidence.positions = positions;
    evidence.positionCount = positions?.length ?? 0;

    const { data: ledger } = await admin.from("broker_execution_ledger")
      .select("id").eq("user_id", testUserId);
    evidence.brokerLedgerCount = ledger?.length ?? 0;
  } catch (e) {
    evidence.error = String(e);
  } finally {
    // 5. Cleanup (best-effort, always attempted)
    const cleanup: Record<string, unknown> = {};
    try {
      if (testUserId) {
        const d1 = await admin.from("paper_positions").delete().eq("user_id", testUserId);
        cleanup.paper_positions_deleted = !d1.error;
        const d2 = await admin.from("pending_orders").delete().eq("user_id", testUserId);
        cleanup.pending_orders_deleted = !d2.error;
        const d3 = await admin.from("paper_accounts").delete().eq("user_id", testUserId);
        cleanup.paper_accounts_deleted = !d3.error;

        // Zero-row confirmations
        const c1 = await admin.from("paper_positions").select("id", { count: "exact", head: true }).eq("user_id", testUserId);
        const c2 = await admin.from("pending_orders").select("id", { count: "exact", head: true }).eq("user_id", testUserId);
        const c3 = await admin.from("paper_accounts").select("id", { count: "exact", head: true }).eq("user_id", testUserId);
        const c4 = await admin.from("broker_execution_ledger").select("id", { count: "exact", head: true }).eq("user_id", testUserId);
        cleanup.confirm_paper_positions = c1.count;
        cleanup.confirm_pending_orders = c2.count;
        cleanup.confirm_paper_accounts = c3.count;
        cleanup.confirm_broker_ledger = c4.count;

        const del = await admin.auth.admin.deleteUser(testUserId);
        cleanup.auth_user_deleted = !del.error;
        const check = await admin.auth.admin.getUserById(testUserId);
        cleanup.auth_user_status = check.error ? "not_found" : "still_present";
      }
    } catch (ce) {
      cleanup.cleanup_exception = String(ce);
    }
    evidence.cleanup = cleanup;
  }

  return new Response(JSON.stringify(evidence, null, 2), {
    headers: { "content-type": "application/json" },
  });
});
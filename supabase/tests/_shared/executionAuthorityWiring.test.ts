import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const fastScannerUrl = new URL(
  "../zone-confirmation-scanner/index.ts",
  import.meta.url,
);
const botScannerUrl = new URL("../bot-scanner/index.ts", import.meta.url);
const brokerExecuteUrl = new URL("../broker-execute/index.ts", import.meta.url);
const phaseOneMigrationUrl = new URL(
  "../../migrations/20260728200000_complete_phase1_execution_authority.sql",
  import.meta.url,
);

Deno.test("fast confirmation uses shared authorization and atomic fill only", async () => {
  const source = await Deno.readTextFile(fastScannerUrl.pathname);
  assertStringIncludes(source, "evaluateFinalTradeAuthorization({");
  assertStringIncludes(source, 'supabase.rpc("finalize_pending_order_fill"');
  assertEquals(
    source.includes('supabase.from("paper_positions").insert'),
    false,
    "Fast confirmation must not insert a position outside the atomic RPC",
  );
});

Deno.test("normal pending confirmation uses shared authorization and atomic fill", async () => {
  const source = await Deno.readTextFile(botScannerUrl.pathname);
  const start = source.indexOf(
    "// ── Limit Orders: Monitor active pending orders",
  );
  const end = source.indexOf("// ── Management-Only Early Return");
  assert(
    start >= 0 && end > start,
    "Pending-order monitoring section must be discoverable",
  );
  const pendingSection = source.slice(start, end);
  assertStringIncludes(pendingSection, "evaluateFinalTradeAuthorization({");
  assertStringIncludes(
    pendingSection,
    'supabase.rpc("finalize_pending_order_fill"',
  );
  assertEquals(
    pendingSection.includes('supabase.from("paper_positions").insert'),
    false,
    "Normal pending confirmation must not insert a position outside the atomic RPC",
  );
});

Deno.test("breaker placement cannot bypass final direction and Game Plan authority", async () => {
  const source = await Deno.readTextFile(botScannerUrl.pathname);
  const start = source.indexOf("// ── Breaker Block Entry Signal");
  const end = source.indexOf("// ── Setup Staging", start);
  assert(start >= 0 && end > start, "Breaker section must be discoverable");
  const breakerSection = source.slice(start, end);
  const authorizationAt = breakerSection.indexOf(
    "evaluateFinalTradeAuthorization({",
  );
  const insertAt = breakerSection.indexOf(
    'supabase.from("pending_orders").insert',
  );
  assert(authorizationAt >= 0, "Breaker must call final authorization");
  assert(
    insertAt > authorizationAt,
    "Breaker authorization must run before pending-order insertion",
  );
  assertStringIncludes(breakerSection, "directionVerdict:");
  assertStringIncludes(breakerSection, "gamePlan: activeGamePlan");
});

Deno.test("immediate market entries use shared authorization and an atomic claim", async () => {
  const source = await Deno.readTextFile(botScannerUrl.pathname);
  const start = source.indexOf("// Place position (market order)");
  const end = source.indexOf("// Store trade reasoning", start);
  assert(
    start >= 0 && end > start,
    "Market-entry section must be discoverable",
  );
  const marketSection = source.slice(start, end);
  const authorizationAt = marketSection.indexOf(
    "evaluateFinalTradeAuthorization({",
  );
  const atomicClaimAt = marketSection.indexOf(
    'supabase.rpc("finalize_market_entry"',
  );
  const closeOnReverseAt = marketSection.indexOf(
    "await closeOppositePositionsAfterEntry()",
  );
  assert(authorizationAt >= 0, "Market entry must call final authorization");
  assert(
    atomicClaimAt > authorizationAt,
    "Final authorization must precede the atomic market-entry claim",
  );
  assert(
    closeOnReverseAt > atomicClaimAt,
    "Close-on-reverse must run only after the market entry claim succeeds",
  );
  assertEquals(
    marketSection.includes('supabase.from("paper_positions").insert'),
    false,
    "Market entry must not insert a position outside the atomic RPC",
  );
});

Deno.test("all automated entry models terminate in an authorized execution route", async () => {
  const source = await Deno.readTextFile(botScannerUrl.pathname);
  for (
    const marker of [
      'signalSource = "unified"',
      'signalSource = "cascade"',
      'signalSource = "standalone"',
      "isPromotedFromStaging",
      'signalSource: "breaker"',
    ]
  ) {
    assertStringIncludes(source, marker);
  }
  assertStringIncludes(source, "evaluateFinalTradeAuthorization({");
  assertStringIncludes(source, 'supabase.rpc("finalize_pending_order_fill"');
  assertStringIncludes(source, 'supabase.rpc("finalize_market_entry"');
});

Deno.test("database serializes and deduplicates immediate and pending entries", async () => {
  const migration = await Deno.readTextFile(phaseOneMigrationUrl.pathname);
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.finalize_market_entry",
  );
  assertStringIncludes(migration, "FOR UPDATE");
  assertStringIncludes(migration, "idx_paper_positions_candidate_source");
  assertStringIncludes(
    migration,
    "WHERE status IN ('pending', 'awaiting_confirmation')",
  );
  assertStringIncludes(migration, "persist_pending_fill_authorization");
  assertStringIncludes(migration, "WHEN unique_violation");
});

Deno.test("fast confirmation respects the setup's frozen confirmation method and user-scoped broker connection", async () => {
  const source = await Deno.readTextFile(fastScannerUrl.pathname);
  assertStringIncludes(
    source,
    "const confirmationMethod = resolvePendingConfirmationMethod(",
  );
  assertStringIncludes(source, "pending,");
  assertStringIncludes(source, "config,");
  assertStringIncludes(source, "checkIndicatorConfirmation(");
  assertStringIncludes(source, "brokerConn: BrokerConn | null;");
  assertEquals(
    source.includes("let _brokerConn"),
    false,
    "Broker connection must not be shared across users",
  );
});

Deno.test("all live entry routes claim durable broker execution before sending", async () => {
  const fastSource = await Deno.readTextFile(fastScannerUrl.pathname);
  const botSource = await Deno.readTextFile(botScannerUrl.pathname);

  assertStringIncludes(fastSource, "executeBrokerOrderWithLedger(");
  assertStringIncludes(fastSource, 'route: "fast_confirmation"');

  assertStringIncludes(botSource, "executeBrokerOrderWithLedger(");
  assertStringIncludes(botSource, 'route: "normal_pending"');
  assertStringIncludes(botSource, 'route: "direct_market"');

  assertEquals(
    fastSource.split("executeBrokerOrderWithLedger(").length - 1,
    2,
    "Fast confirmation must ledger both MetaAPI and non-MetaAPI sends",
  );
  assertEquals(
    botSource.split("executeBrokerOrderWithLedger(").length - 1,
    4,
    "Bot scanner must ledger normal-pending and direct-market sends for both broker paths",
  );
});

Deno.test("all live entry routes finalize internal state from broker ledger", async () => {
  const fastSource = await Deno.readTextFile(fastScannerUrl.pathname);
  const botSource = await Deno.readTextFile(botScannerUrl.pathname);
  assertStringIncludes(fastSource, 'supabase.rpc("finalize_live_broker_position"');
  assertEquals(botSource.split('supabase.rpc("finalize_live_broker_position"').length - 1, 2);
  assertStringIncludes(botSource, 'account.execution_mode !== "live"');
  assertStringIncludes(botSource, 'brokerLifecycle?.open === true');
});

Deno.test("reverse close preserves internal position until broker closes confirm", async () => {
  const source = await Deno.readTextFile(botScannerUrl.pathname);
  const start = source.indexOf("const closeOppositePositionsAfterEntry");
  const end = source.indexOf("// GUARD: reject trades", start);
  const closeSection = source.slice(start, end);
  const brokerConfirmation = closeSection.indexOf("confirmedBrokerCloses");
  const internalDelete = closeSection.indexOf("supabase.from(\"paper_positions\").delete()");
  assert(brokerConfirmation >= 0 && internalDelete > brokerConfirmation);
  assertStringIncludes(closeSection, "broker_close_state: \"reconciliation_required\"");
  assertStringIncludes(closeSection, "internal position remains open");
});

Deno.test("broker-execute carries local position identity to both brokers", async () => {
  const source = await Deno.readTextFile(brokerExecuteUrl.pathname);
  assertStringIncludes(
    source,
    "const { symbol, direction, size, stopLoss, takeProfit, positionId }",
  );
  assertStringIncludes(source, "tradeClientExtensions");
  assertStringIncludes(source, "clientExtensions");
  assertStringIncludes(source, "tradeBody.comment = `paper:${positionId}`");
});

Deno.test("live market-order sends suppress unsafe automatic retries", async () => {
  const brokerSource = await Deno.readTextFile(brokerExecuteUrl.pathname);
  const placeOrderStart = brokerSource.indexOf(
    'if (action === "place_order")',
  );
  const placeOrderEnd = brokerSource.indexOf(
    'if (action === "account_balance")',
    placeOrderStart,
  );
  assert(
    placeOrderStart >= 0 && placeOrderEnd > placeOrderStart,
    "Broker place-order section must be discoverable",
  );
  const placeOrderSection = brokerSource.slice(placeOrderStart, placeOrderEnd);
  assertEquals(
    placeOrderSection.includes("retryWithBackoff("),
    false,
    "Opening a market order must not retry after an uncertain result",
  );
  assertStringIncludes(placeOrderSection, "allowFailover: false");

  const fastSource = await Deno.readTextFile(fastScannerUrl.pathname);
  const botSource = await Deno.readTextFile(botScannerUrl.pathname);
  assertStringIncludes(fastSource, "allowFailover: false");
  assertStringIncludes(botSource, "allowFailover: false");
});

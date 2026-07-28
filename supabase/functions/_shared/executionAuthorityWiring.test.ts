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

Deno.test("fast confirmation respects confirmationMethod and user-scoped broker connection", async () => {
  const source = await Deno.readTextFile(fastScannerUrl.pathname);
  assertStringIncludes(
    source,
    'const confirmationMethod = config.confirmationMethod || "choch"',
  );
  assertStringIncludes(source, "checkIndicatorConfirmation(");
  assertStringIncludes(source, "brokerConn: BrokerConn | null;");
  assertEquals(
    source.includes("let _brokerConn"),
    false,
    "Broker connection must not be shared across users",
  );
});

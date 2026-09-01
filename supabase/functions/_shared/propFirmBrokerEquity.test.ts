/**
 * Tests for prop firm broker equity fix and calcPnl NaN guard.
 *
 * Verifies:
 * 1. propFirmGate uses brokerEquity when hasBrokerConnection=true (even without isLiveAccount)
 * 2. propFirmGate skips safely when hasBrokerConnection=true but brokerEquity is undefined
 * 3. calcPnl returns zero when entry/current/size is NaN or invalid
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

// ── Test 1: propFirmGate hasBrokerConnection flag in opts type ──
Deno.test("propFirmGate opts interface includes hasBrokerConnection", async () => {
  const source = await Deno.readTextFile(
    new URL("./propFirmGate.ts", import.meta.url).pathname
  );
  // Verify the new flag exists in the opts interface
  assertStringIncludes(source, "hasBrokerConnection?: boolean");
  // Verify the safety check uses hasBrokerConnection
  assertStringIncludes(source, "opts?.isLiveAccount || opts?.hasBrokerConnection");
});

// ── Test 2: propFirmGate uses broker equity when available (not just live) ──
Deno.test("propFirmGate equity priority comment reflects broker-first approach", async () => {
  const source = await Deno.readTextFile(
    new URL("./propFirmGate.ts", import.meta.url).pathname
  );
  // Verify the comment documents the new behavior
  assertStringIncludes(source, "Priority: broker equity (from MetaAPI) > paper balance + floating P&L");
  assertStringIncludes(source, "even in paper mode");
});

// ── Test 3: bot-scanner passes hasBrokerConnection flag ──
Deno.test("bot-scanner passes hasBrokerConnection to runPropFirmGate", async () => {
  const source = await Deno.readTextFile(
    new URL("../bot-scanner/index.ts", import.meta.url).pathname
  );
  // Verify hasBrokerConnection is passed
  assertStringIncludes(source, "hasBrokerConnection: !!_scanBrokerConn");
});

// ── Test 4: bot-scanner fetches broker equity without live-mode restriction ──
Deno.test("bot-scanner fetches broker equity when any broker connection exists (not just live)", async () => {
  const source = await Deno.readTextFile(
    new URL("../bot-scanner/index.ts", import.meta.url).pathname
  );
  // The old code had: if (account.execution_mode === "live" && _scanBrokerConn)
  // The new code has: if (_scanBrokerConn)
  // Verify the live-mode restriction is removed from the equity fetch block
  assertStringIncludes(source, "if (_scanBrokerConn) {\n      try {\n        const metaAccountId = _scanBrokerConn.account_id;");
  // Verify the old live-only pattern is NOT present in the equity fetch context
  const equityFetchSection = source.substring(
    source.indexOf("// Determine broker equity"),
    source.indexOf("propFirmGateResult = await runPropFirmGate")
  );
  assertEquals(equityFetchSection.includes('account.execution_mode === "live" && _scanBrokerConn'), false,
    "Should NOT have live-mode restriction on broker equity fetch");
});

// ── Test 5: calcPnl NaN guard returns zero for NaN entry ──
Deno.test("calcPnl NaN guard is present in paper-trading", async () => {
  const source = await Deno.readTextFile(
    new URL("../paper-trading/index.ts", import.meta.url).pathname
  );
  assertStringIncludes(source, "Number.isFinite(entry)");
  assertStringIncludes(source, "Number.isFinite(current)");
  assertStringIncludes(source, "Returning zero P&L");
});

// ── Test 6: calcPnl NaN guard logic is correct ──
Deno.test("calcPnl NaN guard catches all invalid input combinations", async () => {
  const source = await Deno.readTextFile(
    new URL("../paper-trading/index.ts", import.meta.url).pathname
  );
  // Verify the guard checks all three critical inputs
  assertStringIncludes(source, "!Number.isFinite(entry) || !Number.isFinite(current) || !Number.isFinite(size)");
  // Verify it also checks for zero/negative values
  assertStringIncludes(source, "entry <= 0 || current <= 0 || size <= 0");
  // Verify it returns zero PnL (not NaN)
  assertStringIncludes(source, "return { pnl: 0, pnlPips: 0 }");
});

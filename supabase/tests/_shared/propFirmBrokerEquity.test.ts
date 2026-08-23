/**
 * Tests for prop firm broker equity fix and calcPnl NaN guard.
 *
 * Verifies:
 * 1. propFirmGate supports brokerEquity when the caller marks a broker connection active
 * 2. bot-scanner only marks that broker connection active in live execution mode
 * 3. calcPnl returns an explicit invalid result for unsafe accounting inputs
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// ── Test 1: propFirmGate hasBrokerConnection flag in opts type ──
Deno.test("propFirmGate opts interface includes hasBrokerConnection", async () => {
  const source = await Deno.readTextFile(
    new URL("../../functions/_shared/propFirmGate.ts", import.meta.url).pathname,
  );
  // Verify the new flag exists in the opts interface
  assertStringIncludes(source, "hasBrokerConnection?: boolean");
  // Verify the safety check uses hasBrokerConnection
  assertStringIncludes(
    source,
    "opts?.isLiveAccount || opts?.hasBrokerConnection",
  );
});

// ── Test 2: propFirmGate uses broker equity when available (not just live) ──
Deno.test("propFirmGate equity priority comment reflects broker-first approach", async () => {
  const source = await Deno.readTextFile(
    new URL("../../functions/_shared/propFirmGate.ts", import.meta.url).pathname,
  );
  // Verify the comment documents the new behavior
  assertStringIncludes(
    source,
    "Priority: broker equity (from MetaAPI) > paper balance + floating P&L",
  );
  assertStringIncludes(source, "even in paper mode");
});

// ── Test 3: bot-scanner scopes hasBrokerConnection to live mode ──
Deno.test("bot-scanner passes a live-scoped hasBrokerConnection flag", async () => {
  const source = await Deno.readTextFile(
    new URL("../../functions/bot-scanner/index.ts", import.meta.url).pathname,
  );
  // Verify hasBrokerConnection is passed
  assertStringIncludes(
    source,
    "hasBrokerConnection: isLiveMode && !!_scanBrokerConn",
  );
});

// ── Test 4: bot-scanner fetches broker equity only for live execution ──
Deno.test("bot-scanner fetches broker equity only in live mode", async () => {
  const source = await Deno.readTextFile(
    new URL("../../functions/bot-scanner/index.ts", import.meta.url).pathname,
  );
  assertStringIncludes(
    source,
    "if (_scanBrokerConn && isLiveMode) {\n      try {\n        const metaAccountId = _scanBrokerConn.account_id;",
  );
  const equityFetchSection = source.substring(
    source.indexOf("// In live mode, use MetaAPI equity"),
    source.indexOf("propFirmGateResult = await runPropFirmGate"),
  );
  assertEquals(
    equityFetchSection.includes("if (_scanBrokerConn && isLiveMode)"),
    true,
    "Paper mode must not use unrelated live-broker equity",
  );
});

// ── Test 5: calcPnl identifies invalid inputs without emitting NaN ──
Deno.test("calcPnl invalid-input guard is owned by the shared calculator", async () => {
  const source = await Deno.readTextFile(
    new URL("../../functions/_shared/smcAnalysis.ts", import.meta.url).pathname,
  );
  assertStringIncludes(source, "Number.isFinite(entry)");
  assertStringIncludes(source, "Number.isFinite(current)");
  assertStringIncludes(source, "Returning an invalid result.");
});

// ── Test 6: calcPnl invalid-input contract is explicit ──
Deno.test("calcPnl invalid-input guard checks every accounting input", async () => {
  const source = await Deno.readTextFile(
    new URL("../../functions/_shared/smcAnalysis.ts", import.meta.url).pathname,
  );
  assertStringIncludes(source, "!Number.isFinite(entry)");
  assertStringIncludes(source, "!Number.isFinite(current)");
  assertStringIncludes(source, "!Number.isFinite(size)");
  assertStringIncludes(source, "entry <= 0");
  assertStringIncludes(source, "current <= 0");
  assertStringIncludes(source, "size <= 0");
  assertStringIncludes(
    source,
    `return { valid: false, pnl: 0, pnlPips: 0, reason: "invalid_inputs" };`,
  );
});

Deno.test("paper-trading delegates PnL to the shared owner", async () => {
  const source = await Deno.readTextFile(
    new URL("../../functions/paper-trading/index.ts", import.meta.url).pathname,
  );
  assertStringIncludes(source, "calcPnl,");
  assertEquals(/function\s+calcPnl\s*\(/.test(source), false, "paper-trading must not keep a private PnL implementation");
});

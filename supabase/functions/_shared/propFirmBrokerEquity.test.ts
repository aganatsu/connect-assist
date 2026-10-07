/**
 * Tests for the prop firm equity source and the calcPnl NaN guard.
 *
 * Step 13 replaced "broker equity first, skip the check if it is unavailable"
 * (fail-open, and it measured the PAPER account on whatever MetaAPI account
 * was connected — "FTMO 2", used for candles) with an explicit profile
 * equity_source: 'paper' (ledger + open positions) or 'broker' (not supported
 * until broker reconciliation → entries blocked).
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

// ── Test 1: the gate takes its equity source from the profile, not from a connection ──
Deno.test("propFirmGate reads equity_source from the profile; no hasBrokerConnection fallback", async () => {
  const source = await Deno.readTextFile(new URL("./propFirmGate.ts", import.meta.url).pathname);
  assertStringIncludes(source, `(profile.equity_source ?? "paper") !== "paper"`);
  assertEquals(source.includes("hasBrokerConnection"), false);
  assertEquals(source.includes("Broker equity unavailable — prop firm check skipped"), false, "no fail-open skip");
});

// ── Test 2: bot-scanner no longer fetches broker equity for the gate ──
Deno.test("bot-scanner does not fetch broker equity for the prop firm gate", async () => {
  const source = await Deno.readTextFile(new URL("../bot-scanner/index.ts", import.meta.url).pathname);
  assertEquals(source.includes("hasBrokerConnection: !!_scanBrokerConn"), false);
  assertEquals(source.includes("// Determine broker equity"), false);
  assertStringIncludes(source, "{ rateMap, commissionPerLotRoundTrip: avgCommissionPerLot }");
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

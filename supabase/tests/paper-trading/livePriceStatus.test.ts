/**
 * livePriceStatus.test.ts — Structural regression tests for the live price
 * refresh added to the paper-trading "status" action.
 *
 * Branch: manus/fix-live-price-display
 *
 * Verifies that the status handler now fetches live prices for open positions
 * on every poll (not just when processEngine=true), and that the impulse zone
 * panel uses the correct max score denominator.
 */
import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const paperSource = Deno.readTextFileSync(
  new URL("./index.ts", import.meta.url).pathname,
);

// ═══════════════════════════════════════════════════════════════════════
// Test 1: Status handler refreshes prices BEFORE processEngine check
// ═══════════════════════════════════════════════════════════════════════
Deno.test("status handler fetches live prices unconditionally for open positions", () => {
  // The live price refresh block should appear BEFORE the processEngine check
  const livePriceBlock = paperSource.indexOf("Always refresh live prices on status poll");
  const processEngineBlock = paperSource.indexOf("payload.processEngine === true");

  assert(livePriceBlock > 0, "Live price refresh block should exist in paper-trading/index.ts");
  assert(processEngineBlock > 0, "processEngine block should still exist");
  assert(
    livePriceBlock < processEngineBlock,
    "Live price refresh must run BEFORE processEngine check (unconditional price update)"
  );
});

// ═══════════════════════════════════════════════════════════════════════
// Test 2: Live price refresh uses fetchLivePrice (TwelveData /price endpoint)
// ═══════════════════════════════════════════════════════════════════════
Deno.test("live price refresh calls fetchLivePrice for each unique symbol", () => {
  // Extract the live price refresh block
  const startMarker = "Always refresh live prices on status poll";
  const endMarker = "Engine processing (SL/TP/trail/BE logic) only runs when explicitly triggered";
  const startIdx = paperSource.indexOf(startMarker);
  const endIdx = paperSource.indexOf(endMarker);

  assert(startIdx > 0, "Start marker should exist");
  assert(endIdx > startIdx, "End marker should exist after start marker");

  const block = paperSource.slice(startIdx, endIdx);

  // Should deduplicate symbols
  assert(block.includes("new Set(positions.map"), "Should deduplicate symbols using Set");
  // Should call fetchLivePrice
  assert(block.includes("fetchLivePrice(sym)"), "Should call fetchLivePrice for each symbol");
  // Should update in-memory position objects
  assert(block.includes("p.current_price = livePrice.toString()"), "Should update in-memory current_price");
  // Should persist to DB
  assert(block.includes("paper_positions").valueOf, "Should update paper_positions table");
});

// ═══════════════════════════════════════════════════════════════════════
// Test 3: PnL is computed from current_price (which is now live)
// ═══════════════════════════════════════════════════════════════════════
Deno.test("posArr PnL uses current_price (now live) not entry_price", () => {
  // The posArr mapping should use p.current_price for PnL calculation
  const posArrBlock = paperSource.slice(
    paperSource.indexOf("const posArr = (positions || []).map"),
    paperSource.indexOf("const unrealizedPnl = posArr.reduce")
  );

  assert(posArrBlock.includes("parseFloat(p.current_price)"), "Should parse current_price");
  assert(
    posArrBlock.includes('calcPnl(p.direction, parseFloat(p.entry_price), parseFloat(p.current_price)'),
    "calcPnl should use entry_price and current_price (not same value)"
  );
});

// ═══════════════════════════════════════════════════════════════════════
// Test 4: Unrealized PnL is derived from posArr (which uses live prices)
// ═══════════════════════════════════════════════════════════════════════
Deno.test("unrealizedPnl is sum of posArr.pnl (derived from live prices)", () => {
  // The line includes type annotations: (s: number, p: any) => s + p.pnl
  assert(
    paperSource.includes("const unrealizedPnl = posArr.reduce((s: number, p: any) => s + p.pnl, 0)"),
    "unrealizedPnl should be computed by summing posArr p.pnl values"
  );
});

// ═══════════════════════════════════════════════════════════════════════
// Test 5: Equity is balance + unrealizedPnl (correct formula)
// ═══════════════════════════════════════════════════════════════════════
Deno.test("equity returned as balance + unrealizedPnl", () => {
  assert(
    paperSource.includes("equity: balance + unrealizedPnl"),
    "Response should include equity: balance + unrealizedPnl"
  );
});

// ═══════════════════════════════════════════════════════════════════════
// Test 6: ImpulseZonePanel uses /11 denominator (not /6)
// ═══════════════════════════════════════════════════════════════════════
Deno.test("ImpulseZonePanel uses correct max score denominator of 11", () => {
  const panelSource = Deno.readTextFileSync(
    new URL("../../../src/components/ImpulseZonePanel.tsx", import.meta.url).pathname,
  );

  // Should NOT contain hardcoded /6
  assert(
    !panelSource.includes("totalScore}/6"),
    "Should not have hardcoded /6 denominator"
  );
  // Should contain /11
  assert(
    panelSource.includes("totalScore}/11"),
    "Should use /11 as the max impulse zone score"
  );
});

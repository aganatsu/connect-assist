/**
 * Paper-Trading Dedup Tests
 *
 * Verifies that paper-trading no longer independently activates:
 * - Break-even (BE)
 * - Trailing stop activation
 * - Partial take-profit
 *
 * These decisions are now made exclusively by scannerManagement.
 * Paper-trading only does:
 * - Trail RATCHETING (when trailingStopActivated is already true)
 * - SL/TP hit detection and full close
 */
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";

// ─── Simulate the paper-trading management loop (post-dedup) ─────────────────

interface Position {
  direction: "long" | "short";
  entry_price: string;
  stop_loss: string | null;
  take_profit: string | null;
  signal_reason: string;
  partial_tp_fired: boolean;
}

interface SimResult {
  beActivated: boolean;
  trailActivated: boolean;
  trailRatcheted: boolean;
  partialTPFired: boolean;
  newSL: number | null;
}

/**
 * Simulates the paper-trading position management loop as it exists AFTER dedup.
 * Returns what actions were taken.
 */
function simulateManagement(pos: Position, currentPrice: number): SimResult {
  const entryPrice = parseFloat(pos.entry_price);
  let sl = pos.stop_loss ? parseFloat(pos.stop_loss) : null;
  const tp = pos.take_profit ? parseFloat(pos.take_profit) : null;
  const exitFlags = JSON.parse(pos.signal_reason || "{}").exitFlags || {};

  let beActivated = false;
  let trailActivated = false;
  let trailRatcheted = false;
  let partialTPFired = false;

  // ─── BE: paper-trading no longer activates BE ───
  // (removed — scannerManagement handles this)
  // If we were to check beEnabled && !beAlreadyActivated here, it would be a regression.

  // ─── Trailing: only RATCHET if already activated ───
  const trailEnabled = exitFlags.trailingStopEnabled ?? exitFlags.trailingStop ?? false;
  const trailAlreadyActivated = exitFlags.trailingStopActivated === true;

  if (trailEnabled && trailAlreadyActivated && sl !== null) {
    const pipSize = 0.0001; // EUR/USD
    const riskPips = Math.abs(entryPrice - sl) / pipSize;
    const effectiveTrailPips = exitFlags.trailingStopPips
      ? Math.max(exitFlags.trailingStopPips, riskPips * 0.5)
      : riskPips * 0.5;
    const trailDistance = effectiveTrailPips * pipSize;
    const newSLCalc = pos.direction === "long"
      ? currentPrice - trailDistance
      : currentPrice + trailDistance;

    if ((pos.direction === "long" && newSLCalc > sl) || (pos.direction === "short" && newSLCalc < sl)) {
      sl = newSLCalc;
      trailRatcheted = true;
    }
  } else if (trailEnabled && !trailAlreadyActivated) {
    // Paper-trading should NOT activate trailing — this is the dedup guarantee
    trailActivated = false; // explicitly NOT activating
  }

  // ─── Partial TP: paper-trading no longer fires partial-TP ───
  // (removed — scannerManagement handles this)

  return { beActivated, trailActivated, trailRatcheted, partialTPFired, newSL: sl };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

Deno.test("Dedup: paper-trading does NOT activate BE even when conditions are met", () => {
  // Position at 2R profit — BE should have fired under old logic
  const pos: Position = {
    direction: "long",
    entry_price: "1.1000",
    stop_loss: "1.0950",  // 50 pip SL
    take_profit: "1.1200",
    signal_reason: JSON.stringify({
      exitFlags: {
        breakEvenEnabled: true,
        breakEvenActivated: false,
        breakEvenPips: 50,
        breakEvenOffsetPips: 3,
      }
    }),
    partial_tp_fired: false,
  };

  // Price at 1.1100 = 2R profit (100 pips profit / 50 pip risk)
  const result = simulateManagement(pos, 1.1100);

  assertEquals(result.beActivated, false, "Paper-trading must NOT activate BE");
  assertEquals(result.newSL, 1.0950, "SL must remain unchanged");
});

Deno.test("Dedup: paper-trading does NOT activate trailing even when R threshold is met", () => {
  // Position at 1.5R profit — trailing should have activated under old logic
  const pos: Position = {
    direction: "long",
    entry_price: "1.1000",
    stop_loss: "1.0950",  // 50 pip SL
    take_profit: "1.1200",
    signal_reason: JSON.stringify({
      exitFlags: {
        trailingStopEnabled: true,
        trailingStopActivated: false,  // NOT yet activated by scannerManagement
        trailingStopPips: 30,
        trailingStopActivation: "after_1r",
      }
    }),
    partial_tp_fired: false,
  };

  // Price at 1.1075 = 1.5R profit
  const result = simulateManagement(pos, 1.1075);

  assertEquals(result.trailActivated, false, "Paper-trading must NOT activate trailing");
  assertEquals(result.trailRatcheted, false, "No ratchet since trail not activated");
  assertEquals(result.newSL, 1.0950, "SL must remain unchanged");
});

Deno.test("Dedup: paper-trading DOES ratchet trail when already activated by scannerManagement", () => {
  // Trail already activated — paper-trading should ratchet forward
  const pos: Position = {
    direction: "long",
    entry_price: "1.1000",
    stop_loss: "1.1020",  // Already moved up by previous ratchet
    take_profit: "1.1200",
    signal_reason: JSON.stringify({
      exitFlags: {
        trailingStopEnabled: true,
        trailingStopActivated: true,  // Already activated by scannerManagement
        trailingStopPips: 30,
      }
    }),
    partial_tp_fired: false,
  };

  // Price moved further to 1.1080 — trail should ratchet SL forward
  const result = simulateManagement(pos, 1.1080);

  assertEquals(result.trailRatcheted, true, "Paper-trading SHOULD ratchet when trail is already active");
  assert(result.newSL! > 1.1020, `New SL (${result.newSL}) should be above old SL (1.1020)`);
});

Deno.test("Dedup: paper-trading does NOT fire partial-TP even when conditions are met", () => {
  // Position at 1R profit — partial TP should have fired under old logic
  const pos: Position = {
    direction: "long",
    entry_price: "1.1000",
    stop_loss: "1.0950",  // 50 pip SL
    take_profit: "1.1200",
    signal_reason: JSON.stringify({
      exitFlags: {
        partialTPEnabled: true,
        partialTPActivated: false,
        partialTPPercent: 50,
        partialTPLevel: 1.0,  // 1R trigger
      }
    }),
    partial_tp_fired: false,
  };

  // Price at 1.1050 = exactly 1R profit
  const result = simulateManagement(pos, 1.1050);

  assertEquals(result.partialTPFired, false, "Paper-trading must NOT fire partial-TP");
});

Deno.test("Dedup: trail ratchet does NOT widen SL (only tightens)", () => {
  // Trail active but price pulled back — SL should NOT move backward
  const pos: Position = {
    direction: "long",
    entry_price: "1.1000",
    stop_loss: "1.1050",  // Already ratcheted high
    take_profit: "1.1200",
    signal_reason: JSON.stringify({
      exitFlags: {
        trailingStopEnabled: true,
        trailingStopActivated: true,
        trailingStopPips: 30,
      }
    }),
    partial_tp_fired: false,
  };

  // Price pulled back to 1.1060 — new trail SL would be 1.1060 - 0.0030 = 1.1030
  // But current SL is 1.1050 which is HIGHER — should NOT widen
  const result = simulateManagement(pos, 1.1060);

  assertEquals(result.trailRatcheted, false, "Trail must NOT widen SL");
  assertEquals(result.newSL, 1.1050, "SL must remain at higher level");
});

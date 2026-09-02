import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Two ways a position gets opened: the market path in evaluateGates, and the
 * pending-order path when a zone touch confirms. Both must apply the same
 * duplicate guards, or the weaker one becomes the way duplicates get in.
 *
 * Measured 2026-09-02: four GBP/JPY longs and two EUR/USD longs, opened across
 * separate scan cycles with near-identical entries, every one closed at stop.
 * 1,666 of a 3,406 drawdown — 49% — from four duplicated ideas on two symbols.
 * The market path refused same-direction stacking; the pending path only
 * counted positions.
 *
 * Read from source: both live inside an Edge Function module body that calls
 * Deno.serve on import.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

/** The pending-fill block, from the confirmed-fill marker to the insert. */
function pendingFillBlock(): string {
  const start = scanner.indexOf("CHoCH CONFIRMED! Enter the trade at live price.");
  assert(start > -1, "pending confirmed-fill block not found");
  const end = scanner.indexOf("const actualFillPrice", start);
  assert(end > start, "pending confirmed-fill block is unterminated");
  return scanner.slice(start, end);
}

Deno.test("market path refuses same-direction stacking", () => {
  assert(
    /sameDirectionExists\s*&&\s*!config\.allowSameDirectionStacking/.test(scanner),
    "the market path must still refuse a second position in the same direction",
  );
});

Deno.test("pending-fill path refuses same-direction stacking too", () => {
  const block = pendingFillBlock();
  assert(
    /allowSameDirectionStacking/.test(block),
    "a confirmed pending fill must honour allowSameDirectionStacking — counting " +
      "positions is not the same check, and this is how four GBP/JPY longs opened",
  );
  assert(
    /p\.direction === pending\.direction/.test(block),
    "the pending-fill guard must compare direction, not just symbol",
  );
});

Deno.test("pending-fill path still enforces both position caps", () => {
  const block = pendingFillBlock();
  assert(/maxOpenPositions/.test(block), "max open positions cap missing from pending fill");
  assert(/maxPerSymbol/.test(block), "max per symbol cap missing from pending fill");
});

Deno.test("a refused pending fill is cancelled, not left hunting", () => {
  const block = pendingFillBlock();
  const cancels = block.match(/status:\s*"cancelled"/g) ?? [];
  assert(
    cancels.length >= 3,
    `expected each pending-fill refusal to cancel the order, found ${cancels.length}`,
  );
});

Deno.test("zone-confirmation-scanner does not filter bot_configs by bot_id", async () => {
  // bot_configs has no bot_id column — SQL_MIGRATION_BOT_ID.sql added it to
  // paper_accounts, paper_positions and paper_trade_history only. The filter
  // returned 42703, the error was discarded, and the function ran on `{}`.
  const zoneScanner = await Deno.readTextFile(
    new URL("../../functions/zone-confirmation-scanner/index.ts", import.meta.url),
  );
  const at = zoneScanner.indexOf('from("bot_configs")');
  assert(at > -1, "zone-confirmation-scanner should still read bot_configs");
  const block = zoneScanner.slice(at, at + 400);
  assert(
    !/bot_id/.test(block),
    "bot_configs has no bot_id column; filtering on it silently yields an empty config",
  );
  assert(
    /connection_id/.test(block),
    "config resolution should mirror bot-scanner's loadConfig (connection, then global)",
  );
});

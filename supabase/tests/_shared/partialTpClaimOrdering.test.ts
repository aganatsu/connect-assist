import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Partial take profit must claim the position before it books any money.
 *
 * The partial_tp_fired flag and its column landed 2026-04-17 (0ffd0a33,
 * "Fixed partial TP runaway") and are on main. The guard itself was correct.
 * The ordering was not: the history row was inserted and the account balance
 * credited FIRST, and the flag persisted afterwards, with none of the awaits
 * checking for an error. Anything failing in between — a rejected update, or
 * JSON.parse of signal_reason throwing — left the flag unset with the profit
 * already written, so the next manage cycle fired again.
 *
 * Measured on 2026-09-02, four months after that fix shipped:
 *
 *   39c5161f   16 fires in 29 minutes   2026-08-07 05:59-06:28   3,292.25
 *   7660699c    3 fires in 56 seconds   2026-08-07 12:32-12:33     816.75
 *
 * ~3,631 of phantom profit credited to paper_accounts.balance for two
 * positions that both closed at stop. It read as a profitable era; there
 * wasn't one.
 *
 * It has not recurred only because partialTPEnabled is false under the scalper
 * style, so the path cannot execute. Dormant, not fixed. These assertions exist
 * so it stays fixed when partial TP is turned back on.
 */

const src = await Deno.readTextFile(
  new URL("../../functions/paper-trading/index.ts", import.meta.url),
);

/** The partial-TP block, from its trigger test to the broker mirror. */
function partialBlock(): string {
  const start = src.indexOf("if (profitPips >= partialTriggerPips)");
  assert(start > -1, "partial TP trigger not found");
  const end = src.indexOf("Partial TP broker mirror", start);
  assert(end > start, "partial TP block is unterminated");
  return src.slice(start, end);
}

// The claim, the history row and the credit now commit in ONE transaction:
// settle_paper_partial (migration 20261006010000) checks partial_tp_fired
// under a row lock, sets it, writes history and posts the ledger entry keyed
// partial:<bot>:<position_id>:1. Sixteen fires book once — proven against
// real Postgres in paperSettlementLedger.test.ts. These assertions keep the
// edge function from booking anything outside that call.

Deno.test("the partial is claimed and booked by settle_paper_partial", () => {
  const block = partialBlock();
  assert(/await settlePaperPartial\(supabase, \{/.test(block), "the partial settles through the RPC");
  assert(/remainingSize: remainSize/.test(block), "the size reduction rides in the same call");
  assert(/positionSignalReason: claimedSignalReason/.test(block), "and so does the exit-flag update");
});

Deno.test("nothing is booked outside the settlement", () => {
  const block = partialBlock();
  assert(!/from\("paper_trade_history"\)/.test(block), "no direct history write");
  assert(!/from\("paper_accounts"\)/.test(block), "no direct balance write");
});

Deno.test("a lost or failed settlement books nothing and changes no local state", () => {
  const block = partialBlock();
  const guardAt = block.indexOf('if (partialSettlement.outcome !== "settled")');
  assert(guardAt > -1, "the outcome is checked");
  const syncAt = block.indexOf("exitFlags.partialTPActivated = true");
  assert(syncAt > guardAt, "local flags change only in the settled branch");
});

Deno.test("an unparseable signal_reason cannot cost us the guard", () => {
  const block = partialBlock();
  const parseAt = block.indexOf("JSON.parse(pos.signal_reason");
  assert(parseAt > -1, "signal_reason parse not found");
  const around = block.slice(Math.max(0, parseAt - 220), parseAt + 220);
  assert(
    /try\s*\{/.test(around) && /catch/.test(around),
    "parsing signal_reason must not be able to throw past the claim — a bad " +
      "blob previously skipped the flag write while the money was already booked",
  );
});

Deno.test("the position is not updated outside the settlement", () => {
  // The original code wrote the flag in a second update after booking.
  const block = partialBlock();
  const writes = block.match(/from\("paper_positions"\)\s*\n?\s*\.update|from\("paper_positions"\)\.update/g) ?? [];
  assert(writes.length === 0, `expected no direct paper_positions update in the partial path, found ${writes.length}`);
});

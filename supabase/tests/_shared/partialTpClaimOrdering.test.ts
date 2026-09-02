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

Deno.test("the claim is a compare-and-set on partial_tp_fired", () => {
  const block = partialBlock();
  assert(
    /\.eq\("partial_tp_fired",\s*false\)/.test(block),
    "the update must be conditional on partial_tp_fired = false, so a second " +
      "caller claims nothing",
  );
  assert(
    /\.select\("id"\)/.test(block),
    "the claim must return the row so the caller can tell whether it won",
  );
});

Deno.test("nothing is booked before the claim succeeds", () => {
  const block = partialBlock();
  const claimAt = block.indexOf('.eq("partial_tp_fired", false)');
  const historyAt = block.indexOf('from("paper_trade_history").insert');
  const balanceAt = block.indexOf('from("paper_accounts").update');

  assert(claimAt > -1, "claim not found");
  assert(historyAt > -1, "history insert not found");
  assert(balanceAt > -1, "balance update not found");

  assert(
    claimAt < historyAt,
    "the position must be claimed BEFORE the partial is written to history — " +
      "this ordering is the whole bug",
  );
  assert(
    claimAt < balanceAt,
    "the position must be claimed BEFORE the balance is credited",
  );
});

Deno.test("a failed or lost claim books nothing", () => {
  const block = partialBlock();
  assert(
    /claimErr\s*\|\|\s*!claimed\s*\|\|\s*claimed\.length === 0/.test(block),
    "an errored claim and an empty claim must both skip the booking",
  );
  assert(/claimErr/.test(block), "the claim error must be inspected, not discarded");
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

Deno.test("the position is not updated twice", () => {
  // The original code wrote the flag in a second update after booking. With the
  // claim doing it up front, a second write would reopen the same window.
  const block = partialBlock();
  const writes = block.match(/from\("paper_positions"\)\s*\n?\s*\.update|from\("paper_positions"\)\.update/g) ?? [];
  assert(
    writes.length === 1,
    `expected exactly one paper_positions update in the partial path, found ${writes.length}`,
  );
});

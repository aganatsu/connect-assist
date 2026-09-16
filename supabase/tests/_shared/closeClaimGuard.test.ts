import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * A position must be credited to the balance exactly once.
 *
 * Two scan cycles can pick up the same breach candidate. The close path
 * deleted the row, inserted history and updated the balance with no check that
 * it was the one that actually closed it — so both cycles credited the PnL.
 *
 * Measured 2026-09-16 from close_audit_log, four positions closed twice within
 * a second:
 *
 *   USD/JPY  credited 1742.38  should be  871.19
 *   XAU/USD  credited 1138.92  should be  569.46
 *   BTC/USD  credited -1068.52 should be -534.26
 *   BTC/USD  credited -1090.54 should be -545.27
 *
 * Net +361 of profit that never happened. Same mechanism as the phantom
 * partial-TP inflation that made the account balance unreconstructable.
 *
 * DELETE ... RETURNING is atomic: exactly one cycle gets the row back.
 */

const src = Deno.readTextFileSync(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

Deno.test("the delete claims the position and returns it", () => {
  assert(/const \{ data: claimed \} = await supabase\.from\("paper_positions"\)\.delete\(\)/
    .test(code), "the delete result is captured");
  assert(/\.select\("position_id"\);/.test(code), "with RETURNING, so it is atomic");
});

Deno.test("losing the race skips the close entirely", () => {
  // Not just the balance — the history insert too, or the second cycle writes
  // a duplicate history row for a position it did not close.
  assert(/if \(!claimed \|\| claimed\.length === 0\) \{/.test(code));
  // Windowed, not brace-matched: the guard logs `${pos.position_id}`, and
  // slicing to the first "}" stops inside that placeholder — which made this
  // assertion fail against correct code on the first draft.
  const guardBody = code.slice(
    code.indexOf("if (!claimed || claimed.length === 0) {"),
    code.indexOf("if (!claimed || claimed.length === 0) {") + 400,
  );
  assert(/continue;/.test(guardBody), "it continues rather than falling through");
  assert(guardBody.indexOf("continue;") < guardBody.indexOf("paper_trade_history"),
    "and skips the history insert too, not just the balance");
});

Deno.test("the claim happens before the balance is touched", () => {
  // Ordering is the whole guarantee. A check after the credit is no check.
  const claimAt = code.indexOf('const { data: claimed }');
  const balanceAt = code.indexOf("const newBal = curBal + pnl;");
  assert(claimAt > 0 && balanceAt > 0, "found both");
  assert(claimAt < balanceAt, "the claim precedes the balance update");
});

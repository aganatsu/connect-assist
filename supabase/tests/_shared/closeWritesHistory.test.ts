import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * A close must never lose the trade.
 *
 * bot-scanner closes in this order:
 *   1. DELETE the paper_positions row
 *   2. INSERT into paper_trade_history
 *   3. UPDATE the balance
 *
 * Step 2's error was not captured, so when freeze_streamlined_decision_origin()
 * RAISEd on the foreign contract PR #539 wrote there, the insert failed
 * silently and step 3 updated the balance anyway. The position was already
 * deleted. Closed trades vanished from history with the money moved — visible
 * only in close_audit_log.
 *
 * Two independent guards, because either alone still loses trades:
 * the right column, and a checked error.
 */

const src = Deno.readTextFileSync(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

Deno.test("the close path checks whether the history insert succeeded", () => {
  assert(/const \{ error: historyErr \} = await supabase\.from\("paper_trade_history"\)\.insert\(/
    .test(code), "the insert result is captured");
  assert(/if \(historyErr\)/.test(code), "and acted on");
  assert(/TRADE RECORD LOST/.test(src), "and says plainly what was lost");
});

Deno.test("nothing writes a foreign contract into streamlined_decision_origin", () => {
  // That column is owned by streamlined-decision-lifecycle.v1 and its trigger
  // refuses anything else. Writing the position's frozen-decision.v1 blob
  // there discarded the entire row.
  assert(!/streamlined_decision_origin: \(pos as any\)\.frozen_strategy_context/.test(code),
    "the frozen context must not be written to the streamlined column");
});

Deno.test("the frozen decision still reaches the closed trade", () => {
  // Dropping it entirely would re-open the question the record exists to
  // answer. It rides in signal_reason, next to sizing and slFloor.
  assert(/frozenDecision: fc/.test(code), "carried in signal_reason");
  assert(/JSON\.parse\(pos\.signal_reason\)/.test(code), "merged, not overwritten");
  assert(/catch \{/.test(code), "and a malformed signal_reason cannot break the close");
});

Deno.test("the migration lets the row through rather than refusing it", () => {
  // Losing the decision record is recoverable. Losing the trade is not — the
  // position row is already deleted by the time the insert runs.
  const mig = Deno.readTextFileSync(new URL(
    "../../migrations/20260916010000_history_insert_ignores_foreign_contract.sql",
    import.meta.url));
  assert(/IF payload->>'contractVersion' = 'frozen-decision\.v1' THEN/.test(mig));
  assert(/NEW\.streamlined_decision_origin := NULL;/.test(mig));
  assert(/<> 'streamlined-decision-lifecycle\.v1'/.test(mig),
    "the real streamlined contract is still validated");
});

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildFrozenDecision } from "../../functions/_shared/frozenDecision.ts";

/**
 * Step 2 of docs/FROZEN_DECISION_RECORD.md.
 *
 * sizingProvenance and slFloorTrace already existed, were correct, and reached
 * 3 of 63 Era C trades — because they were wired into one of four
 * position-creation routes. Measured, not guessed:
 *
 *   select coalesce(signal_reason::jsonb #>> '{sizing,signalSource}', 'unknown') ...
 *   -> standalone 3 trades, unknown 60
 *
 * So coverage is the whole problem. A perfectly shaped record on one route
 * leaves the next question exactly as unanswerable as the last one, and reads
 * as "these trades had no context" rather than "this route was missed".
 *
 * The coverage test is therefore the point of this file. Everything else is
 * supporting detail.
 */

const FN = (n: string) =>
  Deno.readTextFileSync(new URL(`../../functions/${n}/index.ts`, import.meta.url));

Deno.test("EVERY paper_positions insert writes a frozen context", () => {
  // The guard that makes the other tests meaningful. A fifth route added later
  // fails here rather than silently producing untraceable trades.
  const files = ["bot-scanner", "paper-trading", "zone-confirmation-scanner"];
  let total = 0;
  const missing: string[] = [];
  for (const f of files) {
    const src = FN(f);
    for (const m of src.matchAll(/from\("paper_positions"\)\.insert\(\{/g)) {
      total++;
      const block = src.slice(m.index!, m.index! + 1600);
      if (!block.includes("frozen_strategy_context")) {
        missing.push(`${f}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
  }
  assertEquals(missing, [], `routes without a frozen context: ${missing.join(", ")}`);
  assert(total >= 4, `expected at least the four known routes, found ${total}`);
});

Deno.test("pending orders freeze at placement, and fills inherit", () => {
  // A pending order's decision is made when it is placed. Rebuilding at fill
  // would record the market at execution time — a different question, answered
  // without anyone noticing the substitution.
  const scanner = FN("bot-scanner");
  assert(/route: "pending-order"/.test(scanner), "placement builds one");
  assert(/frozen_strategy_context: \(pending as any\)\.frozen_strategy_context \?\? null,/
    .test(scanner), "bot-scanner fill inherits");
  assert(/frozen_strategy_context: \(pending as any\)\.frozen_strategy_context \?\? null,/
    .test(FN("zone-confirmation-scanner")), "zone scanner fill inherits");
  // Both fill routes select("*"), so the column arrives without a query change.
  assert(/from\("pending_orders"\)\.select\("\*"\)/.test(scanner));
});

Deno.test("no route sets the hash itself", () => {
  // A BEFORE trigger computes md5 of Postgres's own normalised jsonb text,
  // which cannot be reproduced client-side. A caller setting it would fail the
  // CHECK on every insert.
  for (const f of ["bot-scanner", "paper-trading", "zone-confirmation-scanner"]) {
    assert(!/frozen_strategy_hash:/.test(FN(f)), `${f} must not set the hash`);
  }
});

Deno.test("the closed trade carries the decision, via signal_reason", () => {
  // So outcomes can be grouped by it without joining to a position row that
  // may no longer exist.
  //
  // This test previously REQUIRED the write to go to
  // streamlined_decision_origin, and that is what made the bug permanent: that
  // column belongs to the streamlined-decision-lifecycle.v1 contract and its
  // trigger RAISEs on anything else. The close path deletes the position
  // first and did not check the insert error, so every close discarded the
  // trade while still moving the balance. A test can pin a bug as firmly as
  // it pins a fix.
  const scanner = FN("bot-scanner");
  assert(!/streamlined_decision_origin: \(pos as any\)\.frozen_strategy_context/.test(scanner),
    "must not write a foreign contract to the streamlined column");
  assert(/frozenDecision: fc/.test(scanner), "the decision rides in signal_reason");
});

Deno.test("crossTimeframeContext is never invented", () => {
  // All 34 generated columns read that subtree, for a feature that is not
  // running. Filling it so they show values recreates the failure this exists
  // to fix.
  const shared = Deno.readTextFileSync(
    new URL("../../functions/_shared/frozenDecision.ts", import.meta.url),
  );
  const code = shared.split("\n").filter(l => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
  assert(!/crossTimeframeContext/.test(code));
});

// ─── the builder ─────────────────────────────────────────────────────────────

Deno.test("riskDollars is derived, so it cannot disagree with its inputs", () => {
  const d = buildFrozenDecision({
    route: "market-entry", balanceAtEntry: 54000, riskPercent: 1, sizeLots: 2.5,
  });
  assertEquals(d.risk.riskDollars, 540);
  assertEquals(d.risk.balanceAtEntry, 54000);
});

Deno.test("distance is measured from the prices as placed", () => {
  // Not read back from stop_loss, which trailing overwrites — the whole reason
  // the 8.4-pip question was unanswerable.
  const d = buildFrozenDecision({
    route: "market-entry", entryPrice: 1.16288, stopAtEntry: 1.16372, pipSize: 0.0001,
  });
  assertEquals(d.stop.distancePips, 8.4);
});

Deno.test("an unmeasured floor reads as unknown, not as structure", () => {
  // "structure" would assert that a stop was placed on structure when nobody
  // checked. The manual route genuinely does not know.
  const none = buildFrozenDecision({ route: "manual", entryPrice: 1.1, stopAtEntry: 1.09 });
  assertEquals(none.stop.source, "unknown");
  assertEquals(none.stop.floorApplied, null);

  const widened = buildFrozenDecision({
    route: "market-entry", slFloor: { widened: true, effectiveMinSlPips: 20 },
  });
  assertEquals(widened.stop.source, "floor");
  assertEquals(widened.stop.floorPips, 20);

  const structural = buildFrozenDecision({
    route: "market-entry", slFloor: { widened: false, effectiveMinSlPips: 20 },
  });
  assertEquals(structural.stop.source, "structure");
});

Deno.test("missing inputs are null, never a plausible default", () => {
  // A default here is indistinguishable from a measurement later, which is the
  // failure this whole record exists to prevent.
  const d = buildFrozenDecision({ route: "manual" });
  assertEquals(d.risk.balanceAtEntry, null);
  assertEquals(d.risk.riskDollars, null);
  assertEquals(d.stop.distancePips, null);
  assertEquals(d.config.hash, null);
  assertEquals(d.leg, null);
  assertEquals(d.contractVersion, "frozen-decision.v1");
});

Deno.test("NaN and Infinity do not reach the record", () => {
  const d = buildFrozenDecision({
    route: "market-entry", balanceAtEntry: NaN, riskPercent: Infinity, sizeLots: 0 / 0,
  });
  assertEquals(d.risk.balanceAtEntry, null);
  assertEquals(d.risk.riskPercent, null);
  assertEquals(d.risk.riskDollars, null);
  assertEquals(d.risk.sizeLots, null);
});

// Pending orders were cancelling and recreating themselves every scan cycle.
//
// The replace-stale block in bot-scanner matched on symbol+direction only and
// cancelled unconditionally, on the reasoning that a re-detected setup is a new
// trade idea. Production disagreed:
//
//   Superseded by new setup (score 39.2 vs old 39.2, entry 1.4043 vs old 1.4043)
//
// Same score, same entry. zone_touch_time and confirmation_attempts live on the
// order row, and zone-confirmation-scanner anchors its CHoCH search on
// zone_touch_time. Recreating the row nulls it, so confirmation restarted from
// scratch every cycle and could only succeed if CHoCH landed inside a single
// 5-minute gap.
//
// 1,047 cancellations, ~542 of them supersedes, and zero fills since
// 2026-05-15.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { shouldSupersedePendingOrder } from "../../functions/_shared/botConfigBehavior.ts";

// A representative EUR/USD zone: 20 pips wide, so tolerance is 1 pip.
const base = {
  newEntry: 1.10000,
  newStopLoss: 1.09800,
  newTakeProfit: 1.10400,
  newScore: 39.2,
  existingEntry: 1.10000,
  existingStopLoss: 1.09800,
  existingTakeProfit: 1.10400,
  existingScore: 39.2,
  zoneWidth: 0.00200,
};

Deno.test("identical setup is NOT superseded — this is the bug", () => {
  const d = shouldSupersedePendingOrder(base);
  assertEquals(
    d.supersede,
    false,
    "re-detecting the same setup must leave the order alone; cancelling it resets " +
      "zone_touch_time and restarts the CHoCH hunt",
  );
});

Deno.test("a materially moved entry IS superseded", () => {
  const d = shouldSupersedePendingOrder({ ...base, newEntry: 1.10500 });
  assertEquals(d.supersede, true);
  assertEquals(d.reason, "entry moved");
});

Deno.test("a moved stop is superseded — risk changed even if entry did not", () => {
  const d = shouldSupersedePendingOrder({ ...base, newStopLoss: 1.09000 });
  assertEquals(d.supersede, true);
  assertEquals(d.reason, "stop moved");
});

Deno.test("a moved target is superseded", () => {
  const d = shouldSupersedePendingOrder({ ...base, newTakeProfit: 1.11500 });
  assertEquals(d.supersede, true);
  assertEquals(d.reason, "target moved");
});

Deno.test("sub-tolerance drift does not churn the order", () => {
  // 0.2 pips on a 20-pip zone — recalculation noise, not a new idea.
  const d = shouldSupersedePendingOrder({ ...base, newEntry: 1.10002 });
  assertEquals(
    d.supersede,
    false,
    "tiny recalculation drift must not destroy accumulated confirmation state",
  );
});

Deno.test("tolerance scales with zone width, not absolute pips", () => {
  // Same 5-pip move, two instruments. On a tight 2-pip zone it is material;
  // inside a 200-pip gold zone it is noise. A fixed pip tolerance gets one wrong.
  const tight = shouldSupersedePendingOrder({
    ...base,
    zoneWidth: 0.00020,
    newEntry: base.existingEntry + 0.00050,
  });
  const wide = shouldSupersedePendingOrder({
    ...base,
    zoneWidth: 0.02000,
    newEntry: base.existingEntry + 0.00050,
  });
  assertEquals(tight.supersede, true, "material against a tight zone");
  assertEquals(wide.supersede, false, "noise inside a wide zone");
});

Deno.test("a materially different score is superseded", () => {
  const d = shouldSupersedePendingOrder({ ...base, newScore: 60 });
  assertEquals(d.supersede, true);
  assertEquals(d.reason, "score changed materially");
});

Deno.test("small score movement does not supersede", () => {
  const d = shouldSupersedePendingOrder({ ...base, newScore: 41 });
  assertEquals(d.supersede, false, "rescoring noise is not a new trade idea");
});

Deno.test("a null existing score does not force a supersede", () => {
  const d = shouldSupersedePendingOrder({ ...base, existingScore: null });
  assertEquals(
    d.supersede,
    false,
    "missing historical score is old data, not evidence the setup changed",
  );
});

Deno.test("zero/invalid zone width falls back to a relative epsilon, not zero tolerance", () => {
  // Zero tolerance would make float noise look material and reinstate the churn.
  const same = shouldSupersedePendingOrder({
    ...base,
    zoneWidth: 0,
    newEntry: base.existingEntry + 1e-12,
  });
  assertEquals(same.supersede, false, "a missing zone must not resurrect cancel-and-recreate");

  const moved = shouldSupersedePendingOrder({
    ...base,
    zoneWidth: 0,
    newEntry: base.existingEntry + 0.005,
  });
  assertEquals(moved.supersede, true, "but a real move must still be caught");
});

// ─── Wiring ──────────────────────────────────────────────────────────

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

Deno.test("scanner consults the decision before cancelling a pending order", () => {
  const block = scanner.slice(
    scanner.indexOf("Replace stale pending"),
    scanner.indexOf("GUARD: reject pending orders whose SL/TP orientation"),
  );
  assert(block.length > 0, "replace-stale block not found");
  const decide = block.indexOf("shouldSupersedePendingOrder(");
  const cancel = block.indexOf('status: "cancelled"');
  assert(decide > 0, "the cancel must be gated by the supersede decision");
  assert(cancel > 0, "cancel path not found");
  assert(decide < cancel, "the decision must be made BEFORE the cancel, not after");
});

Deno.test("scanner reads the state that would be destroyed, so the log can show it", () => {
  const block = scanner.slice(
    scanner.indexOf("Replace stale pending"),
    scanner.indexOf("GUARD: reject pending orders whose SL/TP orientation"),
  );
  assert(
    block.includes("zone_touch_time") && block.includes("confirmation_attempts"),
    "these are what a needless cancel throws away; selecting them makes the cost visible " +
      "in logs instead of silent",
  );
  assert(
    block.includes("stop_loss") && block.includes("take_profit"),
    "comparing only entry and score would miss a changed stop — the risk on the trade",
  );
});

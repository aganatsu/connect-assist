import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * The trade override editor told users "Changes take effect on the next scan
 * cycle (~15 min)".
 *
 * trade_overrides is consumed by scannerManagement (:371), which is reached by
 * the manage-positions-1min cron — schedule '* * * * *', every minute. Not the
 * scan cycle. And the scan cycle is 5 minutes anyway, per that migration's own
 * comment, not 15.
 *
 * So someone protecting a position at +1.35R was told to wait a quarter of an
 * hour for something that applies in sixty seconds — long enough to give up and
 * intervene by hand.
 */

const editor = await Deno.readTextFile(
  new URL("../../../src/components/TradeOverrideEditor.tsx", import.meta.url),
);
const mgmt = await Deno.readTextFile(
  new URL("../../functions/_shared/scannerManagement.ts", import.meta.url),
);
const cron = await Deno.readTextFile(
  new URL("../../migrations/20260501100000_add_management_cron.sql", import.meta.url),
);

Deno.test("the management cron really is every minute", () => {
  assert(/'manage-positions-1min',\s*\n?\s*'\* \* \* \* \*'/.test(cron),
    "the claim in the UI depends on this schedule");
});

Deno.test("scannerManagement is what consumes the overrides", () => {
  assert(/if \(pos\.trade_overrides\)/.test(mgmt), "the consumer must be the management path");
});

Deno.test("the stale 15-minute claim is gone everywhere", () => {
  assert(!/~15 min/.test(editor), "no 15-minute claim should remain");
  assert(!/next scan cycle/.test(editor), "overrides are not consumed on the scan cycle");
  assert(!/next bot scan cycle/.test(editor));
});

Deno.test("all three messages state the real latency", () => {
  assertEquals((editor.match(/every minute|~1 min/g) ?? []).length, 4,
    "toast (x2 branches) and both help texts");
});

Deno.test("the clear-overrides path says when it applies too", () => {
  // Clearing reverts to global config on the same cycle; saying nothing implied
  // it was instant.
  assert(/Overrides cleared — using global config, applies within ~1 min/.test(editor));
});

Deno.test("no implementation commentary leaked into user-facing copy", () => {
  // A first draft explained what the text used to say, which is a changelog,
  // not a UI string.
  assert(!/which is what this used to say/.test(editor));
});

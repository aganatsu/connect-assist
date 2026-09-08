import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * bot-scanner and zone-confirmation-scanner both mutate pending_orders every
 * minute, with no coordination. zone-confirmation-scanner SELECTs rows in
 * status 'awaiting_confirmation', does network work, then UPDATEs them by
 * order_id alone — so anything bot-scanner decided in between is overwritten.
 *
 * Observed 2026-09-08, GBP/JPY order 1044a680:
 *
 *   status                 pending
 *   cancel_reason          Price 208.96946 breached SL 208.96602
 *   resolved_at            2026-09-08 11:58:07
 *   confirmation_attempts  1
 *   zone_touch_time        (null)
 *
 * A row carrying a cancellation AND sitting in 'pending'. bot-scanner cancelled
 * it on the SL breach; zone-confirmation-scanner's zone-exit reset then wrote
 * 'pending' back over it, keeping the cancel fields. The order returned to the
 * live pool after being killed, and would be re-evaluated and could still fill.
 *
 * The same row also settles two other things: confirmation_attempts = 1 proves
 * the pending -> awaiting_confirmation transition WORKS (so the CHECK
 * constraint was never the blocker), and it proves zone touches do happen.
 */

const confirmScanner = await Deno.readTextFile(
  new URL("../../functions/zone-confirmation-scanner/index.ts", import.meta.url),
);

Deno.test("the zone-exit reset cannot revive a resolved order", () => {
  const i = confirmScanner.indexOf("if (resetsHunt) {");
  assert(i > -1, "the reset branch was not found");
  const block = confirmScanner.slice(i, confirmScanner.indexOf("resetToPending++", i));
  assert(/status: "pending"/.test(block), "this is the reset that caused it");
  assert(
    /\.eq\("status", "awaiting_confirmation"\)/.test(block),
    "the update must require the order to STILL be hunting",
  );
});

Deno.test("the guard is on the update, not just the select", () => {
  // Filtering the SELECT is not enough — the row can change between the read
  // and the write, which is exactly what happened.
  const i = confirmScanner.indexOf("if (resetsHunt) {");
  const block = confirmScanner.slice(i, confirmScanner.indexOf("resetToPending++", i));
  const upd = block.indexOf('from("pending_orders").update');
  const grd = block.indexOf('.eq("status", "awaiting_confirmation")');
  assert(upd > -1 && grd > upd, "the guard must be part of the UPDATE chain");
});

Deno.test("every write in this function is a compare-and-set", () => {
  // Any unguarded write to a row this function selected can clobber a decision
  // made by bot-scanner in the same minute.
  const updates = [...confirmScanner.matchAll(
    /from\("pending_orders"\)\.update\(\{[\s\S]*?\}\)((?:\s*\.eq\([^)]*\))+);/g,
  )];
  assert(updates.length > 0, "found no updates — the regex has drifted");
  for (const m of updates) {
    assert(
      /\.eq\("status",/.test(m[1]),
      `an update to pending_orders has no status guard:\n${m[0].slice(0, 160)}`,
    );
  }
});

Deno.test("a resolved order is terminal — the observed row was not", () => {
  // Encodes the invariant the race broke: cancel_reason or resolved_at present
  // means the order is finished, whatever status says.
  const resolved = (r: { status: string; cancel_reason?: string | null; resolved_at?: string | null }) =>
    !!r.cancel_reason || !!r.resolved_at;
  const live = (r: { status: string }) => r.status === "pending" || r.status === "awaiting_confirmation";

  const observed = {
    status: "pending",
    cancel_reason: "Price 208.96946 breached SL 208.96602",
    resolved_at: "2026-09-08 11:58:07",
  };
  assertEquals(resolved(observed) && live(observed), true,
    "the observed row was both resolved and live — the contradiction being fixed");

  const healthy = { status: "cancelled", cancel_reason: "x", resolved_at: "y" };
  assertEquals(resolved(healthy) && live(healthy), false);
});

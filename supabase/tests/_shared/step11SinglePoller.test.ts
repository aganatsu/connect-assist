/**
 * STEP 11 — one Route 2 poller. zone-confirmation-scanner (the second poller)
 * filled 6 of 16 fills and made 9 cancels in the 8 days before the reset, with
 * different caps (3 open / 2 per symbol vs 7 / 3) and no expiry, SL or thesis
 * checks. Under simplification.secondPollerEnabled=false it does nothing for
 * the account; the bot-scanner hunt covers every lifecycle action.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveSimplification } from "../../functions/_shared/simplification.ts";

const zcs = Deno.readTextFileSync(new URL("../../functions/zone-confirmation-scanner/index.ts", import.meta.url));
const scanner = Deno.readTextFileSync(new URL("../../functions/bot-scanner/index.ts", import.meta.url));

Deno.test("switch defaults to the second poller ON (legacy); false only when configured", () => {
  assertEquals(resolveSimplification({}).secondPollerEnabled, true);
  assertEquals(resolveSimplification({ simplification: { secondPollerEnabled: "no" } }).secondPollerEnabled, true);
  assertEquals(resolveSimplification({ simplification: { secondPollerEnabled: false } }).secondPollerEnabled, false);
});

Deno.test("disabled: the account is skipped before any order is touched or any candle fetched", () => {
  const skip = zcs.indexOf("resolveSimplification((botConfig?.config_json ?? {}) as Record<string, unknown>).secondPollerEnabled === false");
  const map = zcs.indexOf("userDataMap[userId] = {");
  const loop = zcs.indexOf("for (const pending of huntingOrders) {");
  assert(skip > 0 && skip < map && map < loop, "skip happens before the account is registered for the order loop");
  assert(/continue;/.test(zcs.slice(skip, skip + 400)));
  // Orders without a registered account are passed over untouched.
  assert(/if \(!userData\) \{ stillHunting\+\+; continue; \}/.test(zcs));
});

Deno.test("the hunt alone covers every Route 2 lifecycle action", () => {
  for (const [what, re] of [
    ["arm on touch", /status: "awaiting_confirmation",/],
    ["expiry", /if \(pending\.expires_at && new Date\(pending\.expires_at\) <= new Date\(\)\) \{/],
    ["impulse broken", /terminal_reason: "CANCELLED_IMPULSE_BROKEN" as TerminalReason/],
    ["zone exit reset", /outcome: "reset_zone_exit"/],
    ["position cap", /terminal_reason: "CANCELLED_POSITION_CAP" as TerminalReason/],
    ["atomic fill", /const claim = await claimRoute2Fill\(supabase, \{/],
    ["dry-run fill", /if \(\(pending as any\)\.dry_run === true\) \{/],
  ] as [string, RegExp][]) {
    assert(re.test(scanner), `hunt handles ${what}`);
  }
});

Deno.test("only the second poller applied the refined-zone-failure cancel (dropped with it; was TEST)", () => {
  assert(/CANCELLED_REFINED_ZONE_FAILURE/.test(zcs));
  assert(!/CANCELLED_REFINED_ZONE_FAILURE/.test(scanner));
});

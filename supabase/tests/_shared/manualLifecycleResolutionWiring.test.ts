import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../../", import.meta.url);
const scanner = await Deno.readTextFile(
  new URL("supabase/functions/bot-scanner/index.ts", root),
);
const api = await Deno.readTextFile(new URL("src/lib/api.ts", root));

Deno.test("manual staged and pending resolution advance the linked impulse lifecycle", () => {
  const staged = scanner.slice(
    scanner.indexOf('if (action === "dismiss_staged")'),
    scanner.indexOf('// ── Pending Orders: Get all pending orders', scanner.indexOf('if (action === "dismiss_staged")')),
  );
  const pending = scanner.slice(
    scanner.indexOf('if (action === "cancel_pending")'),
    scanner.indexOf('// ── Setup Staging: Get only active', scanner.indexOf('if (action === "cancel_pending")')),
  );
  assertStringIncludes(staged, "resolveStoredImpulseEntryLifecycle(");
  assertStringIncludes(pending, "resolveStoredImpulseEntryLifecycle(");
  assertStringIncludes(api, 'invokeFunction("bot-scanner", { action: "dismiss_staged", setupId })');
  assert(
    !api.includes('.from("staged_setups")\n      .update({\n        status: "invalidated"'),
    "the UI must not bypass the lifecycle-aware dismissal route",
  );
});

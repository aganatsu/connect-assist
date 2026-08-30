import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

Deno.test("management-only passes do not increment staged discovery cycles", () => {
  const stagingStart = scanner.indexOf(
    "// ── Setup Staging: Fetch active staged setups for this user/bot ──",
  );
  const pendingStart = scanner.indexOf(
    "// ── Limit Orders: Monitor active pending orders for fills/expiry ──",
    stagingStart,
  );
  assert(stagingStart >= 0 && pendingStart > stagingStart);
  const staging = scanner.slice(stagingStart, pendingStart);
  assertStringIncludes(staging, "if (stagingEnabled && !opts?.isManagementOnly)");
  assert(
    !staging.includes("if (stagingEnabled) {"),
    "the management loop runs multiple times per minute and must not own discovery-cycle accounting",
  );
});

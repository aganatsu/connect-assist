import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const paperTradingUrl = new URL("../../functions/paper-trading/index.ts", import.meta.url);

Deno.test("execution mode validates input and returns the persisted value", async () => {
  const source = await Deno.readTextFile(paperTradingUrl.pathname);
  assertStringIncludes(
    source,
    'if (requestedMode !== "paper" && requestedMode !== "live")',
  );
  assertStringIncludes(source, '.select("execution_mode")');
  assertStringIncludes(source, "modeUpdateError");
  assertStringIncludes(
    source,
    "persistedAccount.execution_mode !== requestedMode",
  );
  assertStringIncludes(
    source,
    "executionMode: persistedAccount.execution_mode",
  );
});

Deno.test("live mode requires an active broker connection", async () => {
  const source = await Deno.readTextFile(paperTradingUrl.pathname);
  assertStringIncludes(source, 'requestedMode === "live"');
  assertStringIncludes(source, '.from("broker_connections")');
  assertStringIncludes(source, '.eq("is_active", true)');
  assertStringIncludes(source, "active_broker_required");
});

Deno.test("paper mode cannot orphan an open managed position", async () => {
  const source = await Deno.readTextFile(paperTradingUrl.pathname);
  assertStringIncludes(source, 'requestedMode === "paper"');
  assertStringIncludes(source, '.from("paper_positions")');
  assertStringIncludes(source, '.eq("position_status", "open")');
  assertStringIncludes(source, "open_positions_require_live_management");
});

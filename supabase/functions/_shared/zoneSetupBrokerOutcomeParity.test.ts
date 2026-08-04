import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(new URL(
  "../../migrations/20260804050000_align_zone_setup_broker_outcomes.sql", import.meta.url,
));
const scanner = await Deno.readTextFile(new URL("../bot-scanner/index.ts", import.meta.url));

Deno.test("Zone Setup status follows confirmed broker outcome", () => {
  assertStringIncludes(migration, "$s$reconciliation_required$s$");
  assertStringIncludes(migration, "$s$broker_rejected$s$");
  assertStringIncludes(migration, "WHEN v_state = $s$confirmed$s$ THEN $s$filled$s$");
  assertStringIncludes(migration, "SELECT position.source_pending_order_id");
  assertStringIncludes(migration, "WHEN NEW.status IN ($s$reconciliation_required$s$, $s$broker_rejected$s$) THEN $s$pending$s$");
});

Deno.test("reconciliation-required Zone Setups are visible but not rescanned", () => {
  const actionStart = scanner.indexOf(`if (action === "active_pending")`);
  const actionEnd = scanner.indexOf("// ── Pending Orders: Cancel", actionStart);
  assertStringIncludes(scanner.slice(actionStart, actionEnd), `"reconciliation_required"`);
  const monitorStart = scanner.indexOf("const { data: activePendingOrders }");
  const monitorEnd = scanner.indexOf("// ── Management-Only Early Return", monitorStart);
  const monitor = scanner.slice(monitorStart, monitorEnd);
  assertStringIncludes(monitor, `["pending", "awaiting_confirmation"]`);
});

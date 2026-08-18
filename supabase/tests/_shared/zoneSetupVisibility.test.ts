import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const api = await Deno.readTextFile(
  new URL("../../../src/lib/api.ts", import.meta.url),
);
const panel = await Deno.readTextFile(
  new URL("../../../src/components/PendingOrdersPanel.tsx", import.meta.url),
);

Deno.test("Zone Setup snapshot keeps active and resolved lifecycle rows visible", () => {
  const actionStart = scanner.indexOf('if (action === "pending_orders")');
  const actionEnd = scanner.indexOf("// ── Pending Orders: Get only active", actionStart);
  const section = scanner.slice(actionStart, actionEnd);

  assertStringIncludes(section, 'statusFilter === "snapshot"');
  assertStringIncludes(section, '"awaiting_confirmation"');
  assertStringIncludes(section, '"reconciliation_required"');
  assertStringIncludes(section, '"filled"');
  assertStringIncludes(section, '"broker_rejected"');
  assertStringIncludes(section, '.order("resolved_at", { ascending: false');
  assertStringIncludes(section, "if (activeResult.error)");
  assertStringIncludes(section, "if (historyResult.error)");
  assert(
    section.indexOf("const activeResult = await") <
      section.indexOf("const historyResult = await"),
    "Active rows must be read before terminal rows so a transition cannot vanish from both queries",
  );
});

Deno.test("Zone Setup polling preserves the last known state on a transient failure", () => {
  assertStringIncludes(api, 'status: "snapshot"');
  assertStringIncludes(api, "fallback: true");
  assertStringIncludes(panel, "scannerApi.pendingSnapshot()");
  assertStringIncludes(panel, "if (snapshot.fallback)");

  const fallbackStart = panel.indexOf("if (snapshot.fallback)");
  const successfulUpdate = panel.indexOf("setOrders(snapshot.active)");
  assert(fallbackStart >= 0 && successfulUpdate > fallbackStart);
  const fallbackBranch = panel.slice(fallbackStart, successfulUpdate);
  assert(
    !fallbackBranch.includes("setOrders("),
    "A transient polling failure must not erase the last known active setups",
  );
});

Deno.test("Zone Setup history is not silently truncated to twenty rows", () => {
  assertStringIncludes(panel, "history.map((order)");
  assert(
    !panel.includes("history.slice(0, 20)"),
    "Resolved setup history must remain available in the scrollable history list",
  );
});

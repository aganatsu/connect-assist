import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

async function source(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, import.meta.url));
}

function section(text: string, start: string, end: string): string {
  return text.split(start)[1]?.split(end)[0] || "";
}

Deno.test("full closes have one broker writer and finalize only after reconciliation", async () => {
  const [paper, scanner, zone, reconcile] = await Promise.all([
    source("../../functions/paper-trading/index.ts"),
    source("../../functions/bot-scanner/index.ts"),
    source("../../functions/zone-confirmation-scanner/index.ts"),
    source("../../functions/_shared/reconcileBrokerState.ts"),
  ]);

  assertStringIncludes(paper, "reconcileFullBrokerClose");
  assertEquals(paper.includes("async function closeBrokerPositions"), false);
  assertEquals(paper.includes('actionType: "POSITION_CLOSE_ID"'), false);
  assertEquals(paper.includes("executeBrokerOrderWithLedger"), false);

  const statusEngine = section(
    paper,
    'if (payload.processEngine === true',
    "// Re-fetch positions after auto-closes",
  );
  assertStringIncludes(statusEngine, 'route: "paper_auto_exit"');
  assert(
    statusEngine.indexOf("reconcileFullBrokerClose({") <
      statusEngine.indexOf("finalizePaperPositionClose(serviceSupabase"),
  );

  const manual = section(
    paper,
    'if (action === "close_position")',
    "// ── Engine controls",
  );
  assertStringIncludes(manual, 'route: "manual_close"');
  assert(
    manual.indexOf("reconcileFullBrokerClose({") <
      manual.indexOf("finalizePaperPositionClose(serviceSupabase"),
  );
  assertStringIncludes(manual, 'code: "broker_close_reconciliation_required"');
  assertStringIncludes(manual, 'finalization.code === "already_resolved"');
  assertStringIncludes(manual, "Internal close finalization failed");

  const kill = section(
    paper,
    'if (action === "kill_switch")',
    "// Helper: read configured starting balance",
  );
  assertStringIncludes(kill, 'route: "kill_switch"');
  assertStringIncludes(kill, "kill_switch_activation_failed");
  assertStringIncludes(kill, "kill_switch_position_read_failed");
  assert(
    kill.indexOf("persistPaperEngineHalt(") <
      kill.indexOf("reconcileFullBrokerClose({"),
    "Kill switch must halt the engine before any broker close is attempted",
  );
  assert(
    kill.indexOf("reconcileFullBrokerClose({") <
      kill.indexOf("finalizePaperPositionClose(serviceSupabase"),
  );
  assertStringIncludes(kill, 'code: "broker_close_reconciliation_required"');
  assert(
    kill.indexOf('code: "broker_close_reconciliation_required"') <
      kill.indexOf('kill_switch_active: false'),
    "An unresolved close must return while the kill switch remains active",
  );

  const reset = section(
    paper,
    'if (action === "reset_account")',
    'if (action === "set_execution_mode")',
  );
  assertStringIncludes(reset, 'route: "account_reset"');
  assertStringIncludes(reset, "account_reset_halt_failed");
  assert(
    reset.indexOf("persistPaperEngineHalt(") <
      reset.indexOf("reconcileFullBrokerClose({"),
    "Account reset must halt the engine before broker reconciliation",
  );
  assert(
    reset.indexOf("reconcileFullBrokerClose({") <
      reset.indexOf('from("paper_positions").delete()'),
  );

  const stopClose = section(
    scanner,
    "if (hitPrice && closeReason)",
    "// 6. Telegram notification",
  );
  assertStringIncludes(stopClose, 'route: "scanner_breach"');
  assert(
    stopClose.indexOf("reconcileFullBrokerClose({") <
      stopClose.indexOf("finalizePaperPositionClose(supabase"),
  );
  assertEquals(stopClose.includes('actionType: "POSITION_CLOSE_ID"'), false);

  const reversalClose = section(
    scanner,
    "const closeOppositePositionsAfterEntry = async () =>",
    "const orderId =",
  );
  assertStringIncludes(reversalClose, 'route: "reverse_signal"');
  assert(
    reversalClose.indexOf("reconcileFullBrokerClose({") <
      reversalClose.indexOf("finalizePaperPositionClose(supabase"),
  );
  assertEquals(reversalClose.includes('actionType: "POSITION_CLOSE_ID"'), false);

  assertEquals(
    (scanner.match(/confirmationMode: "metaapi_position_open"/g) || []).length,
    1,
  );
  assertEquals(
    (zone.match(/confirmationMode: "metaapi_position_open"/g) || []).length,
    1,
  );

  assertStringIncludes(reconcile, "export async function reconcileFullBrokerClose");
  assertStringIncludes(reconcile, "executeBrokerOrderWithLedger(");
  assertStringIncludes(reconcile, '/trades?state=CLOSED&count=500');
  assertStringIncludes(reconcile, '/history-deals/position/${encodeURIComponent(brokerPositionId)}');
  assertStringIncludes(reconcile, '"oanda_trade_orders"');
  assertStringIncludes(reconcile, '"oanda_order_fill"');
  assertStringIncludes(reconcile, '"metaapi_trade"');

  const propEmergency = await source("../../functions/_shared/propFirmGate.ts");
  const propClose = section(
    propEmergency,
    "export async function propFirmEmergencyClose",
    "// ─── Helper: Log prop firm event",
  );
  assertStringIncludes(propClose, 'route: "prop_firm_emergency"');
  assert(
    propClose.indexOf("reconcileFullBrokerClose({") <
      propClose.indexOf("finalizePaperPositionClose(supabase"),
  );
  assertStringIncludes(propClose, "complete: unresolved.length === 0");
});

Deno.test("manual live placement fails closed before creating a paper position", async () => {
  const paper = await source("../../functions/paper-trading/index.ts");
  const manualPlace = section(
    paper,
    'if (action === "place_order")',
    "// ── Update SL/TP on an open position",
  );
  const liveGuardAt = manualPlace.indexOf(
    'if (executionMode === "live")',
  );
  const insertAt = manualPlace.indexOf(
    'supabase.from("paper_positions").insert',
  );
  assertStringIncludes(manualPlace, "if (accountError) throw accountError;");
  assertStringIncludes(manualPlace, "if (accountInsertError) throw accountInsertError;");
  assertStringIncludes(manualPlace, 'code: "manual_live_order_requires_broker_first"');
  assertEquals(manualPlace.includes("mt5Mirror"), false);
  assertEquals(manualPlace.includes("mirrorToMT5"), false);
  assertEquals(manualPlace.includes("finalize_live_broker_position"), false);
  assertEquals(liveGuardAt >= 0, true);
  assertEquals(insertAt > liveGuardAt, true);
});

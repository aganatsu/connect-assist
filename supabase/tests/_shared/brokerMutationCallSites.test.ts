import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

async function source(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, import.meta.url));
}

function section(text: string, start: string, end: string): string {
  return text.split(start)[1]?.split(end)[0] || "";
}

Deno.test("every direct broker mutation requires positive confirmation", async () => {
  const [paper, scanner, zone, reconcile] = await Promise.all([
    source("../../functions/paper-trading/index.ts"),
    source("../../functions/bot-scanner/index.ts"),
    source("../../functions/zone-confirmation-scanner/index.ts"),
    source("../../functions/_shared/reconcileBrokerState.ts"),
  ]);

  const manualOpen = section(
    paper,
    "async function mirrorToMT5",
    "async function closeBrokerPositions",
  );
  assertStringIncludes(manualOpen, "executeBrokerOrderWithLedger(");
  assertStringIncludes(manualOpen, 'route: "manual_place_order"');
  assertStringIncludes(manualOpen, 'confirmationMode: "metaapi_position_open"');

  const paperClose = section(
    paper,
    "async function closeBrokerPositions",
    "// ─── Get Live FX Rates",
  );
  assertStringIncludes(paperClose, "classifyBrokerMutationHttpResponse(");
  assertStringIncludes(paperClose, '"metaapi_trade"');

  const stopClose = section(
    scanner,
    "// 5. Mirror close to broker if live mode + mirrored connections exist",
    "// 6. Telegram notification",
  );
  assertStringIncludes(stopClose, '"oanda_order_fill"');
  assertStringIncludes(stopClose, '"metaapi_trade"');
  assertStringIncludes(stopClose, "{ allowFailover: false }");
  assertEquals(stopClose.includes("closeRes.ok ? \"closed\""), false);

  const reversalClose = section(
    scanner,
    "const closeOppositePositionsAfterEntry = async () =>",
    "const orderId =",
  );
  assertStringIncludes(reversalClose, '"oanda_order_fill"');
  assertStringIncludes(reversalClose, '"metaapi_trade"');
  assertStringIncludes(reversalClose, "{ allowFailover: false }");
  assertEquals(reversalClose.includes("if (closeRes.ok)"), false);

  assertEquals(
    (scanner.match(/confirmationMode: "metaapi_position_open"/g) || [])
      .length,
    1,
  );
  assertEquals(
    (zone.match(/confirmationMode: "metaapi_position_open"/g) || []).length,
    1,
  );

  assertStringIncludes(reconcile, '"oanda_trade_orders"');
  assertStringIncludes(reconcile, '"oanda_order_fill"');
  assertStringIncludes(reconcile, '"metaapi_trade"');
  assertEquals(reconcile.includes("if (res.ok) return { ok: true"), false);
});

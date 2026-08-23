import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile(
  new URL(
    "../../functions/broker-execute/index.ts",
    import.meta.url,
  ),
);

Deno.test("manual broker mutations use the shared response classifier", () => {
  assertStringIncludes(
    source,
    "classifyBrokerExecutionResponse,",
  );
  assertStringIncludes(source, '"metaapi_trade"');
  assertStringIncludes(source, '"oanda_order_fill"');
  assertStringIncludes(source, '"oanda_trade_orders"');

  const placeSection = source.split('if (action === "place_order")')[1]
    ?.split('if (action === "account_balance")')[0] || "";
  const closeSection = source.split('if (action === "close_trade")')[1]
    ?.split('if (action === "trade_history")')[0] || "";
  const modifySection = source.split('if (action === "modify_trade")')[1]
    ?.split('return respond({ error: "Unknown action" })')[0] || "";
  assertStringIncludes(
    placeSection,
    "return respondWithBrokerMutationOutcome(",
  );
  assertStringIncludes(
    closeSection,
    "return respondWithBrokerMutationOutcome(",
  );
  assertStringIncludes(
    modifySection,
    "return respondWithBrokerMutationOutcome(",
  );
});

Deno.test("manual broker mutations dispatch once without internal retry or region failover", () => {
  const placeSection = source.split('if (action === "place_order")')[1]
    ?.split('if (action === "account_balance")')[0] || "";
  const closeSection = source.split('if (action === "close_trade")')[1]
    ?.split('if (action === "trade_history")')[0] || "";
  const modifySection = source.split('if (action === "modify_trade")')[1]
    ?.split('return respond({ error: "Unknown action" })')[0] || "";

  assertEquals(source.includes("retryWithBackoff"), false);
  assertStringIncludes(placeSection, "{ allowFailover: false }");
  assertStringIncludes(closeSection, "{ allowFailover: false }");
  assertStringIncludes(modifySection, "{ allowFailover: false }");
});

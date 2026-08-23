import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile(
  new URL(
    "../../functions/broker-execute/index.ts",
    import.meta.url,
  ),
);

Deno.test("manual MetaAPI close and modify use the shared response classifier", () => {
  assertStringIncludes(
    source,
    'import { classifyBrokerExecutionResponse } from "../_shared/brokerExecutionLedger.ts";',
  );
  assertStringIncludes(source, 'confirmationMode: "metaapi_trade"');

  const closeSection = source.split('if (action === "close_trade")')[1]
    ?.split('if (action === "trade_history")')[0] || "";
  const modifySection = source.split('if (action === "modify_trade")')[1]
    ?.split('return respond({ error: "Unknown action" })')[0] || "";
  assertStringIncludes(
    closeSection,
    "return respondWithMetaApiMutationOutcome(result.res, result.body);",
  );
  assertStringIncludes(
    modifySection,
    "return respondWithMetaApiMutationOutcome(res, body);",
  );
});

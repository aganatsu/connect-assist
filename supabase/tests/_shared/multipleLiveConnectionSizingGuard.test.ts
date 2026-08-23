import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  checkBrokerConnectionAvailabilityAtExecution,
  checkBrokerConnectionSizingAtExecution,
  LIVE_BROKER_CONNECTION_REQUIRED,
  MULTIPLE_LIVE_CONNECTIONS_REQUIRE_PER_CONNECTION_SIZING,
} from "../../functions/_shared/finalRuntimeGates.ts";

const decoder = new TextDecoder();
const read = (path: string) => decoder.decode(Deno.readFileSync(path));

Deno.test("live execution requires a broker connection before internal fill", () => {
  assertEquals(
    checkBrokerConnectionAvailabilityAtExecution({
      executionMode: "live",
      executionConnectionCount: 0,
    }),
    { passed: false, reason: LIVE_BROKER_CONNECTION_REQUIRED },
  );
  assertEquals(
    checkBrokerConnectionAvailabilityAtExecution({
      executionMode: "live",
      executionConnectionCount: 1,
    }).passed,
    true,
  );
  assertEquals(
    checkBrokerConnectionAvailabilityAtExecution({
      executionMode: "live",
      executionConnectionCount: null,
    }),
    {
      passed: true,
      reason: "This authorization stage does not send a broker order",
    },
  );
});

Deno.test("shared-size broker guard applies only to live fan-out", () => {
  assertEquals(
    checkBrokerConnectionSizingAtExecution({
      executionMode: "paper",
      executionConnectionCount: 4,
    }).passed,
    true,
  );
  assertEquals(
    checkBrokerConnectionSizingAtExecution({
      executionMode: "live",
      executionConnectionCount: 1,
    }).passed,
    true,
  );
  assertEquals(
    checkBrokerConnectionSizingAtExecution({
      executionMode: "live",
      executionConnectionCount: null,
    }).passed,
    true,
  );
  assertEquals(
    checkBrokerConnectionSizingAtExecution({
      executionMode: "live",
      executionConnectionCount: 2,
    }),
    {
      passed: false,
      reason: MULTIPLE_LIVE_CONNECTIONS_REQUIRE_PER_CONNECTION_SIZING,
    },
  );
});

Deno.test("direct live entry guards the authorized connection set before persistence and broker send", () => {
  const source = read("supabase/functions/bot-scanner/index.ts");
  const routeStart = source.indexOf("const { data: directConnections }");
  const guardAt = source.indexOf(
    "brokerExecutionConnectionCount: (directConnections || []).length",
    routeStart,
  );
  const finalizeAt = source.indexOf(
    'supabase.rpc("finalize_market_entry"',
    routeStart,
  );
  const mirrorAt = source.indexOf(
    "const connections = directConnections || [];",
    finalizeAt,
  );
  const sendAt = source.indexOf("executeBrokerOrderWithLedger(", mirrorAt);

  assertEquals(routeStart >= 0, true);
  assertEquals(guardAt > routeStart, true);
  assertEquals(finalizeAt > guardAt, true);
  assertEquals(mirrorAt > finalizeAt, true);
  assertEquals(sendAt > mirrorAt, true);
  assertStringIncludes(
    source.slice(mirrorAt, sendAt),
    "directConnections || []",
  );
});

Deno.test("confirmation fill guards its broker target set before persistence and broker send", () => {
  const source = read("supabase/functions/zone-confirmation-scanner/index.ts");
  const targetSetAt = source.indexOf("const approvedBrokerConnections");
  const guardAt = source.indexOf(
    "brokerExecutionConnectionCount: approvedBrokerConnections.length",
    targetSetAt,
  );
  const finalizeAt = source.indexOf(
    'supabase.rpc("finalize_pending_order_fill"',
    guardAt,
  );
  const mirrorAt = source.indexOf(
    "for (const conn of approvedBrokerConnections)",
    finalizeAt,
  );
  const sendAt = source.indexOf("executeBrokerOrderWithLedger(", mirrorAt);

  assertEquals(targetSetAt >= 0, true);
  assertEquals(guardAt > targetSetAt, true);
  assertEquals(finalizeAt > guardAt, true);
  assertEquals(mirrorAt > finalizeAt, true);
  assertEquals(sendAt > mirrorAt, true);
});

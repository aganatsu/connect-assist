import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260827140000_add_commission_mode.sql",
    import.meta.url,
  ),
);
const brokerApi = await Deno.readTextFile(
  new URL("../../functions/broker-connections/index.ts", import.meta.url),
);
const brokerUi = await Deno.readTextFile(
  new URL("../../../src/pages/Brokers.tsx", import.meta.url),
);
const runtimeStore = await Deno.readTextFile(
  new URL("../../functions/_shared/runtimeConfigStore.ts", import.meta.url),
);
const botConfigApi = await Deno.readTextFile(
  new URL("../../functions/bot-config/index.ts", import.meta.url),
);
const recommendations = await Deno.readTextFile(
  new URL("../../../src/components/config/EnterTab.tsx", import.meta.url),
);
const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const fastScanner = await Deno.readTextFile(
  new URL("../../functions/zone-confirmation-scanner/index.ts", import.meta.url),
);

Deno.test("broker commission mode is explicit from storage through the UI", () => {
  assertStringIncludes(migration, "commission_mode");
  assertStringIncludes(migration, "'auto', 'manual', 'none'");
  assertStringIncludes(migration, "broker_connections_manual_commission_check");
  assertStringIncludes(brokerApi, "commission_mode");
  assertStringIncludes(brokerApi, "effective_commission_per_lot");
  assertStringIncludes(brokerUi, "Automatic — use broker-detected commission");
  assertStringIncludes(brokerUi, "No commission — spread-only account");
  assertStringIncludes(brokerUi, "round trip");
  assertStringIncludes(scanner, "resolveRoundTripCommission(conn)");
  assertStringIncludes(scanner, "averageRoundTripCommission(commConns)");
  assertStringIncludes(
    fastScanner,
    "averageRoundTripCommission(approvedBrokerConnections)",
  );
  assert(
    !scanner.includes('detected_commission_per_lot ?? "0") * 2'),
    "scanner must not keep a second inline commission resolver",
  );
});

Deno.test("runtime verification exposes the effective minimum R:R and spread policy", () => {
  assertStringIncludes(runtimeStore, "minRiskReward:");
  assertStringIncludes(runtimeStore, "spreadFilterEnabled:");
  assertStringIncludes(runtimeStore, "maxSpreadPips:");
  assertStringIncludes(botConfigApi, "typeof r.minRR");
  assertStringIncludes(botConfigApi, "minRR: 1.5");
});

Deno.test("recommended pair overrides use canonical slashed symbols", () => {
  for (const symbol of [
    "EUR/JPY",
    "GBP/USD",
    "USD/CAD",
    "USD/CHF",
    "NZD/CHF",
    "XAU/USD",
    "BTC/USD",
  ]) {
    assertStringIncludes(recommendations, `'${symbol}'`);
  }
  const recommendationBlock = recommendations.split(
    "const RECOMMENDED_OVERRIDES",
  )[1]?.split("const OVERRIDE_FIELDS")[0] || "";
  assert(
    !/'(?:EURJPY|GBPUSD|USDCAD|USDCHF|NZDCHF|XAUUSD|BTCUSD)'/.test(
      recommendationBlock,
    ),
    "recommendations must not write unreachable slashless override keys",
  );
});

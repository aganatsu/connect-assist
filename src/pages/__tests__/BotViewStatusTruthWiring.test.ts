import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const botView = readFileSync("src/pages/BotView.tsx", "utf8");
const brokerTrades = readFileSync("src/components/BrokerTradesTab.tsx", "utf8");
const mobilePosition = readFileSync("src/components/MobilePositionCard.tsx", "utf8");

describe("live mutation status truth wiring", () => {
  it("requires every active broker read before enabling live controls", () => {
    expect(botView).toContain("activeConnections.map((_, index) =>");
    expect(botView).toContain("brokerConnectionStateQueries[index]?.isSuccess === true");
    expect(botView).toContain("brokerAccountQueries[index]?.isSuccess === true");
    expect(botView).toContain("brokerPositionQueries[index]?.isSuccess === true");
    expect(botView).toContain("canUseTradingControls(executionMode, liveBrokerStates)");
    expect(botView).toContain("const currentConnections = await brokerApi.list()");
    expect(botView).toContain("currentActiveConnections.map(async (connection: any) =>");
  });

  it("rechecks status at mutation boundaries and surfaces account-control failures", () => {
    expect(botView.split("requireTradingControls();").length - 1).toBeGreaterThanOrEqual(11);
    expect(botView).toContain("requireModeChangeTruth();");
    expect(botView).toContain("executionMode === \"paper\" ? brokerConnectionsKnown : liveBrokerTruthKnown");
    expect(botView.split("onError: accountControlError(").length - 1).toBe(8);
    expect(botView).toContain('onError: accountControlError("Execution mode was not changed")');
    expect(botView).toContain("open={configOpen && tradingControlsEnabled}");
  });

  it("gates direct and portaled position mutations", () => {
    expect(brokerTrades).toContain("if (!mutationsEnabled) throw new Error");
    expect(brokerTrades).toContain("mutationsAllowed && canUseTradingControls");
    expect(mobilePosition).toContain("<fieldset disabled={!mutationsEnabled}");
    expect(mobilePosition).toContain("disabled={!mutationsEnabled}");
  });
});

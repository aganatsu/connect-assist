import { readFileSync } from "node:fs";
import { createElement, type ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MobilePositionCard } from "./MobilePositionCard";

const mobile = readFileSync("src/components/MobilePositionCard.tsx", "utf8");
const desktop = readFileSync("src/components/ExpandedPositionCard.tsx", "utf8");
const bot = readFileSync("src/pages/BotView.tsx", "utf8");

describe("mobile trade management", () => {
  it("uses the same direct SL/TP and management override editors as desktop", () => {
    expect(desktop).toContain("export function SLTPEditor");
    expect(desktop).toContain("setSl(initialSl)");
    expect(mobile).toContain("<SLTPEditor position={p} onSaved={onSaved} />");
    expect(mobile).toContain("<TradeOverrideEditor position={p} onSaved={onSaved} />");
  });

  it("refreshes position data after mobile saves", () => {
    expect(mobile).toContain("onSaved: () => void");
    expect(bot).toContain('onSaved={() => queryClient.invalidateQueries({ queryKey: ["paper-status"] })}');
  });

  it("provides a phone-height scrollable management sheet", () => {
    expect(mobile).toContain("92dvh");
    expect(mobile).toContain("safe-area-inset-bottom");
    expect(mobile).toContain("Manage Trade");
  });

  it("contains override actions within the mobile sheet width", () => {
    const overrides = readFileSync("src/components/TradeOverrideEditor.tsx", "utf8");
    expect(overrides).toContain("grid grid-cols-2 gap-2");
    expect(overrides).toContain("col-span-2");
    expect(overrides).toContain("w-full md:w-auto");
  });

  it("does not gate dashboard close wiring on aggregate trading truth", () => {
    const closeHandler = bot.split("const closePositionFromDashboard")[1]
      ?.split("const startMut")[0] || "";

    expect(closeHandler).not.toContain("requireTradingControls");
    expect(bot).toContain("closeEnabled={Boolean(p.id)}");
    expect(bot).toContain("disabled={!p.id}");
  });

  it("keeps a known-position close available while management edits are disabled", () => {
    const props: ComponentProps<typeof MobilePositionCard> = {
      position: {
        id: "position-1",
        symbol: "EUR/USD",
        direction: "long",
        entryPrice: "1.1000",
        currentPrice: "1.1010",
        stopLoss: "1.0950",
        takeProfit: "1.1100",
        size: "0.1",
        pnl: 10,
        openTime: new Date().toISOString(),
      },
      mutationsEnabled: false,
      closeEnabled: true,
      isExpanded: true,
      onToggle: () => undefined,
      onClose: () => undefined,
      onSaved: () => undefined,
    };

    render(createElement(MobilePositionCard, props));

    expect(screen.getByRole("button", { name: "Close Position" })).toBeEnabled();
  });

});

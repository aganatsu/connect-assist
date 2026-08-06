import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
});

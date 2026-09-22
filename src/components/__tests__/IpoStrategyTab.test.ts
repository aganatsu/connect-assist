import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const botView = readFileSync("src/pages/BotView.tsx", "utf8");
const scanner = readFileSync("src/components/IpoScanner.tsx", "utf8");
const detail = readFileSync("src/components/IpoScanDetail.tsx", "utf8");

describe("SMC BotView regression", () => {
  it("still renders the SMC tree — the IPO tab is additive, not a rewrite", () => {
    // The SMC content is wrapped, never conditionalised. These anchors are the
    // SMC surface; if IPO work ever deletes them the regression is visible here.
    expect(botView).toContain('<AppShell>');
    expect(botView).toContain("ScanDetailInline");
    expect(botView).toContain("SignalStatusPanel");
    expect(botView).toContain("BotConfigModal");
    expect(botView).toContain('<div className="flex flex-col h-page');
  });

  it("does not put IPO conditionals inside the SMC detail component", () => {
    // ScanDetailInline is declared inside BotView. A strategy conditional in it
    // is the failure mode this architecture exists to avoid, so the function
    // body is checked directly rather than a file that does not exist.
    const start = botView.indexOf("function ScanDetailInline");
    expect(start).toBeGreaterThan(-1);
    const body = botView.slice(start).toLowerCase();
    expect(body).not.toContain("ipo");
    expect(body).not.toContain("strategytab");
  });

  it("exposes both strategy tabs, with SMC first and default", () => {
    expect(botView).toContain('value="smc"');
    expect(botView).toContain('value="ipo"');
    expect(botView).toContain('useState<"smc" | "ipo">("smc")');
    expect(botView.indexOf('value="smc"')).toBeLessThan(botView.indexOf('value="ipo"'));
  });
});

describe("IPO observation UI is independent and cannot trade", () => {
  it("lives in dedicated components", () => {
    expect(botView).toContain('import { IpoScanner } from "@/components/IpoScanner"');
    expect(scanner).toContain("IpoScanDetail");
  });

  it("has no order, execution or broker affordance", () => {
    for (const src of [scanner, detail]) {
      for (const forbidden of [
        "broker-execute", "brokerExecApi", "paperApi", "placeOrder", "closeTrade",
        "useMutation", "onSubmit", "paper_positions", "pending_orders",
      ]) {
        expect(src).not.toContain(forbidden);
      }
    }
  });

  it("reads only the observation endpoint", () => {
    const invoked = [...scanner.matchAll(/functions\.invoke\("([^"]+)"/g)].map((m) => m[1]);
    expect(invoked).toEqual(["ipo-observation"]);
    expect(scanner).not.toContain('.from("');
  });

  it("labels execution eligibility as informational", () => {
    expect(detail).toContain("informational only");
    expect(detail.toLowerCase()).toContain("no order is placed");
    expect(scanner).toContain("Observation only");
  });

  it("renders research-only lifecycle states as not tracked", () => {
    expect(detail).toContain("not tracked");
    expect(detail).toContain("moveAway");
    expect(detail).toContain("expansion");
    expect(detail).toContain("trend");
  });
});

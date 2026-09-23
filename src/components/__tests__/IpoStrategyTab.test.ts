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

  it("reads only READ-ONLY endpoints, and no table directly", () => {
    // Widened on 2026-09-23 from `toEqual(["ipo-observation"])`. The scanner now
    // also reads `ipo-paper-state` so it can say WHICH IPO owns an open
    // position — the observation snapshot knows the lifecycle but has never
    // heard of a fill. Both endpoints are SELECT-only, and the property this
    // test exists for is unchanged and still asserted below: the scanner cannot
    // mutate anything and cannot reach a broker.
    const READ_ONLY = ["ipo-observation", "ipo-paper-state"];
    const invoked = [...scanner.matchAll(/functions\.invoke\("([^"]+)"/g)].map((m) => m[1]);
    expect(invoked.length).toBeGreaterThan(0);
    for (const fn of invoked) expect(READ_ONLY).toContain(fn);
    expect(invoked).toContain("ipo-observation");
    expect(scanner).not.toContain('.from("');
    for (const mutation of [".insert(", ".update(", ".delete(", ".upsert(", "useMutation"]) {
      expect(scanner).not.toContain(mutation);
    }
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

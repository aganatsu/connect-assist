import { describe, expect, it } from "vitest";
import fs from "node:fs";
const page = fs.readFileSync("src/pages/Backtest.tsx", "utf8");
const api = fs.readFileSync("src/lib/api.ts", "utf8");
describe("MT5 backtest history", () => {
  it("uploads, inventories, selects, and runs imported history", () => {
    expect(page).toContain("Imported MT5 History");
    expect(page).toContain("Broker UTC Offset");
    expect(page).toContain("Import MT5 M1 CSV");
    expect(page).toContain('historySource,');
    expect(api).toContain('from("backtest-history")');
    expect(api).toContain('action: "mt5_register"');
  });
});

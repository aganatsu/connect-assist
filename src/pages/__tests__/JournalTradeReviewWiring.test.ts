import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const journal = readFileSync("src/pages/Journal.tsx", "utf8");
const api = readFileSync("src/lib/api.ts", "utf8");
const edge = readFileSync("supabase/functions/trades/index.ts", "utf8");

describe("automatic trade review journal", () => {
  it("reads authoritative closed trades without manual import", () => {
    expect(journal).toContain("tradesApi.reviews(500)");
    expect(journal).not.toContain("Import Bot Trades");
    expect(edge).toContain('.from("paper_trade_history")');
    expect(edge).toContain('.from("trade_post_mortems")');
  });

  it("provides review queue, completed reviews and model insights", () => {
    expect(journal).toContain("Review Queue");
    expect(journal).toContain("Reviewed");
    expect(journal).toContain("Model Insights");
    expect(journal).toContain("const insightTrades");
  });

  it("provides a dedicated mobile list and full-screen review surface", () => {
    expect(journal).toContain("space-y-2 md:hidden");
    expect(journal).toContain("hidden overflow-x-auto md:block");
    expect(journal).toContain("fixed inset-0 z-50 overflow-y-auto");
    expect(journal).toContain("env(safe-area-inset-bottom)");
    expect(journal).not.toContain("Add Manual Trade");
  });

  it("persists notes and review status separately from the trade ledger", () => {
    expect(api).toContain("saveReview:");
    expect(edge).toContain('.from("trade_review_notes").upsert');
    expect(journal).toContain("Mark Reviewed");
    expect(journal).toContain("Save Draft");
  });
});

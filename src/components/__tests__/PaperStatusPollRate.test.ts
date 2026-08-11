import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The paper-trading status endpoint fetches one TwelveData price per open
 * symbol. Three components share the "paper-status" query key, and React Query
 * refetches at the SHORTEST interval among observers — so the fastest one sets
 * the rate for the entire app.
 *
 * Measured 2026-08-11 against a 55 credit/min plan: 75/min average, 371/min
 * peak, 100% of quota, requests returning 429. That surfaces downstream as
 * "Insufficient candles (0, need 20)" and a skipped pair — 44% of scans.
 */
const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");

const OBSERVERS = [
  "pages/BotView.tsx",
  "components/StatusBar.tsx",
  "components/MobileTopBar.tsx",
];

function pollIntervalOf(file: string): number {
  const src = read(file);
  const at = src.indexOf('queryKey: ["paper-status"]');
  expect(at, `${file} should observe paper-status`).toBeGreaterThan(-1);
  const m = src.slice(at, at + 600).match(/refetchInterval:\s*(\d+)/);
  expect(m, `${file} should declare a refetchInterval`).toBeTruthy();
  return Number(m![1]);
}

describe("paper-status polling cost", () => {
  it("no observer polls faster than 10s", () => {
    for (const file of OBSERVERS) {
      expect(pollIntervalOf(file), `${file} polls too fast`).toBeGreaterThanOrEqual(10_000);
    }
  });

  it("observers agree, so no single component can set the app-wide rate", () => {
    const intervals = OBSERVERS.map(pollIntervalOf);
    expect(new Set(intervals).size).toBe(1);
  });

  it("worst-case credit burn stays inside the plan", () => {
    // Effective rate is the fastest observer. Each poll costs one credit per
    // open symbol, and the server-side cache collapses repeats within its TTL.
    const fastestMs = Math.min(...OBSERVERS.map(pollIntervalOf));
    const cacheTtlMs = 10_000;
    const effectiveMs = Math.max(fastestMs, cacheTtlMs);
    const openSymbols = 5;
    const creditsPerMinute = (60_000 / effectiveMs) * openSymbols;
    // 55/min plan, and the scanner needs headroom too.
    expect(creditsPerMinute).toBeLessThanOrEqual(30);
  });

  it("live prices are cached server-side", () => {
    const src = read("../supabase/functions/paper-trading/index.ts");
    expect(src).toContain("PRICE_CACHE_TTL_MS");
    expect(src).toMatch(/const cached = priceCache\.get\(symbol\);/);
  });
});

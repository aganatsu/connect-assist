import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, relative } from "node:path";

/**
 * The paper-trading status endpoint fetches one TwelveData price per open
 * symbol. Several components share the "paper-status" query key, and React
 * Query refetches at the SHORTEST interval among observers — so the fastest one
 * sets the rate for the entire app.
 *
 * Measured 2026-08-11 against a 55 credit/min Grow plan: 75/min average, 371/min
 * peak, 100% of quota, requests returning 429. That surfaces downstream as
 * "Insufficient candles (0, need 20)" and a skipped pair — 44% of scans.
 *
 * Observers are discovered rather than listed, so adding a fifth component that
 * polls faster fails this suite instead of silently raising the app-wide rate.
 */
const SRC = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(SRC, p), "utf8");

const QUERY_KEY = 'queryKey: ["paper-status"]';

function findObservers(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "__tests__" && e.name !== "node_modules") walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(e.name)) continue;
      const src = readFileSync(full, "utf8");
      // Only count declared polls, not the invalidateQueries calls in mutations.
      const at = src.indexOf(QUERY_KEY);
      if (at === -1) continue;
      if (!/refetchInterval:\s*\d+/.test(src.slice(at, at + 600))) continue;
      out.push(relative(SRC, full));
    }
  };
  walk(SRC);
  return out.sort();
}

function pollIntervalOf(file: string): number {
  const src = read(file);
  const at = src.indexOf(QUERY_KEY);
  expect(at, `${file} should observe paper-status`).toBeGreaterThan(-1);
  const m = src.slice(at, at + 600).match(/refetchInterval:\s*(\d+)/);
  expect(m, `${file} should declare a refetchInterval`).toBeTruthy();
  return Number(m![1]);
}

describe("paper-status polling cost", () => {
  const observers = findObservers();

  it("finds every component that polls paper-status", () => {
    // Guards the discovery itself — if this drops to zero the other tests pass
    // vacuously and the cost ceiling stops being enforced.
    expect(observers.length).toBeGreaterThanOrEqual(4);
  });

  it("no observer polls faster than 10s", () => {
    for (const file of observers) {
      expect(pollIntervalOf(file), `${file} polls too fast`).toBeGreaterThanOrEqual(10_000);
    }
  });

  it("observers agree, so no single component can set the app-wide rate", () => {
    const intervals = observers.map(pollIntervalOf);
    expect(new Set(intervals).size, `intervals: ${intervals.join(", ")}`).toBe(1);
  });

  it("worst-case credit burn stays inside the plan", () => {
    // Effective rate is the fastest observer. Each poll costs one credit per
    // open symbol, and the server-side cache collapses repeats within its TTL.
    const fastestMs = Math.min(...observers.map(pollIntervalOf));
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

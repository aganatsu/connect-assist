/**
 * manageLoopBudget.test.ts — the manage loop's API cost.
 *
 * manage-positions-1min fires every 60s and each invocation runs a loop, not a
 * single pass. Every iteration is a full runScanForUser in management-only
 * mode, which does not return early until past the price refresh and the SL/TP
 * breach check — both of which fetch candles per open symbol through a cache
 * rebuilt each iteration.
 *
 * Measured 2026-08-11 on a 55 credit/min TwelveData plan: 75/min average, 371
 * peak, 100% of quota, requests 429ing. A 429 makes twelveDataCandles return
 * [], which fails the 30-candle floor, falls through to a keyless Polygon, and
 * surfaces as "Insufficient candles (0, need 20)" — 44% of pair-scans skipped.
 *
 * This pins the iteration count so the loop cannot quietly go back to burning
 * the whole quota.
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const src = Deno.readTextFileSync(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

function constant(name: string): number {
  const m = src.match(new RegExp(`const ${name} = ([0-9_]+)`));
  assert(m, `${name} not found`);
  return Number(m![1].replace(/_/g, ""));
}

Deno.test("the manage loop stays inside its cron window", () => {
  const budget = constant("LOOP_BUDGET_MS");
  // The cron fires every 60s; overlapping invocations would double the spend.
  assert(budget < 60_000, `loop budget ${budget}ms must finish before the next cron`);
});

Deno.test("iterations per minute are bounded", () => {
  const budget = constant("LOOP_BUDGET_MS");
  const interval = constant("LOOP_INTERVAL_MS");
  const iterations = Math.ceil(budget / interval);
  assert(
    iterations <= 3,
    `${iterations} management passes per minute is too many — each fetches ` +
      `candles per open symbol against a shared 55 credit/min budget`,
  );
});

Deno.test("worst-case manage-loop credit burn leaves room for the scanner", () => {
  const iterations = Math.ceil(constant("LOOP_BUDGET_MS") / constant("LOOP_INTERVAL_MS"));
  const openSymbols = 5;
  // Price refresh and the breach check share a cache key when the entry
  // timeframe matches, so budget ~1.5 fetches per symbol per pass.
  const perMinute = iterations * openSymbols * 1.5;
  assert(
    perMinute <= 25,
    `~${perMinute} credits/min from management alone; the plan is 55 and the ` +
      `scanner, zone-confirmation and paper-trading all draw from the same pool`,
  );
});

Deno.test("responsiveness is still sub-minute", () => {
  const interval = constant("LOOP_INTERVAL_MS");
  assert(
    interval <= 30_000,
    `trailing stops and break-even should react within 30s, not ${interval}ms`,
  );
});

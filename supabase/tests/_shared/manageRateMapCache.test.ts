// The rateMap build must not re-fetch daily candles every minute.
//
// manage-positions-1min runs a 50s loop calling runScanForUser in
// management-only mode. Management-only does not return early until line ~3541,
// so everything above it runs on every pass — including the rateMap build,
// which fetches six fixed majors on DAILY candles for lot sizing and PnL
// conversion.
//
// candleSource's in-memory cache holds daily candles for 5 minutes, which would
// cover this, except each cron invocation is a FRESH ISOLATE. The cache is
// empty on arrival, so all six are fetched again. Measured 2026-08-12 via
// api_credit_usage.caller: bot-scanner:candleSource held a steady 20-30
// credits/min with no scan running, of which six per minute were these — spent
// re-reading closes that change once a day.
//
// The scan path already solves this with batchGetCachedCandles against
// kv_cache, but that call sits AFTER the management-only return, so the loop
// that runs every minute never reached it.

import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

function rateMapBlock(): string {
  const start = src.indexOf("Build rateMap for cross-pair lot sizing");
  assert(start > 0, "rateMap build block not found — was it renamed?");
  const end = src.indexOf("SL/TP Breach Check", start);
  assert(end > start, "could not bound the rateMap block");
  return src.slice(start, end);
}

Deno.test("rateMap: pre-warms from the persistent cache before hitting the API", () => {
  const block = rateMapBlock();
  const warm = block.indexOf("batchGetCachedCandles");
  const fetchIdx = block.indexOf("RATE_PAIRS.map(p => cachedFetch");
  assert(warm > 0, "rateMap must consult kv_cache — a fresh isolate every minute means the " +
    "in-memory cache is always cold, so six daily fetches recur every single minute");
  assert(fetchIdx > 0, "rateMap fetch not found");
  assert(
    warm < fetchIdx,
    "the pre-warm must happen BEFORE the fetch, or it saves nothing",
  );
});

Deno.test("rateMap: persists what it fetched, so the next invocation starts warm", () => {
  const block = rateMapBlock();
  assert(
    block.includes("batchSetCachedCandles"),
    "without writing back, every invocation misses and the pre-warm never pays off",
  );
});

Deno.test("rateMap build runs before the management-only return, so it is on the hot path", () => {
  const rateMapIdx = src.indexOf("Build rateMap for cross-pair lot sizing");
  const mgmtReturn = src.indexOf("if (opts?.isManagementOnly)");
  assert(rateMapIdx > 0 && mgmtReturn > 0, "anchors not found");
  assert(
    rateMapIdx < mgmtReturn,
    "if rateMap ever moves below the management-only return this test is obsolete — " +
      "but while it is above, it runs on every one-minute management pass and its " +
      "cost is paid 1440 times a day",
  );
});

Deno.test("the scan-path pre-warm is still after the management return (why this fix was needed)", () => {
  const mgmtReturn = src.indexOf("if (opts?.isManagementOnly)");
  const scanWarm = src.lastIndexOf("batchGetCachedCandles");
  assert(
    scanWarm > mgmtReturn,
    "documents the original gap: the existing persistent-cache pre-warm is unreachable " +
      "from the manage loop. If this ever fails, the scan pre-warm moved earlier and the " +
      "rateMap-specific pre-warm may now be redundant.",
  );
});

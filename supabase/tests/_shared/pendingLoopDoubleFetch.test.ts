import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * The pending-order loop fetched its candles with the raw config value:
 *
 *   cachedFetch(pending.symbol, config.entryTimeframe || "15min", "5d")
 *
 * while every other call site normalises first:
 *
 *   cachedFetch(sym, getEntryInterval(config.entryTimeframe), getEntryRange(...))
 *
 * getEntryInterval("15min") is "15m", and dataCache keys on the raw string —
 * `makeKey` is `${symbol}|${interval}` with no canonicalisation. So on the
 * default config and on day_trader, the same candles were fetched and cached
 * TWICE per cycle, once per spelling. Every pending order forced a redundant
 * provider call, every minute, on a budget already refusing 200-440 fetches
 * per cycle.
 *
 * Pure plumbing: same data, half the requests. It does not change which trades
 * happen, so it is not gated behind a flag.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const dataCache = await Deno.readTextFile(
  new URL("../../functions/_shared/dataCache.ts", import.meta.url),
);

/** Mirrors getEntryInterval/getEntryRange in bot-scanner. */
function entryInterval(tf: string): string {
  const map: Record<string, string> = {
    "1m": "1m", "5m": "5m", "15m": "15m", "15min": "15m",
    "30m": "30m", "1h": "1h", "4h": "1h", "1d": "1d", "1day": "1d",
  };
  return map[tf] || "15m";
}

Deno.test("the spellings that used to diverge now agree", () => {
  // day_trader and the global default both carry "15min".
  assertEquals(entryInterval("15min"), "15m");
  assert("15min" !== entryInterval("15min"), "this is the pair that split the cache");
  // scalper's "5m" and swing's "1h" were already identical — the bug was
  // silent for scalper, which is why it survived.
  assertEquals(entryInterval("5m"), "5m");
  assertEquals(entryInterval("1h"), "1h");
});

Deno.test("dataCache still keys on the raw interval", () => {
  // If this ever starts canonicalising, the fix below becomes redundant rather
  // than wrong — but until then the call sites must agree.
  assert(
    /return `\$\{symbol\}\|\$\{interval\}`/.test(dataCache),
    "makeKey must be the raw symbol|interval this test assumes",
  );
  assert(
    !/canonicalInterval/.test(dataCache),
    "dataCache does not normalise; that is why call sites must",
  );
});

Deno.test("the pending loop normalises interval and range", () => {
  assert(
    /const pendingInterval = getEntryInterval\(config\.entryTimeframe \|\| "15min"\)/.test(scanner),
    "interval must go through getEntryInterval",
  );
  assert(
    /const pendingRange = getEntryRange\(config\.entryTimeframe \|\| "15min"\)/.test(scanner),
    "range must go through getEntryRange, not a hardcoded \"5d\"",
  );
  assert(
    !/cachedFetch\(pending\.symbol, config\.entryTimeframe/.test(scanner),
    "the raw call must be gone",
  );
});

Deno.test("a missing-candle cycle is reported, not silent", () => {
  // dataCache caches the empty result ("Cache the failure so we don't retry"),
  // so one refused fetch skips the order for the whole cycle. A bare `continue`
  // made that indistinguishable from a healthy no-op.
  const i = scanner.indexOf("const pendingCandles = await cachedFetch");
  const block = scanner.slice(i, i + 700);
  assert(/pendingCandles\.length === 0/.test(block));
  assert(/console\.warn/.test(block), "the skip must be logged");
  assert(
    /touch detection skipped/.test(block),
    "the log should name the consequence, not just the missing data",
  );
});

Deno.test("the cached-failure behaviour this relies on is real", () => {
  assert(
    /Cache the failure so we don't retry/.test(dataCache),
    "if this changes, the warning above overstates the impact",
  );
});

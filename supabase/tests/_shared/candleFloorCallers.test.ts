import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * fetchCandlesWithFallback discards any source returning fewer than 30 candles,
 * at every accept point. A caller asking for fewer than 30 therefore spends the
 * provider credit, fails the floor, falls through to a provider with no key, and
 * returns NO_DATA — and is never cached either, because setCachedCandles is only
 * reached from those same branches.
 *
 * market-data asked for 5 for every quote. Measured 2026-09-02 it was the single
 * largest consumer of the TwelveData plan at ~32 credits/min against a 55/min
 * limit, and not one of those requests could have returned data.
 *
 * Read from source: the floor is a literal inside fetchCandlesWithFallback and
 * the callers are Edge Function module bodies that call Deno.serve on import.
 */

const ROOT = new URL("../../", import.meta.url);
const candleSource = await Deno.readTextFile(
  new URL("functions/_shared/candleSource.ts", ROOT),
);

/** The floor, read from candleSource rather than duplicated as a constant. */
function minCandleFloor(): number {
  const floors = [...candleSource.matchAll(/length\s*>=\s*(\d+)/g)].map((m) => Number(m[1]));
  assert(floors.length > 0, "no candle-length floor found in candleSource.ts");
  // Every accept point uses the same value; take the lowest a source could pass.
  return Math.min(...floors);
}

Deno.test("the candle floor is still enforced at every accept point", () => {
  const floors = [...candleSource.matchAll(/length\s*>=\s*(\d+)/g)].map((m) => Number(m[1]));
  assert(floors.length >= 4, `expected several accept points, found ${floors.length}`);
  assertEquals(
    new Set(floors).size,
    1,
    `accept points disagree on the floor: ${floors.join(", ")} — a caller cannot satisfy all of them`,
  );
});

Deno.test("market-data requests enough candles to clear the floor", () => {
  const src = Deno.readTextFileSync(new URL("functions/market-data/index.ts", ROOT));
  const floor = minCandleFloor();

  const m = src.match(/const QUOTE_CANDLE_LIMIT\s*=\s*(\d+)/);
  assert(m, "market-data should declare QUOTE_CANDLE_LIMIT");
  const limit = Number(m[1]);
  assert(
    limit >= floor,
    `QUOTE_CANDLE_LIMIT is ${limit} but fetchCandlesWithFallback discards anything under ${floor} — ` +
      `the credit is spent and NO_DATA is returned`,
  );
});

Deno.test("no caller asks fetchCandlesWithFallback for less than the floor", () => {
  const floor = minCandleFloor();
  const offenders: string[] = [];

  for (const dir of Deno.readDirSync(new URL("functions/", ROOT))) {
    if (!dir.isDirectory || dir.name === "_shared") continue;
    const path = new URL(`functions/${dir.name}/index.ts`, ROOT);
    let src: string;
    try {
      src = Deno.readTextFileSync(path);
    } catch {
      continue;
    }
    if (!src.includes("fetchCandlesWithFallback")) continue;

    // Numeric `limit:` literals passed anywhere in the file. Named constants are
    // covered by their own assertion above.
    for (const match of src.matchAll(/\blimit:\s*(\d+)\b/g)) {
      const value = Number(match[1]);
      if (value < floor) offenders.push(`${dir.name}: limit: ${value}`);
    }
  }

  assertEquals(
    offenders,
    [],
    `these requests can never clear the ${floor}-candle floor: ${offenders.join("; ")}`,
  );
});

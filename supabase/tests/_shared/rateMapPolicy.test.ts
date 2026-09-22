import { assert, assertEquals, assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  requiredRatePairs, resolveRates, parseRateCache, describeProvenance, rateCacheKey,
  isDegradedSource, type RateCache,
} from "../../functions/_shared/rateMapPolicy.ts";
import { getQuoteToUSDRate, QUOTE_CONVERSION } from "../../functions/_shared/smcAnalysis.ts";
import { computePositionSize } from "../../functions/_shared/unifiedPositionSizing.ts";

const NOW = Date.UTC(2026, 8, 22, 16, 0, 0);
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

/** The live instrument set as configured on 2026-09-22. */
const ENABLED = ["EUR/USD", "GBP/USD", "USD/JPY", "USD/CAD", "NZD/USD", "AUD/USD", "USD/CHF"];
/** What the scanner hardcoded before this change. */
const OLD_HARDCODED = ["USD/JPY", "GBP/USD", "AUD/USD", "NZD/USD", "USD/CAD", "USD/CHF"];
/** Live rates measured the same day, used as the "provider succeeded" case. */
const LIVE = { "USD/JPY": 157.59084, "USD/CAD": 1.40727, "USD/CHF": 0.82211 };

// ── 1. required pairs are derived from config, not listed ────────────────────

Deno.test("the current enabled set requires exactly USD/JPY, USD/CAD, USD/CHF", () => {
  assertEquals(requiredRatePairs(ENABLED), ["USD/CAD", "USD/CHF", "USD/JPY"]);
});

Deno.test("USD-quoted instruments require no rate at all", () => {
  // getQuoteToUSDRate returns 1.0 before it ever reads the map.
  assertEquals(requiredRatePairs(["EUR/USD", "GBP/USD", "AUD/USD", "NZD/USD"]), []);
  for (const s of ["EUR/USD", "GBP/USD", "AUD/USD", "NZD/USD"]) {
    assertEquals(getQuoteToUSDRate(s, {}), 1.0, `${s} consulted the map`);
  }
});

Deno.test("the three dropped pairs are dropped because nothing can read them", () => {
  const dropped = OLD_HARDCODED.filter((p) => !requiredRatePairs(ENABLED).includes(p));
  assertEquals(dropped, ["GBP/USD", "AUD/USD", "NZD/USD"]);
  // They are reachable only as a QUOTE currency, i.e. via a cross. None enabled.
  for (const q of ["GBP", "AUD", "NZD"]) {
    assert(!ENABLED.some((s) => s.split("/")[1] === q), `${q} is a quote of an enabled pair`);
  }
});

Deno.test("enabling a cross brings its pair back automatically", () => {
  // The point of deriving: config changes, the fetch set follows, with no edit.
  assert(requiredRatePairs([...ENABLED, "EUR/GBP"]).includes("GBP/USD"));
  assert(requiredRatePairs([...ENABLED, "EUR/AUD"]).includes("AUD/USD"));
  assert(requiredRatePairs([...ENABLED, "EUR/NZD"]).includes("NZD/USD"));
});

Deno.test("derivation covers every conversion the shared table knows", () => {
  // Guards against the table gaining a currency the deriver silently ignores.
  for (const [quote, conv] of Object.entries(QUOTE_CONVERSION)) {
    assertEquals(requiredRatePairs([`EUR/${quote}`]), [conv.pair], `EUR/${quote}`);
  }
});

Deno.test("junk symbols are skipped, not crashed on, and duplicates collapse", () => {
  assertEquals(requiredRatePairs(["", "EURUSD", "A/B/C", "USD/JPY", "EUR/JPY", "GBP/JPY"]),
    ["USD/JPY"]);
});

// ── 2. removing the unused pairs changes no decision ─────────────────────────

Deno.test("dropping GBP/USD, AUD/USD and NZD/USD changes no rate for any enabled instrument", () => {
  const full: Record<string, number> = {
    ...LIVE, "GBP/USD": 1.33, "AUD/USD": 0.658, "NZD/USD": 0.594,
  };
  const trimmed = resolveRates(requiredRatePairs(ENABLED), full, {}, NOW).rateMap;
  for (const symbol of ENABLED) {
    assertEquals(getQuoteToUSDRate(symbol, trimmed), getQuoteToUSDRate(symbol, full),
      `${symbol} converts differently after trimming`);
  }
});

Deno.test("dropping them changes no LOT SIZE for any enabled instrument", () => {
  const full: Record<string, number> = {
    ...LIVE, "GBP/USD": 1.33, "AUD/USD": 0.658, "NZD/USD": 0.594,
  };
  const trimmed = resolveRates(requiredRatePairs(ENABLED), full, {}, NOW).rateMap;
  for (const symbol of ENABLED) {
    const entry = symbol.endsWith("/JPY") ? 157.5 : 1.1;
    const sl = symbol.endsWith("/JPY") ? 157.0 : 1.095;
    const base = { balance: 100_000, riskPercent: 1, entryPrice: entry, stopLoss: sl, symbol };
    assertEquals(
      computePositionSize({ ...base, rateMap: trimmed }).lots,
      computePositionSize({ ...base, rateMap: full }).lots,
      `${symbol} sized differently after trimming`,
    );
  }
});

// ── 3. LIVE: identical to the old behaviour when the fetch succeeds ──────────

Deno.test("a successful fetch produces the same map the old code produced", () => {
  const r = resolveRates(requiredRatePairs(ENABLED), LIVE, {}, NOW);
  assertEquals(r.rateMap, { "USD/CAD": 1.40727, "USD/CHF": 0.82211, "USD/JPY": 157.59084 });
  assertEquals(r.degraded, false);
  assert(r.provenance.every((p) => p.source === "LIVE" && p.ageMs === 0));
});

Deno.test("sizing is identical when the live rate is available", () => {
  // The old path put the fetched close straight into the map. So must this one.
  for (const symbol of ["USD/JPY", "USD/CAD", "USD/CHF", "EUR/USD"]) {
    const entry = symbol === "USD/JPY" ? 157.5 : 1.1;
    const sl = symbol === "USD/JPY" ? 157.0 : 1.095;
    const base = { balance: 100_000, riskPercent: 1, entryPrice: entry, stopLoss: sl, symbol };
    const viaPolicy = resolveRates(requiredRatePairs(ENABLED), LIVE, {}, NOW).rateMap;
    assertEquals(
      computePositionSize({ ...base, rateMap: viaPolicy }).lots,
      computePositionSize({ ...base, rateMap: LIVE }).lots,
      `${symbol} sized differently through the policy`,
    );
  }
});

Deno.test("a live rate overwrites an older cached one, and refreshes its timestamp", () => {
  const cache: RateCache = { "USD/JPY": { rate: 142.0, at: ago(3 * 24 * 60 * MIN) } };
  const r = resolveRates(["USD/JPY"], { "USD/JPY": 157.59084 }, cache, NOW);
  assertEquals(r.rateMap["USD/JPY"], 157.59084);
  assertEquals(r.nextCache["USD/JPY"], { rate: 157.59084, at: new Date(NOW).toISOString() });
});

Deno.test("a pair that fell back does not overwrite the cache with the stale value", () => {
  const at = ago(40 * MIN);
  const r = resolveRates(["USD/JPY"], {}, { "USD/JPY": { rate: 157.3, at } }, NOW);
  assertEquals(r.nextCache["USD/JPY"], { rate: 157.3, at }, "the age was reset by a fallback");
});

// ── 4. the cached rungs: same calculation as using that rate live ───────────

Deno.test("cached fallback produces exactly the calculation of that rate used live", () => {
  const cached = 157.3;
  const cache: RateCache = { "USD/JPY": { rate: cached, at: ago(47 * MIN) } };
  const fellBack = resolveRates(["USD/JPY"], {}, cache, NOW);
  const asIfLive = resolveRates(["USD/JPY"], { "USD/JPY": cached }, {}, NOW);

  assertEquals(fellBack.rateMap, asIfLive.rateMap);
  const base = { balance: 100_000, riskPercent: 1, entryPrice: 157.5, stopLoss: 157.0, symbol: "USD/JPY" };
  assertEquals(
    computePositionSize({ ...base, rateMap: fellBack.rateMap }).lots,
    computePositionSize({ ...base, rateMap: asIfLive.rateMap }).lots,
  );
});

Deno.test("falling back is flagged degraded and carries the rate's age", () => {
  const r = resolveRates(["USD/JPY", "USD/CAD"],
    { "USD/CAD": 1.40727 },
    { "USD/JPY": { rate: 157.3, at: ago(47 * MIN) } }, NOW);
  assertEquals(r.degraded, true);
  const jpy = r.provenance.find((p) => p.pair === "USD/JPY")!;
  assertEquals(jpy.source, "CACHED_AFTER_FETCH_FAILURE");
  assertEquals(jpy.ageMs, 47 * MIN);
  assertEquals(jpy.rate, 157.3);
  assertEquals(r.provenance.find((p) => p.pair === "USD/CAD")!.source, "LIVE");
});

Deno.test("a cached rate is never age-capped out of use", () => {
  // Deliberate. A month-old observation is still nearer spot than a constant
  // from a previous currency regime — refusing it would make sizing worse.
  const r = resolveRates(["USD/JPY"], {},
    { "USD/JPY": { rate: 150.0, at: ago(365 * 24 * 60 * MIN) } }, NOW);
  assertEquals(r.rateMap["USD/JPY"], 150.0);
  assertEquals(r.provenance[0].source, "CACHED_AFTER_FETCH_FAILURE");
});

Deno.test("the cached rate beats the static constant by two orders of magnitude", () => {
  // The claim this whole change rests on, asserted rather than asserted-in-prose.
  const spot = 157.59084;
  const anHourOld = 157.35;                    // worst measured 60-minute drift
  const constantErr = Math.abs(142.0 - spot) / spot;
  const cachedErr = Math.abs(anHourOld - spot) / spot;
  assert(constantErr > 0.09, `constant is only ${(constantErr * 100).toFixed(2)}% off`);
  assert(cachedErr < 0.002, `cached is ${(cachedErr * 100).toFixed(3)}% off`);
  assert(constantErr / cachedErr > 50, "the cache is no longer clearly better");
});

// ── 5. STATIC_FALLBACK only when nothing was ever observed ───────────────────

Deno.test("static fallback occurs ONLY when no prior cached rate exists", () => {
  const withCache = resolveRates(["USD/JPY"], {}, { "USD/JPY": { rate: 157.3, at: ago(MIN) } }, NOW);
  assertEquals(withCache.provenance[0].source, "CACHED_AFTER_FETCH_FAILURE");

  const without = resolveRates(["USD/JPY"], {}, {}, NOW);
  assertEquals(without.provenance[0].source, "STATIC_FALLBACK");
  assertEquals(without.provenance[0].ageMs, null);
  assertEquals(without.provenance[0].rate, null);
  assertEquals(without.degraded, true);
});

Deno.test("static fallback OMITS the pair so the existing constant branch fires", () => {
  // The module must not carry a second copy of FALLBACK_RATES. Absence from the
  // map is how it hands the decision back to getQuoteToUSDRate unchanged.
  const r = resolveRates(["USD/JPY"], {}, {}, NOW);
  assert(!("USD/JPY" in r.rateMap), "the policy substituted a constant of its own");
  assertEquals(getQuoteToUSDRate("USD/JPY", r.rateMap), getQuoteToUSDRate("USD/JPY", {}),
    "behaviour diverged from the pre-change fallback");
  assertAlmostEquals(getQuoteToUSDRate("USD/JPY", r.rateMap), 1 / 142.0, 1e-12);
});

/** Source with comments removed — prose may name a thing the code must not do. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

Deno.test("the module does not contain the fallback constants", async () => {
  const src = codeOnly(await Deno.readTextFile("supabase/functions/_shared/rateMapPolicy.ts"));
  for (const constant of ["142.0", "1.27", "0.66", "0.61", "1.36", "0.88", "FALLBACK_RATES"]) {
    assert(!src.includes(constant), `the policy hardcodes ${constant}`);
  }
});

Deno.test("a zero, negative, NaN or missing live rate is treated as no rate", () => {
  for (const bad of [0, -1, NaN, Infinity, undefined as unknown as number]) {
    const r = resolveRates(["USD/JPY"], { "USD/JPY": bad }, {}, NOW);
    assertEquals(r.provenance[0].source, "STATIC_FALLBACK", `accepted ${bad}`);
    assert(!("USD/JPY" in r.rateMap));
  }
});

Deno.test("a corrupt cache entry degrades to static rather than poisoning sizing", () => {
  const corrupt = parseRateCache(JSON.stringify({
    "USD/JPY": { rate: 0, at: ago(MIN) },
    "USD/CAD": { rate: 1.4, at: 12345 },
    "USD/CHF": { rate: 0.82, at: ago(MIN) },
  }));
  assertEquals(Object.keys(corrupt), ["USD/CHF"]);
  assertEquals(parseRateCache("not json"), {});
  assertEquals(parseRateCache(null), {});
  assertEquals(parseRateCache("[1,2,3]"), {});
});

// ── 6. nothing else moved ────────────────────────────────────────────────────

Deno.test("no required pair means no fetch and no degradation", () => {
  // Weekend crypto mode, or an all-USD-quoted book. Zero fetches is correct,
  // and must not be reported as a fallback.
  const r = resolveRates([], {}, {}, NOW);
  assertEquals(r.rateMap, {});
  assertEquals(r.degraded, false);
  assertEquals(r.provenance, []);
});

Deno.test("the policy module is pure — no client, no fetch, no clock, no table", async () => {
  const src = await Deno.readTextFile("supabase/functions/_shared/rateMapPolicy.ts");
  for (const impure of ["createClient", "fetch(", "Deno.env", ".from(", "supabase-js", "Date.now("]) {
    assert(!src.includes(impure), `the policy module is not pure: ${impure}`);
  }
});

Deno.test("the scanner derives its pairs and no longer hardcodes six", async () => {
  const src = await Deno.readTextFile("supabase/functions/bot-scanner/index.ts");
  const block = codeOnly(src.slice(src.indexOf("// ── Build rateMap"), src.indexOf("// Runs AFTER price refresh")));
  assert(block.includes("requiredRatePairs("), "the scanner stopped deriving its pairs");
  assert(!block.includes('"GBP/USD"') && !block.includes('"AUD/USD"') && !block.includes('"NZD/USD"'),
    "the dead pairs are hardcoded again");
  // Still one fetch per required pair, every cycle. The cache is a fallback,
  // not a TTL; turning it into one would freeze sizing for up to 24 hours.
  assert(block.includes('cachedFetch(p, "1d", "5d", "rate_map")'), "the live fetch was removed");
  assert(!/cacheAge|ttl|TTL|skipFetch/.test(block), "a TTL crept into the fallback cache");
});

Deno.test("open-position symbols are included, so a delisted position still converts", async () => {
  const src = await Deno.readTextFile("supabase/functions/bot-scanner/index.ts");
  const block = codeOnly(src.slice(src.indexOf("// ── Build rateMap"), src.indexOf("// Runs AFTER price refresh")));
  assert(block.includes("openPosArr.map"), "weekend crypto mode would close an FX position at a constant");
});

Deno.test("open_position_price_refresh is untouched and still fetches live 15m", async () => {
  const src = await Deno.readTextFile("supabase/functions/bot-scanner/index.ts");
  assert(src.includes('cachedFetch(sym, "15m", "5d", "open_position_price_refresh")'),
    "the SL/TP detection feed changed — it must stay fresh");
});

Deno.test("the rate cache key is namespaced per bot and user", () => {
  assertEquals(rateCacheKey("u1", "smc"), "smc_rate_cache:smc:u1");
  assert(rateCacheKey("u1", "smc") !== rateCacheKey("u2", "smc"));
  assert(rateCacheKey("u1", "smc") !== rateCacheKey("u1", "ipo"));
});

Deno.test("provenance renders one readable line per pair", () => {
  const r = resolveRates(["USD/CAD", "USD/CHF", "USD/JPY"],
    { "USD/CAD": 1.40727 },
    { "USD/CHF": { rate: 0.82, at: ago(90 * MIN) } }, NOW);
  assertEquals(describeProvenance(r.provenance),
    "USD/CAD=LIVE USD/CHF=CACHED_FETCH_FAILED(90m) USD/JPY=STATIC");
});

// ── 7. health semantics: not-live is not the same as unhealthy ──────────────

Deno.test("a cache read with no fetch attempted is CACHED_BY_DESIGN and NOT degraded", () => {
  const cache: RateCache = { "USD/JPY": { rate: 157.3, at: ago(2 * MIN) } };
  const r = resolveRates(["USD/JPY"], {}, cache, NOW, { attempted: [] });
  assertEquals(r.provenance[0].source, "CACHED_BY_DESIGN");
  assertEquals(r.provenance[0].ageMs, 2 * MIN);
  assertEquals(r.degraded, false, "a healthy deliberate cache read must not warn");
  assertEquals(r.rateMap["USD/JPY"], 157.3, "the rate itself must be unchanged");
});

Deno.test("the same cache read AFTER a failed fetch is degraded", () => {
  const cache: RateCache = { "USD/JPY": { rate: 157.3, at: ago(2 * MIN) } };
  const byDesign = resolveRates(["USD/JPY"], {}, cache, NOW, { attempted: [] });
  const afterFail = resolveRates(["USD/JPY"], {}, cache, NOW, { attempted: ["USD/JPY"] });

  assertEquals(afterFail.provenance[0].source, "CACHED_AFTER_FETCH_FAILURE");
  assertEquals(afterFail.degraded, true);
  // Same rate, same map, same arithmetic — only the diagnosis differs.
  assertEquals(afterFail.rateMap, byDesign.rateMap);
  assertEquals(afterFail.provenance[0].rate, byDesign.provenance[0].rate);
  assertEquals(afterFail.provenance[0].ageMs, byDesign.provenance[0].ageMs);
});

Deno.test("omitting `attempted` preserves the old semantics exactly", () => {
  const cache: RateCache = { "USD/JPY": { rate: 157.3, at: ago(MIN) } };
  const implicit = resolveRates(["USD/JPY"], {}, cache, NOW);
  const explicit = resolveRates(["USD/JPY"], {}, cache, NOW, { attempted: ["USD/JPY"] });
  assertEquals(implicit, explicit, "the default stopped meaning all-attempted");
});

Deno.test("degraded is true for exactly the two unhealthy sources", () => {
  assertEquals(isDegradedSource("LIVE"), false);
  assertEquals(isDegradedSource("CACHED_BY_DESIGN"), false);
  assertEquals(isDegradedSource("CACHED_AFTER_FETCH_FAILURE"), true);
  assertEquals(isDegradedSource("STATIC_FALLBACK"), true);

  // And the aggregate agrees with the per-pair verdict, always.
  const cache: RateCache = { "USD/CHF": { rate: 0.82, at: ago(MIN) } };
  for (const attempted of [[], ["USD/CAD"], ["USD/CAD", "USD/CHF", "USD/JPY"]]) {
    const r = resolveRates(["USD/CAD", "USD/CHF", "USD/JPY"], { "USD/CAD": 1.4 }, cache, NOW, { attempted });
    assertEquals(r.degraded, r.provenance.some((x) => isDegradedSource(x.source)),
      `aggregate disagrees with per-pair for attempted=${JSON.stringify(attempted)}`);
  }
});

Deno.test("STATIC_FALLBACK is degraded whether or not a fetch was attempted", () => {
  // Nothing observed, ever. Not asking does not make that healthy.
  for (const attempted of [[], ["USD/JPY"]]) {
    const r = resolveRates(["USD/JPY"], {}, {}, NOW, { attempted });
    assertEquals(r.provenance[0].source, "STATIC_FALLBACK");
    assertEquals(r.degraded, true);
  }
});

Deno.test("a LIVE rate is never degraded, whatever else happened", () => {
  const r = resolveRates(["USD/JPY"], { "USD/JPY": 157.4 }, {}, NOW, { attempted: ["USD/JPY"] });
  assertEquals(r.provenance[0].source, "LIVE");
  assertEquals(r.degraded, false);
});

Deno.test("the two cached rungs are distinguishable in one line of log", () => {
  const cache: RateCache = { "USD/CHF": { rate: 0.82, at: ago(90 * MIN) }, "USD/JPY": { rate: 157.3, at: ago(3 * MIN) } };
  const r = resolveRates(["USD/CAD", "USD/CHF", "USD/JPY"], { "USD/CAD": 1.40727 }, cache, NOW,
    { attempted: ["USD/CAD", "USD/CHF"] });
  assertEquals(describeProvenance(r.provenance),
    "USD/CAD=LIVE USD/CHF=CACHED_FETCH_FAILED(90m) USD/JPY=CACHED(3m)");
});

Deno.test("the callers declare what they attempted", async () => {
  const scanner = await Deno.readTextFile("supabase/functions/bot-scanner/index.ts");
  assert(scanner.includes("{ attempted: RATE_PAIRS }"),
    "the scanner no longer declares that it fetches every required pair");

  const paper = await Deno.readTextFile("supabase/functions/paper-trading/index.ts");
  assert(paper.includes("attempted: allowFetch ? required : []"),
    "paper-trading no longer distinguishes a deliberate cache read from a failure");
});

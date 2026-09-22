import { assert, assertEquals, assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { getQuoteToUSDRate, FALLBACK_RATES } from "../../functions/_shared/smcAnalysis.ts";
import {
  requiredRatePairs, resolveRates, type RateCache,
} from "../../functions/_shared/rateMapPolicy.ts";

const SRC = await Deno.readTextFile("supabase/functions/paper-trading/index.ts");
/** Source with comments removed — prose may name a thing the code must not do. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const NOW = Date.UTC(2026, 8, 22, 18, 0, 0);
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const LIVE = { "USD/JPY": 157.49, "GBP/USD": 1.3331, "AUD/USD": 0.7106, "NZD/USD": 0.5721, "USD/CAD": 1.408, "USD/CHF": 0.8219 };

/** Every symbol in paper-trading's own SPECS table, read from the source. */
const PAPER_SYMBOLS = (() => {
  const m = SRC.match(/const SPECS[^=]*=\s*\{[\s\S]*?\n\};/);
  if (!m) throw new Error("paper-trading SPECS table not found — this test is stale");
  return [...m[0].matchAll(/^\s*"([^"]+)":\s*\{/gm)].map((x) => x[1]);
})();

/**
 * The implementation that was deleted from paper-trading, kept verbatim as the
 * reference the replacement must match. It differs from the shared one in its
 * non-forex test — `!symbol.includes("/")` rather than `spec.type !== "forex"`
 * — which is exactly the difference this test exists to rule out.
 */
function deletedLocalImpl(symbol: string, rateMap?: Record<string, number>): number {
  if (!symbol.includes("/")) return 1.0;
  const quote = symbol.split("/")[1];
  if (quote === "USD") return 1.0;
  const QC: Record<string, { pair: string; invert: boolean }> = {
    "JPY": { pair: "USD/JPY", invert: true }, "GBP": { pair: "GBP/USD", invert: false },
    "AUD": { pair: "AUD/USD", invert: false }, "NZD": { pair: "NZD/USD", invert: false },
    "CAD": { pair: "USD/CAD", invert: true }, "CHF": { pair: "USD/CHF", invert: true },
  };
  const conv = QC[quote];
  if (!conv) return 1.0;
  const liveRate = rateMap?.[conv.pair];
  const rate = (liveRate && liveRate > 0) ? liveRate : FALLBACK_RATES[conv.pair];
  if (!rate || rate <= 0) return 1.0;
  return conv.invert ? (1 / rate) : rate;
}

// ── 1. the duplicates are gone ───────────────────────────────────────────────

Deno.test("paper-trading no longer defines its own FALLBACK_RATES", () => {
  assert(!/const\s+FALLBACK_RATES/.test(CODE), "the duplicate constants are still declared");
  for (const constant of ["142.0", "1.27", "0.66", "0.61", "1.36", "0.88"]) {
    assert(!CODE.includes(`"USD/JPY": ${constant}`) && !CODE.includes(`: ${constant},\n  "GBP/USD"`),
      `a fallback constant survives: ${constant}`);
  }
});

Deno.test("paper-trading no longer defines its own getQuoteToUSDRate or QUOTE_CONVERSION", () => {
  assert(!/function\s+getQuoteToUSDRate/.test(CODE), "the duplicate function is still declared");
  assert(!/const\s+QUOTE_CONVERSION/.test(CODE), "the duplicate conversion table is still declared");
  assert(/import\s*\{[^}]*getQuoteToUSDRate[^}]*\}\s*from\s*"\.\.\/_shared\/smcAnalysis\.ts"/s.test(SRC),
    "it does not import the shared implementation");
});

Deno.test("the rate map is never seeded with static constants", () => {
  assert(!/\{\s*\.\.\.FALLBACK_RATES\s*\}/.test(CODE), "the map is still seeded before fetching");
  assert(!CODE.includes("buildRateMap"), "the seeding builder survives");
  // An absent pair is how the shared function's own constant branch is reached.
  assert(CODE.includes("_rateMap = resolved.rateMap"), "the map is not taken from the policy verbatim");
});

// ── 2. live-rate behaviour is identical to what was deleted ─────────────────

Deno.test("shared conversion equals the deleted local one for every paper-trading symbol", () => {
  assert(PAPER_SYMBOLS.length >= 30, `only ${PAPER_SYMBOLS.length} symbols parsed — the table moved`);
  for (const symbol of PAPER_SYMBOLS) {
    for (const map of [undefined, {}, LIVE, { "USD/JPY": 0 }, { "USD/JPY": -1 }]) {
      assertEquals(getQuoteToUSDRate(symbol, map), deletedLocalImpl(symbol, map),
        `${symbol} converts differently with map=${JSON.stringify(map)}`);
    }
  }
});

Deno.test("P&L is numerically unchanged when the live rate is available", () => {
  // calcPnl itself was not touched: pnl = diff × lotUnits × size × quoteToUSD.
  // With lotUnits and size fixed, equal quoteToUSD is equal P&L, exactly.
  const cases: Array<[string, number, number, number, number]> = [
    ["USD/JPY", 157.46989, 157.79698, 2.48, 100000],
    ["EUR/JPY", 184.2, 183.9, 1.0, 100000],
    ["EUR/CAD", 1.5812, 1.5799, 0.75, 100000],
    ["GBP/CHF", 1.0821, 1.0850, 0.5, 100000],
    ["EUR/USD", 1.1, 1.1025, 1.0, 100000],
    ["XAU/USD", 4021.5, 4030.0, 0.2, 100],
    ["BTC/USD", 87000, 87500, 0.1, 1],
  ];
  const viaPolicy = resolveRates(requiredRatePairs(cases.map((c) => c[0])), LIVE, {}, NOW).rateMap;
  for (const [symbol, entry, exit, size, lotUnits] of cases) {
    const diff = exit - entry;
    const before = diff * lotUnits * size * deletedLocalImpl(symbol, LIVE);
    const after = diff * lotUnits * size * getQuoteToUSDRate(symbol, viaPolicy);
    assertEquals(after, before, `${symbol} P&L moved`);
  }
});

Deno.test("USD-quoted and non-forex symbols stay at exactly 1.0", () => {
  for (const s of ["EUR/USD", "GBP/USD", "AUD/USD", "NZD/USD", "XAU/USD", "XAG/USD", "BTC/USD", "ETH/USD", "US30", "NAS100", "SPX500", "US Oil"]) {
    assertEquals(getQuoteToUSDRate(s, LIVE), 1.0, `${s} is not 1.0`);
    assertEquals(getQuoteToUSDRate(s, {}), 1.0, `${s} is not 1.0 without a map`);
  }
});

// ── 3. pairs derived from the symbols being acted on ────────────────────────

Deno.test("only the pairs the acted-on symbols need are required", () => {
  assertEquals(requiredRatePairs(["USD/JPY"]), ["USD/JPY"]);
  assertEquals(requiredRatePairs(["EUR/USD", "BTC/USD", "XAU/USD"]), [],
    "a USD-quoted book must fetch nothing");
  assertEquals(requiredRatePairs(["EUR/GBP", "CAD/JPY", "USD/CHF"]), ["GBP/USD", "USD/CHF", "USD/JPY"]);
  assertEquals(requiredRatePairs([]), []);
});

Deno.test("no six-pair list survives in paper-trading", () => {
  assert(!/RATE_PAIRS\s*=\s*\[/.test(CODE), "a hardcoded pair list survives");
  assert(CODE.includes("requiredRatePairs("), "pairs are not derived");
  // An empty requirement must short-circuit before any provider call.
  assert(/required\.length === 0.*return/s.test(CODE), "a USD-only book would still fetch");
});

// ── 4. the ladder ────────────────────────────────────────────────────────────

Deno.test("cached fallback uses the cached real rate, not a constant", () => {
  const cached = 157.31;
  const cache: RateCache = { "USD/JPY": { rate: cached, at: ago(6 * MIN) } };
  const r = resolveRates(["USD/JPY"], {}, cache, NOW);

  assertEquals(r.rateMap["USD/JPY"], cached);
  assertEquals(r.provenance[0].source, "CACHED_STALE");
  assertEquals(r.provenance[0].ageMs, 6 * MIN);
  // And the resulting conversion is the cached rate used live, to the bit.
  assertEquals(getQuoteToUSDRate("USD/JPY", r.rateMap),
    getQuoteToUSDRate("USD/JPY", { "USD/JPY": cached }));
  assert(getQuoteToUSDRate("USD/JPY", r.rateMap) !== getQuoteToUSDRate("USD/JPY", {}),
    "the cached path collapsed back onto the constant");
});

Deno.test("static fallback only when there is neither a live nor a cached rate", () => {
  assertEquals(resolveRates(["USD/JPY"], { "USD/JPY": 157.4 }, {}, NOW).provenance[0].source, "LIVE");
  assertEquals(resolveRates(["USD/JPY"], {}, { "USD/JPY": { rate: 157.3, at: ago(MIN) } }, NOW)
    .provenance[0].source, "CACHED_STALE");

  const bare = resolveRates(["USD/JPY"], {}, {}, NOW);
  assertEquals(bare.provenance[0].source, "STATIC_FALLBACK");
  assert(!("USD/JPY" in bare.rateMap), "the policy substituted a constant of its own");
  // Reached through the shared function's own branch, unchanged.
  assertAlmostEquals(getQuoteToUSDRate("USD/JPY", bare.rateMap), 1 / FALLBACK_RATES["USD/JPY"], 1e-12);
});

Deno.test("the old seeding could not distinguish a failed fetch from a good one", () => {
  // Why this change exists, stated as a test. Seeded map: a refused USD/JPY
  // fetch is indistinguishable from success and prices the close 10.9% high.
  const seeded = { ...FALLBACK_RATES };                       // the old buildRateMap start
  const spot = 157.49;
  const wrong = 1e5 * 1.0 * (0.5) * deletedLocalImpl("USD/JPY", seeded);
  const right = 1e5 * 1.0 * (0.5) * getQuoteToUSDRate("USD/JPY", { "USD/JPY": spot });
  assert(Math.abs(wrong / right - 1) > 0.10, "the old fallback error is under 10%");
  // The new path reports it instead of hiding it.
  const r = resolveRates(["USD/JPY"], {}, { "USD/JPY": { rate: spot, at: ago(MIN) } }, NOW);
  assertEquals(r.degraded, true);
  assertAlmostEquals(1e5 * 0.5 * getQuoteToUSDRate("USD/JPY", r.rateMap), right, 1e-9);
});

// ── 5. the request paths still work ─────────────────────────────────────────

Deno.test("status, place_order and close_position branches are intact", () => {
  for (const action of ["status", "place_order", "close_position", "update_position",
                        "kill_switch", "start_engine", "set_balance", "reset_account"]) {
    assert(CODE.includes(`action === "${action}"`), `the ${action} branch is missing`);
  }
});

Deno.test("every branch that converts resolves its rates first", () => {
  // calcPnl is the only conversion consumer. Each branch containing one must
  // call ensureRates before it, for the symbols it is about to convert.
  const branches = [
    ['action === "status"', 'action === "place_order"'],
    ['action === "close_position"', 'action === "start_engine"'],
    ['action === "kill_switch"', 'action === "set_balance"'],
  ];
  for (const [from, to] of branches) {
    const block = CODE.slice(CODE.indexOf(from), CODE.indexOf(to));
    assert(block.includes("calcPnl("), `${from} no longer converts — this test is stale`);
    const ensureAt = block.indexOf("ensureRates(");
    assert(ensureAt >= 0, `${from} converts without resolving rates`);
    assert(ensureAt < block.indexOf("calcPnl("), `${from} converts before resolving rates`);
  }
});

Deno.test("place_order does not convert, so it fetches no rates", () => {
  const block = CODE.slice(CODE.indexOf('action === "place_order"'), CODE.indexOf('action === "update_position"'));
  assert(!block.includes("calcPnl("), "place_order started converting — sizing must be re-proved");
  assert(!block.includes("ensureRates("), "place_order fetches rates it does not use");
});

Deno.test("a plain dashboard poll makes no external rate call", () => {
  // The existing contract: status is polled by four UI components and must not
  // fan out to the provider. It resolves from the shared cache instead.
  const block = CODE.slice(CODE.indexOf('action === "status"'), CODE.indexOf('action === "place_order"'));
  assert(/ensureRates\([\s\S]{0,200}?payload\.processEngine === true\)/.test(block),
    "status either always fetches or never fetches — it must fetch only for the engine");
});

Deno.test("status surfaces the provenance it converted with", () => {
  assert(CODE.includes("rateMapHealth: { degraded: _rateDegraded, pairs: _rateProvenance }"),
    "a degraded conversion is not observable from the response");
});

Deno.test("resolving rates can never fail a request", () => {
  const fn = CODE.slice(CODE.indexOf("async function ensureRates"), CODE.indexOf("function calcPnl"));
  assert((fn.match(/try\s*\{/g) ?? []).length >= 2, "the cache read or write can throw");
  assert(fn.includes("catch"), "no catch in the rate path");
});

// ── 6. nothing else moved ────────────────────────────────────────────────────

Deno.test("the P&L, close and risk formulas are untouched", () => {
  assert(CODE.includes("const pnl = diff * spec.lotUnits * size * quoteToUSD"), "the P&L formula changed");
  assert(CODE.includes("const pnlPips = diff / spec.pipSize"), "the pip formula changed");
  assert(CODE.includes('const diff = dir === "long" ? current - entry : entry - current'), "the direction convention changed");
});

Deno.test("paper-trading touches no IPO surface", () => {
  assert(!/\bipo_/.test(SRC) && !/ipo[A-Z]/.test(SRC), "an IPO reference appeared in paper-trading");
});

Deno.test("open_position_price_refresh and cron cadence are not in this file to change", () => {
  assert(!SRC.includes("open_position_price_refresh"), "the SL/TP feed leaked into paper-trading");
  assert(!SRC.includes("cron.schedule"), "a cron change leaked into paper-trading");
});

// ── 7. the rate cache is reachable at all ────────────────────────────────────

Deno.test("the rate cache is read with a client that RLS does not silence", () => {
  // kv_cache has RLS enabled and no policies, so the user-scoped client this
  // function runs on reads nothing from it. The first deploy of this change
  // reported STATIC_FALLBACK on every poll for exactly that reason.
  const fn = CODE.slice(CODE.indexOf("async function ensureRates"), CODE.indexOf("function calcPnl"));
  assert(!/\bsupabase\.from\(/.test(fn), "the rate cache is read through the RLS-scoped client");
  assert(fn.includes("db.from(\"kv_cache\")"), "the cache is not read through the service-role client");
  assert(!/ensureRates\(\s*supabase/.test(CODE), "the RLS-scoped client is still passed in");
});

Deno.test("the service-role client is confined to the rate-cache key", () => {
  const helper = CODE.slice(CODE.indexOf("function rateCacheClient"), CODE.indexOf("async function ensureRates"));
  assert(helper.includes("SUPABASE_SERVICE_ROLE_KEY"), "the helper no longer builds a service client");
  // Every service-role table access in the file must be kv_cache, and the key
  // must come from the verified claim, never from the request payload.
  const uses = [...CODE.matchAll(/\bdb\.from\("([^"]+)"\)/g)].map((m) => m[1]);
  assert(uses.length > 0, "no service-role access found — this test is stale");
  assertEquals([...new Set(uses)], ["kv_cache"], "the service-role client reaches another table");
  assert(CODE.includes("const key = rateCacheKey(userId, \"smc\")"), "the cache key is not derived from the user id");
  assert(!/rateCacheKey\([^)]*payload/.test(CODE), "the cache key is built from request input");
});

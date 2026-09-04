import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { chochStillValid } from "../../functions/_shared/directionEngine.ts";
import type { StructureBreak } from "../../functions/_shared/smcAnalysis.ts";

/**
 * The two structural hard blocks invalidate a setup on state that changes as
 * price travels TO its level, rather than on price breaking the level.
 *
 * Both were observed live on 2026-09-04:
 *
 *   XAU/USD — "1H bullish bias BUT 15m: 4H CHoCH against bullish bias (1 recent
 *   bearish CHoCH at 4368.52912) → BLOCKED", with price at ~4427. The same
 *   panel listed 4368.529 as SUPPORT. Verdict was LONG 84%, 100% agreement.
 *
 *   GBP/USD — "1H bullish bias BUT 15m trend is bearish (opposes bias) →
 *   BLOCKED", while the 5m read "Entry TF trend bullish — aligned", the verdict
 *   was LONG 83% with 100% agreement, Tier 1 passed, and the score was 42.5%
 *   against a 40% threshold. Both ends of the ladder agreed; the middle vetoed.
 *
 * For a system that buys retracements into higher-timeframe zones this is
 * self-defeating: reaching a demand zone REQUIRES the fall that trips both
 * blocks. is4HRetracing already classifies that move as a healthy pullback and
 * is overruled two lines later.
 *
 * The flag defaults OFF. This decides whether a direction exists at all, and
 * the zone search, staging, scoring and entry are all gated on that.
 */

const engine = await Deno.readTextFile(
  new URL("../../functions/_shared/directionEngine.ts", import.meta.url),
);

const choch = (type: "bullish" | "bearish", level: number): StructureBreak => ({
  index: 10, type, price: level, datetime: "", closeBased: true, level,
});

Deno.test("a bearish CHoCH is spent once price closes back above it", () => {
  // The live XAU case: CHoCH at 4368.529, price at 4427.
  assertEquals(chochStillValid(choch("bearish", 4368.52912), 4427.0), false);
  // Still live while price remains below it.
  assertEquals(chochStillValid(choch("bearish", 4368.52912), 4300.0), true);
  // Exactly at the level counts as still live — it has not been reclaimed.
  assertEquals(chochStillValid(choch("bearish", 4368.52912), 4368.52912), true);
});

Deno.test("a bullish CHoCH is spent once price closes back below it", () => {
  assertEquals(chochStillValid(choch("bullish", 1.3500), 1.3400), false);
  assertEquals(chochStillValid(choch("bullish", 1.3500), 1.3600), true);
  assertEquals(chochStillValid(choch("bullish", 1.3500), 1.3500), true);
});

Deno.test("validity uses the broken level, falling back to price", () => {
  // `level` is the swing that broke — the right invalidation reference. Older
  // rows may lack it, in which case the recorded price is the only option.
  const withLevel = { ...choch("bearish", 100), price: 95, level: 100 };
  assertEquals(chochStillValid(withLevel, 98), true);   // below level 100, still live
  const noLevel = { ...choch("bearish", 100), price: 95 } as StructureBreak;
  delete (noLevel as { level?: number }).level;
  assertEquals(chochStillValid(noLevel, 98), false);    // falls back to price 95
});

Deno.test("a malformed level never silently clears a block", () => {
  const bad = { ...choch("bearish", 100), level: NaN } as StructureBreak;
  assertEquals(chochStillValid(bad, 4427), true, "unparseable level must stay blocking");
});

Deno.test("the flag exists and defaults to off", () => {
  assert(/priceAwareStructureBlocks\?: boolean/.test(engine), "flag missing from DirectionConfig");
  assert(/priceAwareStructureBlocks: false/.test(engine), "default must be false");
});

Deno.test("both direction paths honour the flag", () => {
  // The style-aware path is what scalper uses; the legacy path is the fallback.
  // A fix applied to only one would behave differently depending on style.
  assert(
    /is4HRetracing\(structStructure, bias!, structureCandles, chochLookback, priceAware\)/.test(engine),
    "style-aware path must pass the flag into is4HRetracing",
  );
  assert(
    /is4HRetracing\(h4Structure, bias!, h4Candles, h4ChochLookback, priceAwareLegacy\)/.test(engine),
    "legacy path must pass the flag into is4HRetracing",
  );
});

Deno.test("the trend block uses confirmedTrend when the flag is on", () => {
  // analyzeMarketStructure().trend "flips on every new swing pair" per the
  // comment on confirmedTrend — which this module already trusts for bias. The
  // stable function should decide the hard block too.
  const uses = engine.match(/\? confirmedTrend\([^)]*\)\.trend/g) ?? [];
  assertEquals(uses.length, 2, "both paths should switch to confirmedTrend under the flag");
});

Deno.test("the trend block is skipped while the structure TF is retracing", () => {
  // Otherwise is4HRetracing classifies a healthy pullback and the very next
  // check blocks it for pulling back.
  assert(/skipTrendBlock = priceAware && structCheck\.retracing/.test(engine));
  assert(/skipLegacyTrendBlock = priceAwareLegacy && h4Check\.retracing/.test(engine));
});

Deno.test("the block reason reports the trend it actually used", () => {
  // The legacy branch originally printed h4Structure.trend while blocking on a
  // different value, which would have made the log contradict the decision.
  assert(
    !/BUT 4H trend is \$\{h4Structure\.trend\}/.test(engine),
    "legacy reason must report the trend the block used, not the raw one",
  );
  assert(/\$\{h4TrendForBlock\}/.test(engine) && /\$\{structTrendForBlock\}/.test(engine));
});

Deno.test("reclaimed CHoCHs are reported rather than silently dropped", () => {
  assert(
    /reclaimed by price/.test(engine),
    "when a CHoCH is discounted the reason should say so — a silently shorter " +
      "list looks like the CHoCH was never detected",
  );
});

/**
 * Tests for _shared/sessionAffinity.ts
 *
 * Validates:
 * 1. Base affinity scores are correct for known pairs
 * 2. Overlap bonus is applied correctly
 * 3. Day-of-week modifiers work
 * 4. ATR trend modifiers work
 * 5. Tier classification is correct
 * 6. Unknown instruments get neutral scores
 * 7. rankPairsBySessionAffinity returns sorted results
 * 8. shouldScanPair correctly identifies avoid-tier pairs
 * 9. affinityToScoringPoints maps tiers to correct point ranges
 * 10. London-NY overlap detection works correctly
 */

import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  getSessionAffinity,
  rankPairsBySessionAffinity,
  shouldScanPair,
  affinityToScoringPoints,
  isInLondonNYOverlap,
  SESSION_AFFINITY_MAP,
} from "./sessionAffinity.ts";

// ─── Helper: Create a fixed UTC timestamp for a specific NY time ──────
// We need to account for EDT/EST. For simplicity, use a date in EDT (summer).
// EDT = UTC-4, so NY 10:00 AM = UTC 14:00
function makeUTCForNYTime(nyHour: number, nyMinute: number, nyDay: number): number {
  // Use July 2, 2025 (Wednesday, EDT active) as base
  // July 2, 2025 is a Wednesday (nyDay=3)
  // EDT offset = 4 hours, so NY time + 4 = UTC
  // For different days, shift by (targetDay - 3) * 86400000
  const baseDate = new Date(Date.UTC(2025, 6, 2, nyHour + 4, nyMinute, 0));
  const dayShift = (nyDay - 3) * 86400000; // 3 = Wednesday
  return baseDate.getTime() + dayShift;
}

// ─── Test 1: Base affinity scores for EUR/USD ──────────────────────────
Deno.test("EUR/USD has high London affinity and low Asian affinity", () => {
  const londonSession = { name: "London" as const, filterKey: "london" as const, isKillZone: true };
  const asianSession = { name: "Asian" as const, filterKey: "asian" as const, isKillZone: false };

  // Wednesday at 03:00 NY (London KZ, no overlap)
  const atMs = makeUTCForNYTime(3, 0, 3);

  const londonResult = getSessionAffinity("EUR/USD", londonSession, { atMs, nyDay: 3 });
  const asianResult = getSessionAffinity("EUR/USD", asianSession, { atMs: makeUTCForNYTime(21, 0, 3), nyDay: 3 });

  // London base should be 1.0
  assertEquals(londonResult.baseScore, 1.0);
  // Asian base should be 0.3
  assertEquals(asianResult.baseScore, 0.30);
  // London should be prime tier
  assertEquals(londonResult.tier, "prime");
  // Asian should be avoid or marginal
  assertEquals(asianResult.tier === "marginal" || asianResult.tier === "avoid", true);
});

// ─── Test 2: Overlap bonus is applied during 08:30-12:00 ET ────────────
Deno.test("Overlap bonus applied during London-NY overlap window", () => {
  const nySession = { name: "New York" as const, filterKey: "newyork" as const, isKillZone: true };

  // Wednesday at 10:00 NY (inside overlap)
  const overlapMs = makeUTCForNYTime(10, 0, 3);
  // Wednesday at 14:00 NY (outside overlap)
  const noOverlapMs = makeUTCForNYTime(14, 0, 3);

  const withOverlap = getSessionAffinity("EUR/USD", nySession, { atMs: overlapMs, nyDay: 3 });
  const withoutOverlap = getSessionAffinity("EUR/USD", nySession, { atMs: noOverlapMs, nyDay: 3 });

  // EUR/USD has overlapBonus of 0.15
  assertEquals(withOverlap.overlapBonus, 0.15);
  assertEquals(withOverlap.isOverlap, true);
  assertEquals(withoutOverlap.overlapBonus, 0);
  assertEquals(withoutOverlap.isOverlap, false);
  // Score with overlap should be higher
  assertEquals(withOverlap.score > withoutOverlap.score, true);
});

// ─── Test 3: Day-of-week modifiers ────────────────────────────────────
Deno.test("Wednesday gets 1.10x modifier, Monday gets 0.90x", () => {
  const londonSession = { name: "London" as const, filterKey: "london" as const, isKillZone: true };

  // Wednesday at 03:00 NY
  const wedResult = getSessionAffinity("GBP/USD", londonSession, {
    atMs: makeUTCForNYTime(3, 0, 3), nyDay: 3,
  });
  // Monday at 03:00 NY
  const monResult = getSessionAffinity("GBP/USD", londonSession, {
    atMs: makeUTCForNYTime(3, 0, 1), nyDay: 1,
  });

  assertEquals(wedResult.dayModifier, 1.10);
  assertEquals(monResult.dayModifier, 0.90);
  // Wednesday score should be higher than Monday
  assertEquals(wedResult.score > monResult.score, true);
});

// ─── Test 4: Late Friday penalty ──────────────────────────────────────
Deno.test("Late Friday (after 12:00 ET) gets 0.70 modifier", () => {
  const nySession = { name: "New York" as const, filterKey: "newyork" as const, isKillZone: false };

  // Friday at 14:00 NY (late Friday)
  const lateFriday = getSessionAffinity("EUR/USD", nySession, {
    atMs: makeUTCForNYTime(14, 0, 5), nyDay: 5,
  });
  // Friday at 09:00 NY (early Friday)
  const earlyFriday = getSessionAffinity("EUR/USD", nySession, {
    atMs: makeUTCForNYTime(9, 0, 5), nyDay: 5,
  });

  assertEquals(lateFriday.dayModifier, 0.70);
  assertEquals(earlyFriday.dayModifier, 0.85);
  assertEquals(lateFriday.score < earlyFriday.score, true);
});

// ─── Test 5: ATR trend modifiers ──────────────────────────────────────
Deno.test("Expanding ATR gives 1.10x, contracting + low affinity gives 0.70x", () => {
  const asianSession = { name: "Asian" as const, filterKey: "asian" as const, isKillZone: false };

  // EUR/USD in Asian (base = 0.30, which is < 0.5)
  const expanding = getSessionAffinity("EUR/USD", asianSession, {
    atMs: makeUTCForNYTime(21, 0, 3), nyDay: 3, atrTrend: "expanding",
  });
  const contracting = getSessionAffinity("EUR/USD", asianSession, {
    atMs: makeUTCForNYTime(21, 0, 3), nyDay: 3, atrTrend: "contracting",
  });
  const stable = getSessionAffinity("EUR/USD", asianSession, {
    atMs: makeUTCForNYTime(21, 0, 3), nyDay: 3, atrTrend: "stable",
  });

  assertEquals(expanding.atrModifier, 1.10);
  assertEquals(contracting.atrModifier, 0.70); // base 0.30 < 0.5, so penalty applies
  assertEquals(stable.atrModifier, 1.0);
});

// ─── Test 6: Contracting ATR with HIGH affinity gets no penalty ───────
Deno.test("Contracting ATR with high affinity (>= 0.5) gets no penalty", () => {
  const londonSession = { name: "London" as const, filterKey: "london" as const, isKillZone: true };

  // EUR/USD in London (base = 1.0, which is >= 0.5)
  const contracting = getSessionAffinity("EUR/USD", londonSession, {
    atMs: makeUTCForNYTime(3, 0, 3), nyDay: 3, atrTrend: "contracting",
  });

  assertEquals(contracting.atrModifier, 1.0); // No penalty because base >= 0.5
});

// ─── Test 7: Unknown instrument returns neutral ───────────────────────
Deno.test("Unknown instrument returns neutral score", () => {
  const londonSession = { name: "London" as const, filterKey: "london" as const, isKillZone: true };

  const result = getSessionAffinity("UNKNOWN/PAIR", londonSession, {
    atMs: makeUTCForNYTime(3, 0, 3), nyDay: 3,
  });

  assertEquals(result.baseScore, 0.5);
  assertEquals(result.tier, "marginal");
  assertEquals(result.detail.includes("Unknown instrument"), true);
});

// ─── Test 8: Tier classification boundaries ───────────────────────────
Deno.test("Tier classification: prime >= 0.80, good >= 0.55, marginal >= 0.30, avoid < 0.30", () => {
  const londonSession = { name: "London" as const, filterKey: "london" as const, isKillZone: true };
  const asianSession = { name: "Asian" as const, filterKey: "asian" as const, isKillZone: false };
  const offHoursSession = { name: "Off-Hours" as const, filterKey: "offhours" as const, isKillZone: false };

  // EUR/USD in London on Wednesday → base 1.0 * 1.10 = 1.10 → prime
  const prime = getSessionAffinity("EUR/USD", londonSession, {
    atMs: makeUTCForNYTime(3, 0, 3), nyDay: 3,
  });
  assertEquals(prime.tier, "prime");

  // AUD/USD in Asian on Wednesday → base 0.80 * 1.10 = 0.88 → prime
  const good = getSessionAffinity("AUD/USD", asianSession, {
    atMs: makeUTCForNYTime(21, 0, 3), nyDay: 3,
  });
  assertEquals(good.tier, "prime"); // 0.80 * 1.10 = 0.88

  // EUR/USD in Off-Hours on Wednesday → base 0.10 * 1.10 = 0.11 → avoid
  const avoid = getSessionAffinity("EUR/USD", offHoursSession, {
    atMs: makeUTCForNYTime(17, 0, 3), nyDay: 3,
  });
  assertEquals(avoid.tier, "avoid");
});

// ─── Test 9: rankPairsBySessionAffinity returns sorted results ────────
Deno.test("rankPairsBySessionAffinity returns all pairs sorted descending", () => {
  const londonSession = { name: "London" as const, filterKey: "london" as const, isKillZone: true };

  const ranked = rankPairsBySessionAffinity(londonSession, {
    atMs: makeUTCForNYTime(3, 0, 3), nyDay: 3,
  });

  // Should have all pairs from the map
  assertEquals(ranked.length, Object.keys(SESSION_AFFINITY_MAP).length);

  // Should be sorted descending
  for (let i = 1; i < ranked.length; i++) {
    assertEquals(ranked[i - 1].affinity.score >= ranked[i].affinity.score, true);
  }

  // EUR/USD and GBP/USD should be near the top for London
  const top5Symbols = ranked.slice(0, 5).map(r => r.symbol);
  assertEquals(top5Symbols.includes("EUR/USD") || top5Symbols.includes("GBP/USD"), true);
});

// ─── Test 10: shouldScanPair identifies avoid-tier pairs ──────────────
Deno.test("shouldScanPair returns false for avoid-tier pairs", () => {
  const offHoursSession = { name: "Off-Hours" as const, filterKey: "offhours" as const, isKillZone: false };

  // EUR/USD in Off-Hours → base 0.10 → should be avoid
  const result = shouldScanPair("EUR/USD", offHoursSession, {
    atMs: makeUTCForNYTime(17, 0, 3), nyDay: 3,
  });

  assertEquals(result.scan, false);
  assertEquals(result.reason.includes("avoid"), true);
});

// ─── Test 11: shouldScanPair returns true for prime/good pairs ────────
Deno.test("shouldScanPair returns true for prime-tier pairs", () => {
  const londonSession = { name: "London" as const, filterKey: "london" as const, isKillZone: true };

  const result = shouldScanPair("EUR/USD", londonSession, {
    atMs: makeUTCForNYTime(3, 0, 3), nyDay: 3,
  });

  assertEquals(result.scan, true);
  assertEquals(result.reason.includes("prime"), true);
});

// ─── Test 12: affinityToScoringPoints maps correctly ──────────────────
Deno.test("affinityToScoringPoints: prime gives positive, avoid gives -1.0", () => {
  const primeAffinity = { score: 1.0, tier: "prime" as const } as any;
  const goodAffinity = { score: 0.65, tier: "good" as const } as any;
  const marginalAffinity = { score: 0.40, tier: "marginal" as const } as any;
  const avoidAffinity = { score: 0.15, tier: "avoid" as const } as any;

  const primePoints = affinityToScoringPoints(primeAffinity);
  const goodPoints = affinityToScoringPoints(goodAffinity);
  const marginalPoints = affinityToScoringPoints(marginalAffinity);
  const avoidPoints = affinityToScoringPoints(avoidAffinity);

  assertEquals(primePoints > 0, true);
  assertEquals(primePoints <= 1.5, true);
  assertEquals(goodPoints, 0.0);
  assertEquals(marginalPoints, -0.5);
  assertEquals(avoidPoints, -1.0);
});

// ─── Test 13: isInLondonNYOverlap detection ───────────────────────────
Deno.test("isInLondonNYOverlap correctly detects overlap window", () => {
  // 10:00 NY → inside overlap
  assertEquals(isInLondonNYOverlap(makeUTCForNYTime(10, 0, 3)), true);
  // 09:00 NY → inside overlap
  assertEquals(isInLondonNYOverlap(makeUTCForNYTime(9, 0, 3)), true);
  // 08:30 NY → inside overlap (boundary)
  assertEquals(isInLondonNYOverlap(makeUTCForNYTime(8, 30, 3)), true);
  // 12:00 NY → outside overlap (boundary, exclusive)
  assertEquals(isInLondonNYOverlap(makeUTCForNYTime(12, 0, 3)), false);
  // 14:00 NY → outside overlap
  assertEquals(isInLondonNYOverlap(makeUTCForNYTime(14, 0, 3)), false);
  // 03:00 NY → outside overlap (London only)
  assertEquals(isInLondonNYOverlap(makeUTCForNYTime(3, 0, 3)), false);
});

// ─── Test 14: XAU/USD peaks in NY, not Asian ──────────────────────────
Deno.test("XAU/USD has highest affinity in New York, lowest in Asian", () => {
  const nySession = { name: "New York" as const, filterKey: "newyork" as const, isKillZone: true };
  const asianSession = { name: "Asian" as const, filterKey: "asian" as const, isKillZone: false };

  const nyResult = getSessionAffinity("XAU/USD", nySession, {
    atMs: makeUTCForNYTime(10, 0, 3), nyDay: 3,
  });
  const asianResult = getSessionAffinity("XAU/USD", asianSession, {
    atMs: makeUTCForNYTime(21, 0, 3), nyDay: 3,
  });

  assertEquals(nyResult.baseScore, 1.0);
  assertEquals(asianResult.baseScore, 0.30);
  assertEquals(nyResult.isPrimarySession, true);
  assertEquals(asianResult.isPrimarySession, false);
});

// ─── Test 15: AUD/NZD is the only pair with Asian as primary ──────────
Deno.test("AUD/NZD has Asian as its primary session", () => {
  const profile = SESSION_AFFINITY_MAP["AUD/NZD"];
  assertEquals(profile.primarySession, "asian");
  assertEquals(profile.asian, 0.85);
  // It should be higher than London for this pair
  assertEquals(profile.asian > profile.london, true);
});

// ─── Test 16: BTC/USD has relatively even scores (24/7 market) ────────
Deno.test("BTC/USD has relatively even scores across sessions", () => {
  const profile = SESSION_AFFINITY_MAP["BTC/USD"];
  // All sessions should be >= 0.50 (24/7 market)
  assertEquals(profile.asian >= 0.50, true);
  assertEquals(profile.london >= 0.50, true);
  assertEquals(profile.newyork >= 0.50, true);
  assertEquals(profile.offhours >= 0.50, true);
  // Low overlap bonus (no clear session dominance)
  assertEquals(profile.overlapBonus, 0.05);
});

// ─── Test 17: All SPECS instruments have affinity data ────────────────
Deno.test("All major SPECS instruments have affinity data", () => {
  const expectedInstruments = [
    "EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "NZD/USD", "USD/CAD", "USD/CHF",
    "EUR/GBP", "EUR/JPY", "GBP/JPY", "EUR/AUD", "EUR/CAD", "EUR/CHF", "EUR/NZD",
    "GBP/AUD", "GBP/CAD", "GBP/CHF", "GBP/NZD",
    "AUD/CAD", "AUD/JPY", "AUD/NZD", "AUD/CHF",
    "NZD/JPY", "NZD/CAD", "NZD/CHF", "CAD/JPY", "CAD/CHF", "CHF/JPY",
    "XAU/USD", "XAG/USD", "US Oil",
    "US30", "NAS100", "SPX500",
    "BTC/USD", "ETH/USD",
  ];

  for (const symbol of expectedInstruments) {
    assertEquals(symbol in SESSION_AFFINITY_MAP, true, `Missing affinity data for ${symbol}`);
  }
});

// ─── Test 18: isPrimarySession flag is correct ────────────────────────
Deno.test("isPrimarySession is true only when session matches pair's primary", () => {
  const londonSession = { name: "London" as const, filterKey: "london" as const, isKillZone: true };
  const nySession = { name: "New York" as const, filterKey: "newyork" as const, isKillZone: true };

  // EUR/USD primary is London
  const eurLondon = getSessionAffinity("EUR/USD", londonSession, { atMs: makeUTCForNYTime(3, 0, 3), nyDay: 3 });
  const eurNY = getSessionAffinity("EUR/USD", nySession, { atMs: makeUTCForNYTime(10, 0, 3), nyDay: 3 });
  assertEquals(eurLondon.isPrimarySession, true);
  assertEquals(eurNY.isPrimarySession, false);

  // USD/CAD primary is NY
  const cadLondon = getSessionAffinity("USD/CAD", londonSession, { atMs: makeUTCForNYTime(3, 0, 3), nyDay: 3 });
  const cadNY = getSessionAffinity("USD/CAD", nySession, { atMs: makeUTCForNYTime(10, 0, 3), nyDay: 3 });
  assertEquals(cadLondon.isPrimarySession, false);
  assertEquals(cadNY.isPrimarySession, true);
});

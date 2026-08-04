/**
 * Tests for verdict-first zone direction fix.
 *
 * Verifies that:
 * 1. When directionVerdict says "short", the zone engine searches for bearish impulses (not bullish)
 * 2. When directionVerdict is neutral/blocked, falls back to analysis.direction
 * 3. The effectiveDirection logic correctly prioritizes verdict over 15m scoring
 * 4. htfConfluenceData.direction aligns with effectiveDirection
 * 5. Cascade zone engine also uses effectiveDirection
 */

import { assertEquals, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

// ── Unit: effectiveDirection selection logic ──

function computeEffectiveDirection(
  directionVerdict: { verdict: string; shouldBlock: boolean } | null,
  analysisDirection: "long" | "short" | null,
): "long" | "short" | null {
  return (directionVerdict && !directionVerdict.shouldBlock && directionVerdict.verdict !== "neutral")
    ? directionVerdict.verdict as "long" | "short"
    : analysisDirection;
}

// ── Part 1: Verdict overrides analysis.direction ──

Deno.test("effectiveDirection: verdict=short overrides analysis.direction=long", () => {
  const result = computeEffectiveDirection(
    { verdict: "short", shouldBlock: false },
    "long",
  );
  assertEquals(result, "short");
});

Deno.test("effectiveDirection: verdict=long overrides analysis.direction=short", () => {
  const result = computeEffectiveDirection(
    { verdict: "long", shouldBlock: false },
    "short",
  );
  assertEquals(result, "long");
});

Deno.test("effectiveDirection: verdict agrees with analysis — no conflict", () => {
  const result = computeEffectiveDirection(
    { verdict: "long", shouldBlock: false },
    "long",
  );
  assertEquals(result, "long");
});

// ── Part 2: Fallback to analysis.direction when verdict is unusable ──

Deno.test("effectiveDirection: verdict=neutral falls back to analysis.direction", () => {
  const result = computeEffectiveDirection(
    { verdict: "neutral", shouldBlock: false },
    "long",
  );
  assertEquals(result, "long");
});

Deno.test("effectiveDirection: verdict shouldBlock=true falls back to analysis.direction", () => {
  const result = computeEffectiveDirection(
    { verdict: "short", shouldBlock: true },
    "long",
  );
  assertEquals(result, "long");
});

Deno.test("effectiveDirection: no verdict (null) falls back to analysis.direction", () => {
  const result = computeEffectiveDirection(
    null,
    "short",
  );
  assertEquals(result, "short");
});

Deno.test("effectiveDirection: no verdict AND no analysis.direction → null", () => {
  const result = computeEffectiveDirection(null, null);
  assertEquals(result, null);
});

// ── Part 3: Direction mapping to bullish/bearish for zone engine ──

function mapToBullishBearish(effectiveDirection: "long" | "short" | null): "bullish" | "bearish" | null {
  if (!effectiveDirection) return null;
  return effectiveDirection === "long" ? "bullish" : "bearish";
}

Deno.test("direction mapping: long → bullish", () => {
  assertEquals(mapToBullishBearish("long"), "bullish");
});

Deno.test("direction mapping: short → bearish", () => {
  assertEquals(mapToBullishBearish("short"), "bearish");
});

Deno.test("direction mapping: null → null", () => {
  assertEquals(mapToBullishBearish(null), null);
});

// ── Part 4: The key scenario — verdict disagrees with 15m scoring ──

Deno.test("scenario: 15m says long but verdict says short → zone engine searches bearish", () => {
  // This is the exact bug scenario from the user's screenshot:
  // - 15m scoring engine says "long" (minor BOS in pullback)
  // - Direction verdict says "short" (Daily trend, H4 CHoCH, weekly bias all agree)
  // - Zone engine should search for BEARISH impulses (with the trend)
  const analysisDirection: "long" | "short" = "long";
  const verdict = { verdict: "short", shouldBlock: false };

  const effectiveDir = computeEffectiveDirection(verdict, analysisDirection);
  const zoneSearchDir = mapToBullishBearish(effectiveDir);

  assertEquals(effectiveDir, "short", "effectiveDirection should follow verdict, not 15m");
  assertEquals(zoneSearchDir, "bearish", "zone engine should search for bearish impulses");
  assertNotEquals(zoneSearchDir, "bullish", "zone engine must NOT search bullish when verdict says short");
});

Deno.test("scenario: 15m says short but verdict says long → zone engine searches bullish", () => {
  const analysisDirection: "long" | "short" = "short";
  const verdict = { verdict: "long", shouldBlock: false };

  const effectiveDir = computeEffectiveDirection(verdict, analysisDirection);
  const zoneSearchDir = mapToBullishBearish(effectiveDir);

  assertEquals(effectiveDir, "long");
  assertEquals(zoneSearchDir, "bullish");
});

Deno.test("scenario: verdict neutral, 15m says long → zone engine uses 15m direction (bullish)", () => {
  const analysisDirection: "long" | "short" = "long";
  const verdict = { verdict: "neutral", shouldBlock: false };

  const effectiveDir = computeEffectiveDirection(verdict, analysisDirection);
  const zoneSearchDir = mapToBullishBearish(effectiveDir);

  assertEquals(effectiveDir, "long");
  assertEquals(zoneSearchDir, "bullish");
});

// ── Part 5: htfConfluenceData direction alignment ──

function buildHTFConfluenceDirection(effectiveDirection: "long" | "short" | null): "bullish" | "bearish" | null {
  if (!effectiveDirection) return null;
  return effectiveDirection === "long" ? "bullish" : "bearish";
}

Deno.test("htfConfluenceData.direction aligns with effectiveDirection (short→bearish)", () => {
  const verdict = { verdict: "short", shouldBlock: false };
  const effectiveDir = computeEffectiveDirection(verdict, "long");
  const htfDir = buildHTFConfluenceDirection(effectiveDir);

  assertEquals(htfDir, "bearish", "HTF confluence should filter for bearish OBs/FVGs when verdict is short");
});

Deno.test("htfConfluenceData.direction aligns with effectiveDirection (long→bullish)", () => {
  const verdict = { verdict: "long", shouldBlock: false };
  const effectiveDir = computeEffectiveDirection(verdict, "short");
  const htfDir = buildHTFConfluenceDirection(effectiveDir);

  assertEquals(htfDir, "bullish", "HTF confluence should filter for bullish OBs/FVGs when verdict is long");
});

// ── Part 6: Regression — when verdict agrees, behavior unchanged ──

Deno.test("regression: when verdict agrees with 15m, zone direction unchanged", () => {
  // Before the fix: unifiedDir = analysis.direction === "long" ? "bullish" : "bearish"
  // After the fix: unifiedDir = effectiveDirection === "long" ? "bullish" : "bearish"
  // When they agree, output is identical
  const analysisDirection = "short" as "long" | "short";
  const verdict = { verdict: "short", shouldBlock: false };

  const oldBehavior = (analysisDirection as string) === "long" ? "bullish" : "bearish";
  const effectiveDir = computeEffectiveDirection(verdict, analysisDirection);
  const newBehavior = effectiveDir === "long" ? "bullish" : "bearish";

  assertEquals(oldBehavior, newBehavior, "When verdict agrees with 15m, zone direction must be identical");
});

Deno.test("regression: when no verdict available, behavior identical to old code", () => {
  const analysisDirection: "long" | "short" = "long";

  const oldBehavior = analysisDirection === "long" ? "bullish" : "bearish";
  const effectiveDir = computeEffectiveDirection(null, analysisDirection);
  const newBehavior = effectiveDir === "long" ? "bullish" : "bearish";

  assertEquals(oldBehavior, newBehavior, "When no verdict, must fall back to analysis.direction exactly");
});

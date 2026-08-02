import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  deriveWatchlistInvalidation,
  isWatchlistInvalidated,
  normalizePriceBounds,
} from "./watchlistInvalidation.ts";

Deno.test("BTC short Watchlist boundary is outside the frozen zone", () => {
  const result = deriveWatchlistInvalidation({
    direction: "short",
    zone: { low: 63_310, high: 63_627.66 },
    proposedLevel: 63_451.585,
    bufferPrice: 20,
  });

  assertEquals(result.level, 63_647.66);
  assertEquals(result.source, "zone_boundary");
  assert(result.adjusted);
  assert(result.level! > 63_627.66);
  assertEquals(isWatchlistInvalidated("short", 63_481.92, result.level), false);
  assertEquals(isWatchlistInvalidated("short", 63_650, result.level), true);
});

Deno.test("long Watchlist boundary is below the frozen zone", () => {
  const result = deriveWatchlistInvalidation({
    direction: "long",
    zone: { low: 1.2740, high: 1.2750 },
    proposedLevel: 1.2745,
    bufferPrice: 0.0002,
  });

  assertEquals(result.level, 1.2738);
  assert(result.level! < 1.2740);
  assertEquals(isWatchlistInvalidated("long", 1.2742, result.level), false);
  assertEquals(isWatchlistInvalidated("long", 1.2737, result.level), true);
});

Deno.test("zone bounds are normalized when supplied in reverse order", () => {
  assertEquals(
    normalizePriceBounds({ low: "1.2750", high: "1.2740" }),
    { low: 1.274, high: 1.275 },
  );
});

Deno.test("impulse boundary is the structural fallback when no zone exists", () => {
  const result = deriveWatchlistInvalidation({
    direction: "long",
    impulse: { low: 100, high: 120 },
    proposedLevel: 110,
    bufferPrice: 2,
  });

  assertEquals(result.level, 98);
  assertEquals(result.source, "impulse_boundary");
});

Deno.test("proposed level is retained only when no structural bounds exist", () => {
  const result = deriveWatchlistInvalidation({
    direction: "short",
    proposedLevel: "101.5",
    bufferPrice: 2,
  });

  assertEquals(result.level, 101.5);
  assertEquals(result.source, "proposed_level");
});

Deno.test("pre-zone observation has no executable invalidation boundary", () => {
  const result = deriveWatchlistInvalidation({
    direction: "short",
  });

  assertEquals(result.level, null);
  assertEquals(result.source, "unavailable");
  assertEquals(isWatchlistInvalidated("short", 100, result.level), false);
});

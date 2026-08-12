import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildCanonicalStructureAuthority } from "../functions/_shared/canonicalStructureAuthority.ts";
import { observeLiquidityConfirmation } from "../functions/_shared/liquidityConfirmationContract.ts";

const event = (overrides: Record<string, unknown> = {}) => ({
  id: "legacy-sweep",
  durableId: "sweep:durable",
  type: "sweep",
  direction: "bearish",
  significance: "internal",
  levelId: "level",
  level: 1.25,
  candleIndex: 10,
  datetime: "2026-08-12T10:00:00Z",
  close: 1.24,
  extreme: 1.26,
  closeDistance: 0,
  displacementRatio: 0.5,
  ...overrides,
}) as any;

const sequence = (sweep = event(), shift = event({
  id: "legacy-shift",
  durableId: "structure:durable",
  type: "choch",
  candleIndex: 11,
  datetime: "2026-08-12T10:05:00Z",
})) => ({
  id: "liquidity:legacy-sweep",
  durableId: "liquidity:sweep:durable",
  direction: "bearish",
  status: "fakeout_confirmed",
  sweep,
  shift,
  inducement: null,
  entryReady: true,
  reasonCodes: [],
}) as any;

Deno.test("same-candle touch and sweep allow later-candle confirmation", () => {
  const result = observeLiquidityConfirmation({
    candidateId: "candidate",
    stagedAt: "2026-08-12T09:00:00Z",
    zoneTouchTime: "2026-08-12T10:00:00Z",
    sequence: sequence(),
  });
  assertEquals(result.ready, true);
  assertEquals(result.reasonCode, "sequence_confirmed");
});

Deno.test("confirmation on the sweep candle fails closed", () => {
  const result = observeLiquidityConfirmation({
    candidateId: "candidate",
    stagedAt: "2026-08-12T09:00:00Z",
    zoneTouchTime: "2026-08-12T10:00:00Z",
    sequence: sequence(undefined, event({
      durableId: "structure:same-candle",
      type: "choch",
      datetime: "2026-08-12T10:00:00Z",
    })),
  });
  assertEquals(result.ready, false);
  assertEquals(result.reasonCode, "confirmation_not_after_sweep");
});

Deno.test("missing sweep and unresolved sweep identity are distinct", () => {
  const common = {
    candidateId: "candidate",
    stagedAt: "2026-08-12T09:00:00Z",
    zoneTouchTime: "2026-08-12T10:00:00Z",
  };
  assertEquals(observeLiquidityConfirmation(common).reasonCode, "no_qualifying_sweep");
  assertEquals(observeLiquidityConfirmation({
    ...common,
    sequence: sequence(event({ durableId: "" })),
  }).reasonCode, "sweep_identity_unresolved");
});

Deno.test("durable structure identity survives a shifted candle window", () => {
  const candle = (minute: number, open: number, high: number, low: number, close: number) => ({
    datetime: new Date(Date.UTC(2026, 7, 12, 10, minute)).toISOString(),
    open, high, low, close, volume: 1,
  });
  const candles = [
    candle(0, 8, 9, 7, 8), candle(5, 9, 10, 8, 9),
    candle(10, 10, 12, 9, 11), candle(15, 10, 11, 8, 9),
    candle(20, 9, 10, 7, 8), candle(25, 11, 13, 9, 11.5),
  ];
  const shifted = [candle(-5, 7, 8, 6, 7), ...candles];
  const options = { symbol: "EUR/USD", timeframe: "5m", internalLookback: 2, externalLookback: 3, internalAtrFilter: 0, externalAtrFilter: 0 };
  const first = buildCanonicalStructureAuthority(candles as any, options);
  const second = buildCanonicalStructureAuthority(shifted as any, options);
  const shared = first.levels.find((level) => second.levels.some((candidate) => candidate.datetime === level.datetime && candidate.price === level.price));
  assert(shared);
  const shiftedMatch = second.levels.find((level) => level.datetime === shared.datetime && level.price === shared.price)!;
  assertEquals(shared.durableId, shiftedMatch.durableId);
  assertNotEquals(shared.id, shiftedMatch.id);
});

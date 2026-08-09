import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildImpulseEntryLifecycle } from "../functions/_shared/impulseEntryLifecycle.ts";
import { advanceTradeLifecycle } from "../functions/_shared/tradeLifecycleAuthority.ts";

Deno.test("shared lifecycle advances to a deeper candidate after close failure", () => {
  const lifecycle = buildImpulseEntryLifecycle({ mode: "observe", now: "2026-01-01T00:00:00Z", impulse: { id: "i", direction: "long", timeframe: "1H", rangeLow: 90, rangeHigh: 110, protectedLevel: 90, expiresAt: "2026-01-02T00:00:00Z" }, candidates: [
    { id: "z1", type: "fvg", low: 100, high: 102, timeframe: "15m", impulseId: "i" },
    { id: "z2", type: "ob", low: 95, high: 97, timeframe: "15m", impulseId: "i" },
  ], confirmation: { method: "choch", timeframe: "5m", refinementTimeframe: "1m", expiresAt: "2026-01-02T00:00:00Z" } });
  const candle = { datetime: "2026-01-01T01:00:00Z", open: 101, high: 101, low: 98, close: 99 };
  const result = advanceTradeLifecycle({ lifecycle, candle, completedCandles: [candle] });
  assertEquals(result.events[0].type, "candidate_failed");
  assertEquals(result.after.activeCandidateId, "z2");
  assertEquals(result.disposition, "watch");
});

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildImpulseEntryLifecycle } from "../../functions/_shared/impulseEntryLifecycle.ts";
import { replayImpulseEntryLifecycle } from "../../functions/_shared/impulseLifecycleReplay.ts";

function base(expiresAt = "2026-08-06T11:00:00.000Z") {
  return buildImpulseEntryLifecycle({
    now: "2026-08-06T10:00:00.000Z",
    impulse: { id: "i", direction: "long", timeframe: "4H", rangeLow: 90, rangeHigh: 110, protectedLevel: 89, expiresAt },
    candidates: [
      { id: "z1", type: "fvg", low: 100, high: 102, timeframe: "1H", impulseId: "i" },
      { id: "z2", type: "ob", low: 95, high: 97, timeframe: "1H", impulseId: "i" },
    ],
    confirmation: { method: "choch", timeframe: "5m", refinementTimeframe: "1m", expiresAt },
    initialCandidateId: "z1",
  });
}
const candle = (datetime: string, close: number) => ({ datetime, open: close, high: close + .2, low: close - .2, close, volume: 1 });

Deno.test("replay separates zone failure from impulse invalidation and advances deeper", () => {
  const result = replayImpulseEntryLifecycle({ lifecycle: base(), candles: [
    candle("2026-08-06T10:05:00.000Z", 99),
    candle("2026-08-06T10:10:00.000Z", 96),
    candle("2026-08-06T10:15:00.000Z", 88),
  ] });
  assertEquals(result.transitions[0].event, "candidate_failed");
  assertEquals(result.transitions[0].toCandidateId, "z2");
  assertEquals(result.transitions.at(-1)?.event, "impulse_invalidated");
  assertEquals(result.finalStatus, "invalidated");
});

Deno.test("replay expires deterministically", () => {
  const result = replayImpulseEntryLifecycle({ lifecycle: base("2026-08-06T10:06:00.000Z"), candles: [
    candle("2026-08-06T10:10:00.000Z", 101),
  ] });
  assertEquals(result.finalStatus, "expired");
  assertEquals(result.outcome, "no_entry");
});

/**
 * Phase 1 evidence contract tests — observation only.
 *
 * These prove that collecting per-timeframe evidence cannot change scoring,
 * ranking, gating, staging or execution: the builders are pure with respect to
 * their inputs, persistence is bounded/chunked, and every confirmation attempt
 * is preserved as its own immutable row.
 */

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildConfirmationEvidenceRow,
  buildScanEvidenceRow,
  chunkEvidenceRows,
  DEFAULT_CHUNK_LIMITS,
  EVIDENCE_CONFLICT_TARGET,
  NIL_UUID,
  persistZoneTimeframeEvidence,
  rowBytes,
} from "../supabase/functions/_shared/zoneTimeframeEvidence.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";

function candles(n: number, base = 1.1): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const o = base + i * 0.0005;
    out.push({
      datetime: new Date(Date.UTC(2026, 0, 1, i)).toISOString(),
      open: o,
      high: o + 0.0008,
      low: o - 0.0006,
      close: o + 0.0004,
      volume: 1000,
    } as Candle);
  }
  return out;
}

const multiTF = {
  selectedTF: "1h",
  reason: "no valid zone on any timeframe",
  dailyResult: null,
  h4Result: null,
  h1Result: null,
} as any;

const baseContext = {
  userId: "11111111-1111-1111-1111-111111111111",
  botId: "bot-a",
  scanCycleId: "cycle-1",
  symbol: "EUR/USD",
  direction: "bullish" as const,
  observedAt: "2026-01-02T00:00:00.000Z",
  tradingStyle: "scalper",
  stylePolicyVersion: "style-policy.v1",
  styleBasePolicyHash: "base",
  stylePolicyHash: "pair",
};

Deno.test("scan evidence build does not mutate engine inputs", () => {
  const top = candles(30);
  const mid = candles(30, 1.2);
  const low = candles(30, 1.3);
  const before = JSON.stringify({ top, mid, low, multiTF });
  buildScanEvidenceRow(
    multiTF,
    {
      top: { timeframe: "1d", candles: top },
      mid: { timeframe: "4h", candles: mid },
      low: { timeframe: "1h", candles: low },
    },
    baseContext,
  );
  assertEquals(JSON.stringify({ top, mid, low, multiTF }), before);
});

Deno.test("scan evidence row carries no execution fields", () => {
  const row = buildScanEvidenceRow(
    multiTF,
    {
      top: { timeframe: "1d", candles: candles(30) },
      mid: { timeframe: "4h", candles: candles(30) },
      low: { timeframe: "1h", candles: candles(30) },
    },
    baseContext,
  );
  assertEquals(row.evidence_source, "live_scan");
  assertEquals(row.pending_order_id, NIL_UUID);
  assertEquals(row.confirmation_attempt, 0);
  for (
    const forbidden of [
      "score",
      "gate_result",
      "authorized",
      "entry_price",
      "stop_loss",
      "take_profit",
      "status",
    ]
  ) {
    assert(!(forbidden in row), `evidence row must not carry ${forbidden}`);
  }
});

Deno.test("chunking respects both row-count and byte ceilings", () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ i, pad: "x".repeat(100) }));
  const chunks = chunkEvidenceRows(rows, DEFAULT_CHUNK_LIMITS);
  assertEquals(chunks.flat().length, rows.length);
  for (const chunk of chunks) {
    assert(chunk.length <= DEFAULT_CHUNK_LIMITS.maxRows);
    assert(rowBytes(chunk) <= DEFAULT_CHUNK_LIMITS.maxBytes || chunk.length === 1);
  }

  const fat = Array.from({ length: 4 }, (_, i) => ({ i, pad: "y".repeat(300) }));
  const byBytes = chunkEvidenceRows(fat, { maxRows: 100, maxBytes: 700 });
  assert(byBytes.length > 1, "byte ceiling must close a chunk before maxRows");
});

Deno.test("persistence never throws into the scan path", async () => {
  const seen: unknown[][] = [];
  const failing = {
    from() {
      return {
        upsert(chunk: unknown[]) {
          seen.push(chunk);
          return Promise.resolve({ error: { message: "boom" } });
        },
      };
    },
  };
  const result = await persistZoneTimeframeEvidence(
    failing as any,
    Array.from({ length: 12 }, (_, i) => ({ i })) as any,
  );
  assertEquals(result.written, 0);
  assertEquals(result.failedChunks, seen.length);
  assert(seen.length >= 2, "rows must be sent in bounded chunks, not one request");
});

Deno.test("persistence upserts on the multi-attempt identity", () => {
  assert(EVIDENCE_CONFLICT_TARGET.includes("pending_order_id"));
  assert(EVIDENCE_CONFLICT_TARGET.includes("confirmation_attempt"));
  assert(EVIDENCE_CONFLICT_TARGET.includes("evidence_source"));
});

Deno.test("each confirmation attempt is a distinct immutable row", () => {
  const pendingOrderId = "22222222-2222-2222-2222-222222222222";
  const make = (attempt: number, passed: boolean) =>
    buildConfirmationEvidenceRow(
      { ...baseContext, pendingOrderId, confirmationAttempt: attempt },
      {
        timeframe: "5min",
        candleCount: 120,
        confirmationMethod: "choch",
        confirmationPassed: passed,
        reason: passed ? "confirmation_passed" : "no_choch_confirmation",
        chochTier: passed ? 1 : null,
        chochType: passed ? "bullish_choch" : null,
        indicatorsPassed: null,
        indicatorsRequired: 2,
        hasRefinedZone: true,
        zoneHigh: 1.105,
        zoneLow: 1.1,
        currentPrice: 1.102,
      },
    );
  const first = make(1, false);
  const second = make(2, true);
  assertEquals(first.evidence_source, "confirmation");
  assertEquals(first.pending_order_id, pendingOrderId);
  assert(first.confirmation_attempt !== second.confirmation_attempt);
  assert(
    JSON.stringify(first.slots) !== JSON.stringify(second.slots),
    "a later attempt must not be collapsed into the earlier one",
  );
});

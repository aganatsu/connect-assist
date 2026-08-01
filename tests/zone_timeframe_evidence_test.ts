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
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  annotateEvidenceLifecycle,
  buildCompactSummary,
  buildConfirmationEvidenceRow,
  buildScanEvidenceRow,
  buildTimeframeEvidence,
  chunkEvidenceRows,
  DEFAULT_CHUNK_LIMITS,
  EVIDENCE_CONFLICT_TARGET,
  nextConfirmationAttempt,
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
  assert(
    typeof row.id === "string" && row.id.length > 0,
    "the source scan must own its evidence UUID before downstream records freeze it",
  );
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

Deno.test("caller-provided evidence identity is preserved exactly", () => {
  const evidenceId = "33333333-3333-3333-3333-333333333333";
  const row = buildScanEvidenceRow(
    multiTF,
    {
      top: { timeframe: "1d", candles: candles(30) },
      mid: { timeframe: "4h", candles: candles(30) },
      low: { timeframe: "1h", candles: candles(30) },
    },
    { ...baseContext, evidenceId },
  );
  assertEquals(row.id, evidenceId);
});

Deno.test("no-impulse outcomes retain a structured terminal rejection", () => {
  const slot = buildTimeframeEvidence(
    {
      slot: "top",
      timeframe: "1h",
      candles: candles(30),
      result: {
        bestZone: null,
        impulse: null,
        allZones: [],
        reason: "No valid impulse found (no BOS/CHoCH or origin broken)",
      } as any,
    },
    baseContext,
  );
  assertEquals(slot.rejections[0]?.stage, "impulse");
  assertEquals(slot.rejections[0]?.code, "no_valid_impulse");
});

Deno.test("ranked runner-up evidence is bounded to the top three", () => {
  const impulse = {
    direction: "bullish",
    high: 1.2,
    low: 1.1,
    startIndex: 2,
    endIndex: 20,
    isValid: true,
    bosPrice: 1.19,
    startDate: "2026-01-01T02:00",
    endDate: "2026-01-01T20:00",
    spanBars: 18,
  };
  const allZones = Array.from({ length: 6 }, (_, index) => ({
    poi: {
      type: "ob",
      high: 1.18 - index * 0.001,
      low: 1.175 - index * 0.001,
      candleIndex: 5 + index,
      direction: "bullish",
    },
    fibLevel: 0.786,
    fibDepth: 0.7 - index * 0.01,
    fibScore: 3,
    srConfirmed: false,
    ltfRefined: false,
    htfConfluenceScore: 0,
    htfLayers: [],
    totalScore: 10 - index,
  }));
  const slot = buildTimeframeEvidence(
    {
      slot: "top",
      timeframe: "1h",
      candles: candles(30),
      result: {
        bestZone: allZones[0],
        impulse,
        allZones,
        reason: "Zone selected",
      } as any,
    },
    baseContext,
  );
  assertEquals(slot.impulses.filter((item) => item.selected).length, 1);
  assertEquals(slot.impulses[0].high, impulse.high);
  assertEquals(slot.impulses[0].low, impulse.low);
  assert(
    slot.pois.every((poi) =>
      poi.impulseId === slot.impulses[0].impulseId
    ),
    "all mapped POIs must point to the exact engine-selected impulse",
  );
  assertEquals(slot.candidates.length, 3);
  assertEquals(slot.candidates.map((candidate) => candidate.rank), [1, 2, 3]);
  assertEquals(slot.truncated?.candidates, 3);
});

Deno.test("lifecycle annotations activate longer retention without changing evidence payload", () => {
  const row = buildScanEvidenceRow(
    multiTF,
    {
      top: { timeframe: "1d", candles: candles(30) },
      mid: { timeframe: "4h", candles: candles(30) },
      low: { timeframe: "1h", candles: candles(30) },
    },
    baseContext,
  );
  const immutableBefore = JSON.stringify({
    slots: row.slots,
    engineOptions: row.engine_options,
    selectedTimeframe: row.selected_timeframe,
    finalReason: row.final_reason,
  });
  annotateEvidenceLifecycle(row, {
    status: "trade_placed",
    linkedSetupId: "66666666-6666-6666-6666-666666666666",
    positionId: "77777777-7777-7777-7777-777777777777",
    impulseZone: {
      bestZone: {
        shadowRanking: { legacyRank: 1, shadowRank: 2 },
      },
    },
  });
  assertEquals(row.event_linked, true);
  assertEquals(
    row.linked_setup_id,
    "66666666-6666-6666-6666-666666666666",
  );
  assertEquals(
    row.linked_trade_id,
    "77777777-7777-7777-7777-777777777777",
  );
  assertEquals(row.has_disagreement, true);
  assertEquals(
    JSON.stringify({
      slots: row.slots,
      engineOptions: row.engine_options,
      selectedTimeframe: row.selected_timeframe,
      finalReason: row.final_reason,
    }),
    immutableBefore,
  );
});

Deno.test("compact summary preserves the engine-selected timeframe winner", () => {
  const row = {
    id: "88888888-8888-8888-8888-888888888888",
    user_id: baseContext.userId,
    bot_id: baseContext.botId,
    scan_cycle_id: baseContext.scanCycleId,
    symbol: baseContext.symbol,
    direction: baseContext.direction,
    evidence_source: "live_scan",
    pending_order_id: NIL_UUID,
    confirmation_attempt: 0,
    selected_timeframe: "1h",
    final_reason: "1h selected by cross-timeframe authority",
    slots: [
      {
        slot: "mid",
        timeframe: "4h",
        rejections: [],
        pois: [],
        candidates: [{ candidateId: "higher-raw-score", rank: 1, totalScore: 9 }],
      },
      {
        slot: "low",
        timeframe: "1h",
        rejections: [],
        pois: [],
        candidates: [{ candidateId: "actual-engine-winner", rank: 1, totalScore: 7 }],
      },
    ],
  } as any;
  const summary = buildCompactSummary(row);
  assertEquals(summary.winner_candidate_id, "actual-engine-winner");
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

Deno.test("confirmation attempts come from the atomic pending-order allocator", async () => {
  let rpcArgs: Record<string, unknown> | null = null;
  const supabase = {
    rpc(name: string, args: Record<string, unknown>) {
      assertEquals(name, "allocate_zone_confirmation_evidence_attempt");
      rpcArgs = args;
      return Promise.resolve({ data: 7, error: null });
    },
  };
  const attempt = await nextConfirmationAttempt(supabase as any, {
    userId: baseContext.userId,
    botId: baseContext.botId,
    symbol: baseContext.symbol,
    direction: baseContext.direction,
    pendingOrderId: "44444444-4444-4444-4444-444444444444",
  });
  assertEquals(attempt, 7);
  assertEquals(rpcArgs, {
    p_user_id: baseContext.userId,
    p_bot_id: baseContext.botId,
    p_pending_order_id: "44444444-4444-4444-4444-444444444444",
  });
});

Deno.test("confirmation evidence fails closed when atomic allocation is unavailable", async () => {
  const supabase = {
    rpc() {
      return Promise.resolve({
        data: null,
        error: { message: "function unavailable" },
      });
    },
  };
  await assertRejects(
    () =>
      nextConfirmationAttempt(supabase as any, {
        userId: baseContext.userId,
        botId: baseContext.botId,
        symbol: baseContext.symbol,
        direction: baseContext.direction,
        pendingOrderId: "55555555-5555-5555-5555-555555555555",
      }),
    Error,
    "attempt allocation failed",
  );
});

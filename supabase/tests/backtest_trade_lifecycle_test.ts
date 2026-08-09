import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  advanceBacktestTradeLifecycle,
  discoverBacktestTradeLifecycle,
  emptyBacktestTradeLifecycleState,
  isBacktestTradeLifecycleEntryReady,
} from "../functions/_shared/backtestTradeLifecycle.ts";

const range = {
  contractVersion: "canonical-dealing-range.v1" as const,
  authority: "canonical_impulse" as const,
  source: "higher_timeframe_parent" as const,
  impulseId: "impulse-1",
  timeframe: "1h",
  high: 110,
  low: 100,
  midpoint: 105,
  direction: "bullish" as const,
  frozenAt: "2026-08-08T10:00:00.000Z",
};
const authority = {
  contractVersion: "ict-entry-zone-authority.v1" as const,
  enforcement: "observe_only" as const,
  selected: null,
  explanation: "fixture",
  ranked: [{
    contractVersion: "ict-entry-zone-authority.v1" as const,
    enforcement: "observe_only" as const,
    id: "ob-1",
    type: "ob" as const,
    direction: "bullish" as const,
    low: 102,
    high: 104,
    timeframe: "1h",
    impulseId: "impulse-1",
    componentIds: ["ob-1"],
    components: ["ob" as const],
    eligible: true,
    score: 8,
    reasons: [],
    validationTrade: null,
  }],
};

Deno.test("backtest lifecycle persists and does not resurrect a terminal impulse", () => {
  let state = discoverBacktestTradeLifecycle({
    state: emptyBacktestTradeLifecycleState(), range, authority,
    mode: "enforce", now: range.frozenAt,
    expiresAt: "2026-08-08T12:00:00.000Z",
    confirmationMethod: "choch", confirmationTimeframe: "5m",
    refinementTimeframe: "1m",
  });
  assertEquals(state.lifecycle?.activeCandidateId, "ob-1");
  state = advanceBacktestTradeLifecycle({
    state,
    candle: { datetime: "2026-08-08T10:15:00.000Z", open: 103, high: 104, low: 101, close: 101 },
    completedCandles: [],
  });
  assertEquals(state.lifecycle?.status, "exhausted");
  state = discoverBacktestTradeLifecycle({
    state, range, authority, mode: "enforce",
    now: "2026-08-08T10:30:00.000Z", expiresAt: "2026-08-08T12:00:00.000Z",
    confirmationMethod: "choch", confirmationTimeframe: "5m", refinementTimeframe: "1m",
  });
  assertEquals(state.lifecycle?.status, "exhausted");
  assertEquals(state.terminalImpulseIds, ["impulse-1"]);
});

Deno.test("wait retracement remains blocked until its frozen plan is ready", () => {
  const state = emptyBacktestTradeLifecycleState();
  state.lifecycle = {
    contractVersion: "impulse-entry-lifecycle.v1", mode: "enforce",
    impulse: { id: "i", direction: "long", timeframe: "1h", rangeLow: 1, rangeHigh: 2, protectedLevel: 1, expiresAt: "2026-08-08T12:00:00.000Z" },
    status: "entered", activeCandidateId: null, candidates: [],
    confirmation: null, revision: 2, lastTransitionReason: "confirmed",
  };
  state.postConfirmationEntry = {
    contractVersion: "post-choch-retracement.v1", state: "awaiting_retracement",
    mode: "wait_retracement", direction: "long", candidateId: null,
    confirmationGeneration: null, confirmation: { type: "close_choch", tier: 1, price: 1.5, candleIndex: 1, candleTime: "2026-08-08T10:00:00.000Z", displacement: 1, significance: "internal", closeBased: true, supportingSignals: [], authority: null },
    zone: { type: "displacement_50", low: 1.2, high: 1.3, midpoint: 1.25 },
    protectedLevel: 1, createdAt: "2026-08-08T10:00:00.000Z", expiresAt: "2026-08-08T11:00:00.000Z", touchedAt: null, resolvedAt: null, reason: "waiting",
  };
  assertEquals(isBacktestTradeLifecycleEntryReady(state), false);
  state.postConfirmationEntry.state = "ready";
  assertEquals(isBacktestTradeLifecycleEntryReady(state), true);
});

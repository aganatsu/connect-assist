import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  advanceBacktestTradeLifecycle,
  discoverBacktestTradeLifecycle,
  emptyBacktestTradeLifecycleState,
  isBacktestTradeLifecycleEntryReady,
  prepareBacktestPostConfirmationEntry,
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

Deno.test("nested child impulse zone can enter the frozen parent range lifecycle", () => {
  const nestedAuthority = structuredClone(authority);
  nestedAuthority.ranked[0].impulseId = "child-impulse-15m";
  nestedAuthority.ranked[0].timeframe = "15m";
  const state = discoverBacktestTradeLifecycle({
    state: emptyBacktestTradeLifecycleState(), range,
    authority: nestedAuthority, mode: "enforce", now: range.frozenAt,
    expiresAt: "2026-08-08T12:00:00.000Z",
    confirmationMethod: "choch", confirmationTimeframe: "5m",
    refinementTimeframe: "1m",
  });
  assertEquals(state.lifecycle?.impulse.id, range.impulseId);
  assertEquals(state.lifecycle?.activeCandidateId, "ob-1");
  assertEquals(state.lifecycle?.candidates[0].timeframe, "15m");
});

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

Deno.test("backtest post-confirmation plan uses the confirming close, not the break level", () => {
  const confirming = {
    datetime: "2026-08-08T10:10:00.000Z", open: 1.1000, high: 1.1040,
    low: 1.0995, close: 1.1035, volume: 100,
  };
  const state: any = {
    contractVersion: "backtest-trade-lifecycle.v1", terminalImpulseIds: [],
    postConfirmationEntry: null,
    lifecycle: {
      status: "entered",
      impulse: { direction: "long" },
      confirmation: { confirmedAt: confirming.datetime },
    },
    lastStep: {
      confirmationPlan: {
        evaluatedAt: confirming.datetime, breakLevel: 1.1010,
        protectedLevel: 1.0985, candidateId: "zone-1", generation: 1,
        displacementQualified: true,
      },
    },
  };
  const result = prepareBacktestPostConfirmationEntry({
    state, completedCandles: [
      { datetime: "2026-08-08T10:00:00.000Z", open: 1.1000, high: 1.1005, low: 1.0990, close: 1.0995, volume: 100 },
      { datetime: "2026-08-08T10:05:00.000Z", open: 1.0995, high: 1.1000, low: 1.0985, close: 1.0990, volume: 100 },
      confirming,
    ],
    mode: "wait_retracement", expiryMinutes: 30,
  });
  assertEquals(result.postConfirmationEntry?.confirmation.price, confirming.close);
  assertEquals((result.postConfirmationEntry?.confirmation.authority as any)?.breakLevel, 1.1010);
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

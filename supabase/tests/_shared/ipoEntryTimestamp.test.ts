/**
 * IPO EXACT ENTRY TIMESTAMP — regression suite.
 *
 * WHAT THIS CAUGHT. `entry_time` held the strategy bar OPEN, not the moment
 * price reached the entry. `openPosition` set `entryTime: intent.barTime`,
 * where `barTime` is `bars[trade.entryIndex].datetime`. A 1h fill at 15:37 was
 * stored and displayed as 15:00, and the BTC 1h position whose bar opened at
 * 14:00 read as a 14:00 entry when price first reached the level around 14:13.
 *
 * Three defects stacked:
 *   1. the 1m tape was fetched ONLY when the OUTCOME was ambiguous
 *      (index.ts `if (plan.provisional)`), so a clean fill never fetched one;
 *   2. with no tape the resolver returns `entryMinute: null` by design, because
 *      it was built to order events, not to timestamp entries;
 *   3. when a minute WAS resolved, the runner kept `o.method` and dropped
 *      `o.entryMinute` on every non-ambiguous path.
 *
 * A PARENT BAR BEGINNING AT 14:00 DOES NOT MEAN ENTRY OCCURRED AT 14:00.
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  firstEntryMinute, minuteReachesEntry, resolveBar,
} from "../../functions/_shared/ipoCausalOrdering.ts";
import {
  entryTimePrecision, stampEntryMinute, stampResultEntry,
  type PaperPosition, type PaperResult,
} from "../../functions/_shared/ipoPaperContract.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const MIN = 60_000;
const H1 = 60 * MIN, M30 = 30 * MIN, H4 = 240 * MIN;

const bar = (datetime: string, o: number, h: number, l: number, c: number): Candle =>
  ({ datetime, open: o, high: h, low: l, close: c, volume: 0 } as Candle);

/**
 * A minute tape for `bar`, where the price dips to `touchLow` at exactly
 * `touchAt` minutes past the bar open and stays clear of it otherwise.
 *
 * `away` is deliberately far from every level so nothing but the touch minute
 * can satisfy a fill predicate — a test that passed because two minutes both
 * qualified would not be testing FIRST.
 */
function tape(
  start: string, count: number, touchAt: number, touchLow: number, away: number,
): Candle[] {
  const t0 = Date.parse(start);
  return Array.from({ length: count }, (_, i) => {
    const dt = new Date(t0 + i * MIN).toISOString();
    return i === touchAt
      ? bar(dt, away, away + 0.001, touchLow, away)
      : bar(dt, away, away + 0.001, away - 0.001, away);
  });
}

const position = (over: Partial<PaperPosition> = {}): PaperPosition => ({
  strategyId: "ipo_cet", strategyVersion: "spec-1.1",
  setupId: "stp_x", intentId: "int_x",
  symbol: "EUR/USD", timeframe: "1h", direction: "long",
  entryTime: "2026-09-27T15:00:00.000Z",
  strategyBarTime: "2026-09-27T15:00:00.000Z",
  entryPrice: 1.1000, targetPrice: 1.1100, s2InvalidationLevel: 1.0950,
  nominalRiskDistance: 0.005, costR: 0.02,
  referenceBalanceAtEntry: 10_000, nominalRiskPct: 1, nominalRiskUsd: 100,
  ipoCandleTime: "2026-09-27T13:00:00.000Z", volatilityBucket: "MID",
  zoneEntryOrdinal: 1, zonePreviousExitTime: null,
  executionMode: "paper", status: "open",
  maeR: 0, mfeR: 0, lastManagedBarTime: "2026-09-27T15:00:00.000Z",
  gapFromBarTime: null, gapToBarTime: null, gapReason: null,
  causalExecutionVersion: "1m-ordering-v1",
  entryMinuteTime: null, entryResolutionMethod: null,
  htfSource: "twelvedata", minuteSource: "twelvedata",
  engineExitOverridden: false, engineExitBarTime: null,
  ambiguity: null, sequenceContaminated: false,
  dailyStructure: null, dailyStructureAlignment: null, dailyStructureAsOf: null,
  ...over,
});

// ─── A. 1H IPO — parent 15:00, actual touch 15:37 ────────────────────────────

Deno.test("A · 1H parent bar 15:00, entry reached at 15:37 → entry_time 15:37", () => {
  const minutes = tape("2026-09-27T15:00:00.000Z", 60, 37, 1.0999, 1.1050);
  const p = stampEntryMinute(position(), minutes, H1);

  assertEquals(p.entryTime, "2026-09-27T15:37:00.000Z");
  assertEquals(p.entryMinuteTime, "2026-09-27T15:37:00.000Z");
  // The parent bar is preserved, not overwritten.
  assertEquals(p.strategyBarTime, "2026-09-27T15:00:00.000Z");
  assertEquals(entryTimePrecision(p), "minute");
});

// ─── B. 30m IPO — parent 08:30, actual touch 08:46 ───────────────────────────

Deno.test("B · 30m parent bar 08:30, entry reached at 08:46 → entry_time 08:46", () => {
  const minutes = tape("2026-09-22T08:30:00.000Z", 30, 16, 1.0999, 1.1050);
  const p = stampEntryMinute(position({
    timeframe: "30min",
    entryTime: "2026-09-22T08:30:00.000Z",
    strategyBarTime: "2026-09-22T08:30:00.000Z",
  }), minutes, M30);

  assertEquals(p.entryTime, "2026-09-22T08:46:00.000Z");
  assertEquals(p.strategyBarTime, "2026-09-22T08:30:00.000Z");
});

// ─── C. 4H IPO — parent 12:00, actual touch 14:13 ────────────────────────────

Deno.test("C · 4H parent bar 12:00, entry reached at 14:13 → entry_time 14:13", () => {
  // 133 minutes past the open — well beyond any 1h boundary, which is the case
  // a "round it to the nearest sub-timeframe" shortcut would get wrong.
  const minutes = tape("2026-09-23T12:00:00.000Z", 240, 133, 1.0999, 1.1050);
  const p = stampEntryMinute(position({
    timeframe: "4h",
    entryTime: "2026-09-23T12:00:00.000Z",
    strategyBarTime: "2026-09-23T12:00:00.000Z",
  }), minutes, H4);

  assertEquals(p.entryTime, "2026-09-23T14:13:00.000Z");
  assertEquals(p.strategyBarTime, "2026-09-23T12:00:00.000Z");
});

// ─── D. entry exactly at the strategy candle open ────────────────────────────

Deno.test("D · entry reached in the bar's first minute → entry_time equals the bar", () => {
  const minutes = tape("2026-09-27T15:00:00.000Z", 60, 0, 1.0999, 1.1050);
  const p = stampEntryMinute(position(), minutes, H1);

  assertEquals(p.entryTime, "2026-09-27T15:00:00.000Z");
  // Equal to the bar, but PROVEN equal — the precision is `minute`, not a
  // legacy fallback that merely happens to print the same string.
  assertEquals(p.entryMinuteTime, "2026-09-27T15:00:00.000Z");
  assertEquals(entryTimePrecision(p), "minute");
});

// ─── E. the trade closes; history keeps the precise entry ────────────────────

Deno.test("E · a closed trade retains the precise entry timestamp", () => {
  const minutes = tape("2026-09-27T15:00:00.000Z", 60, 37, 1.0999, 1.1050);
  const opened = stampEntryMinute(position(), minutes, H1);

  const closed: PaperResult = {
    position: opened,
    exitTime: "2026-09-27T19:00:00.000Z", exitPrice: 1.1100,
    exitReason: "TARGET_2R", realizedR: 1.98, grossR: 2, realizedPnlUsd: 198,
    maeR: 0.3, mfeR: 2, barsHeld: 4, sameBarAmbiguous: false,
    excludedFromStats: false, exclusionReason: null,
    causalExecutionVersion: "1m-ordering-v1",
    entryMinuteTime: opened.entryMinuteTime,
    targetMinuteTime: null, s2CloseBarTime: null, exitResolutionMethod: null,
    htfWouldHaveBooked: null,
    ambiguityKind: null, ambiguityResolution: null, branchOutcomes: null,
    exitTimeAmbiguous: false, altExitTime: null,
    sequenceContaminated: false,
  };

  // Nothing in the close path may round it back to the bar.
  assertEquals(closed.position.entryTime, "2026-09-27T15:37:00.000Z");
  assertEquals(closed.entryMinuteTime, "2026-09-27T15:37:00.000Z");
  assertEquals(closed.position.strategyBarTime, "2026-09-27T15:00:00.000Z");
  // And exit attribution is untouched by any of this.
  assertEquals(closed.exitTime, "2026-09-27T19:00:00.000Z");
  assertEquals(closed.realizedR, 1.98);
});

Deno.test("E2 · stampResultEntry narrows a result whose position was never stamped", () => {
  const minutes = tape("2026-09-27T15:00:00.000Z", 60, 37, 1.0999, 1.1050);
  const r = {
    position: position(), exitTime: "2026-09-27T19:00:00.000Z",
    exitPrice: 1.1100, exitReason: "TARGET_2R", realizedR: 1.98, grossR: 2,
    realizedPnlUsd: 198, maeR: 0.3, mfeR: 2, barsHeld: 4,
    sameBarAmbiguous: false, excludedFromStats: false, exclusionReason: null,
    causalExecutionVersion: "1m-ordering-v1", entryMinuteTime: null,
    targetMinuteTime: null, s2CloseBarTime: null, exitResolutionMethod: null,
    htfWouldHaveBooked: null, ambiguityKind: null, ambiguityResolution: null,
    branchOutcomes: null, exitTimeAmbiguous: false, altExitTime: null,
    sequenceContaminated: false,
  } as PaperResult;

  const s = stampResultEntry(r, minutes, H1);
  assertEquals(s.entryMinuteTime, "2026-09-27T15:37:00.000Z");
  assertEquals(s.position.entryTime, "2026-09-27T15:37:00.000Z");
  // Outcome fields are carried through untouched.
  assertEquals(s.realizedR, r.realizedR);
  assertEquals(s.exitTime, r.exitTime);
  assertEquals(s.maeR, r.maeR);
});

// ─── shorts ──────────────────────────────────────────────────────────────────

Deno.test("a short stamps on the first minute that RALLIES to the entry", () => {
  const t0 = Date.parse("2026-09-27T15:00:00.000Z");
  const minutes = Array.from({ length: 60 }, (_, i) => {
    const dt = new Date(t0 + i * MIN).toISOString();
    // High reaches 1.1001 only at minute 22; everything else stays below.
    return i === 22 ? bar(dt, 1.0950, 1.1001, 1.0949, 1.0950)
                    : bar(dt, 1.0950, 1.0951, 1.0949, 1.0950);
  });
  const p = stampEntryMinute(
    position({ direction: "short", entryPrice: 1.1000 }), minutes, H1);

  assertEquals(p.entryTime, "2026-09-27T15:22:00.000Z");
});

// ─── refusals: a bar open is never promoted to an entry time ─────────────────

Deno.test("no minute reaches the entry → the row is left on the bar, marked legacy", () => {
  // The tape covers the bar but never dips to 1.1000: a feed disagreement.
  const minutes = tape("2026-09-27T15:00:00.000Z", 60, -1, 0, 1.1050);
  const p = stampEntryMinute(position(), minutes, H1);

  assertEquals(p.entryTime, "2026-09-27T15:00:00.000Z");
  assertEquals(p.entryMinuteTime, null);
  assertEquals(entryTimePrecision(p), "strategy_bar");
});

Deno.test("an empty tape leaves the row untouched", () => {
  const p = stampEntryMinute(position(), [], H1);
  assertEquals(p.entryMinuteTime, null);
  assertEquals(entryTimePrecision(p), "strategy_bar");
});

Deno.test("minutes from a DIFFERENT bar cannot stamp this one", () => {
  // Touch at 14:37 — the previous hour. `minutesInBar` must exclude it rather
  // than let a neighbouring bar's touch become this fill's entry time.
  const minutes = tape("2026-09-27T14:00:00.000Z", 60, 37, 1.0999, 1.1050);
  const p = stampEntryMinute(position(), minutes, H1);

  assertEquals(p.entryMinuteTime, null);
});

Deno.test("an already-stamped position is never re-stamped", () => {
  const minutes = tape("2026-09-27T15:00:00.000Z", 60, 37, 1.0999, 1.1050);
  const already = position({
    entryMinuteTime: "2026-09-27T15:12:00.000Z",
    entryTime: "2026-09-27T15:12:00.000Z",
  });
  assertEquals(stampEntryMinute(already, minutes, H1), already);
});

// ─── the fill predicate has exactly ONE definition ───────────────────────────

Deno.test("resolveBar and firstEntryMinute agree on the fill minute", () => {
  // If these ever diverge, a trade's recorded entry time stops describing the
  // fill the engine actually took. `resolveBar` calls `minuteReachesEntry`
  // directly for this reason; the test pins the two together.
  const minutes = tape("2026-09-27T15:00:00.000Z", 60, 37, 1.0999, 1.1050);
  const hour = bar("2026-09-27T15:00:00.000Z", 1.1050, 1.1060, 1.0999, 1.1050);

  const o = resolveBar({
    direction: "long", entryPrice: 1.1000, targetPrice: 1.1100,
    s2InvalidationLevel: 1.0950, bar: hour, barMs: H1,
    isEntryBar: true, minutes, ticks: null, minutesFinal: true,
  });

  const direct = firstEntryMinute(minutes, hour, H1, "long", 1.1000);
  assertEquals(o.entryMinute, "2026-09-27T15:37:00.000Z");
  assertEquals(direct?.datetime, o.entryMinute);
});

Deno.test("minuteReachesEntry is the fill semantics, both directions", () => {
  const m = bar("2026-09-27T15:37:00.000Z", 1.1050, 1.1060, 1.0999, 1.1050);
  assertEquals(minuteReachesEntry(m, "long", 1.1000), true);   // dipped to it
  assertEquals(minuteReachesEntry(m, "long", 1.0990), false);  // never that low
  assertEquals(minuteReachesEntry(m, "short", 1.1055), true);  // rallied to it
  assertEquals(minuteReachesEntry(m, "short", 1.1070), false); // never that high
});

// ─── the resolver's ordering verdict is NOT touched by stamping ──────────────

Deno.test("stamping changes timestamps and nothing else", () => {
  const minutes = tape("2026-09-27T15:00:00.000Z", 60, 37, 1.0999, 1.1050);
  const before = position();
  const after = stampEntryMinute(before, minutes, H1);

  const changed = (Object.keys(after) as Array<keyof PaperPosition>)
    .filter((k) => after[k] !== before[k]);
  assertEquals(changed.sort(), ["entryMinuteTime", "entryTime"]);
});

// ─── UTC / precision ─────────────────────────────────────────────────────────

Deno.test("seconds in the tape survive the stamp", () => {
  // Nothing rounds or truncates on the way through. 1m bars land on :00, but a
  // source that carries seconds must not silently lose them.
  const minutes = [bar("2026-09-27T15:37:30.000Z", 1.1050, 1.1060, 1.0999, 1.1050)];
  const p = stampEntryMinute(position(), minutes, H1);
  assertEquals(p.entryTime, "2026-09-27T15:37:30.000Z");
});

// ─── the stamp window must be chosen by the FRESH fill, not a stale row ──────

Deno.test("a stale unstampable row does not cancel the stamp for a fresh fill", () => {
  // THE BUG THIS CAUGHT, found during deployment. The runner sized its 1m
  // request from the EARLIEST row needing a stamp. Production had two open
  // positions from 2.5 days earlier whose minutes were never recorded; with
  // either of them in the set, `spanMinutes` became ~3600 against a 1500-minute
  // page limit, so the fetch was skipped and the fresh fill — ten minutes old
  // and trivially in reach — silently stayed on its bar timestamp.
  //
  // This mirrors the filter in ipo-paper-runner/index.ts. A row past the reach
  // can never be stamped and so must not set the window.
  const PAGE = 1500;
  const now = Date.parse("2026-09-28T01:40:00.000Z");
  const reach = (PAGE - 5) * 60_000;

  const stale = "2026-09-25T20:00:00.000Z";   // ~2.5 days old, unstampable
  const fresh = "2026-09-28T01:30:00.000Z";   // 10 minutes old

  const candidates = [position({ strategyBarTime: stale }),
                      position({ strategyBarTime: fresh })];
  const needsStamp = candidates.filter(
    (p) => now - Date.parse(p.strategyBarTime) < reach);

  assertEquals(needsStamp.length, 1);
  assertEquals(needsStamp[0].strategyBarTime, fresh);

  // And the window it produces is small enough to actually be requested.
  const earliest = Math.min(...needsStamp.map((p) => Date.parse(p.strategyBarTime)));
  const spanMinutes = Math.ceil((now - earliest) / 60_000) + 5;
  assertEquals(spanMinutes <= PAGE, true);

  // The unfiltered set is exactly what used to blow the limit.
  const bad = Math.ceil((now - Date.parse(stale)) / 60_000) + 5;
  assertEquals(bad > PAGE, true);
});

Deno.test("tape coverage is judged by the EARLIEST minute, not the first element", () => {
  // A newest-first page would make `tape[0]` the LATEST minute, which reads as
  // covering everything and skips a fetch the run actually needed.
  const descending = [
    bar("2026-09-27T15:59:00.000Z", 1.105, 1.106, 1.104, 1.105),
    bar("2026-09-27T15:00:00.000Z", 1.105, 1.106, 1.104, 1.105),
  ];
  const earliest = Date.parse("2026-09-27T15:00:00.000Z");
  const tapeFrom = Math.min(...descending.map((m) => Date.parse(m.datetime)));

  assertEquals(tapeFrom <= earliest, true);
  // The old first-element reading would have been wrong in the other direction
  // on an ascending page; pinning the min makes order irrelevant.
  assertEquals(Date.parse(descending[0].datetime) <= earliest, false);
});

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  runPhase, runTwoStep, ftmoDay, isCEST, CHALLENGE, VERIFICATION,
  type SimTrade, type MarkBar,
} from "../../functions/_shared/ipoFtmoSimulator.ts";

const bar = (time: string, instrument: string, high: number, low: number, close: number): MarkBar =>
  ({ time, instrument, high, low, close });
const trade = (o: Partial<SimTrade> = {}): SimTrade => ({
  instrument: "EUR/USD", openTime: "2025-01-06T10:00:00Z", closeTime: "2025-01-06T12:00:00Z",
  direction: "long", entry: 1.0000, stop: 0.9900, risk: 0.0100, netR: 2, ...o,
});

Deno.test("CE(S)T day boundary — winter is UTC+1, summer UTC+2", () => {
  assertEquals(isCEST(new Date("2025-01-15T12:00:00Z")), false);
  assertEquals(isCEST(new Date("2025-07-15T12:00:00Z")), true);
  // 23:00 UTC in winter is already the next CET day; 22:00 UTC is not.
  assertEquals(ftmoDay("2025-01-15T23:30:00Z"), "2025-01-16");
  assertEquals(ftmoDay("2025-01-15T22:30:00Z"), "2025-01-15");
  // In summer the boundary moves an hour earlier in UTC.
  assertEquals(ftmoDay("2025-07-15T22:30:00Z"), "2025-07-16");
  assertEquals(ftmoDay("2025-07-15T21:30:00Z"), "2025-07-15");
});

Deno.test("DST transitions fall on the last Sunday of March and October", () => {
  assertEquals(isCEST(new Date("2025-03-30T00:30:00Z")), false, "before 01:00 UTC on the last Sunday");
  assertEquals(isCEST(new Date("2025-03-30T01:30:00Z")), true);
  assertEquals(isCEST(new Date("2025-10-26T00:30:00Z")), true);
  assertEquals(isCEST(new Date("2025-10-26T01:30:00Z")), false);
});

Deno.test("a floating drawdown breaches MAX LOSS before the strategy exits", () => {
  // One trade that ends +2R, but travels 12R against first. At $1,000/R that is
  // a $12,000 excursion on a $10,000 floor — FTMO ends it mid-trade.
  const t = trade({ netR: 2, closeTime: "2025-01-06T15:00:00Z" });
  const bars = [
    bar("2025-01-06T10:00:00Z", "EUR/USD", 1.0010, 0.9990, 1.0000),
    bar("2025-01-06T11:00:00Z", "EUR/USD", 1.0010, 0.8800, 0.9950), // -12R low
    bar("2025-01-06T15:00:00Z", "EUR/USD", 1.0300, 1.0200, 1.0200),
  ];
  const r = runPhase(CHALLENGE, [t], bars, 1000, "CONSERVATIVE");
  assertEquals(r.outcome, "FAIL_MAX_LOSS");
  assertEquals(r.breachInstrument, "EUR/USD");
  assert(r.lowestEquity <= 90_000);
});

Deno.test("the same trade survives under OPTIMISTIC ordering — that is the ambiguity", () => {
  const t = trade({ netR: 2, closeTime: "2025-01-06T15:00:00Z" });
  const bars = [
    bar("2025-01-06T10:00:00Z", "EUR/USD", 1.0010, 0.9990, 1.0000),
    bar("2025-01-06T11:00:00Z", "EUR/USD", 1.0010, 0.8800, 0.9950),
    bar("2025-01-06T15:00:00Z", "EUR/USD", 1.0300, 1.0200, 1.0200),
  ];
  const c = runPhase(CHALLENGE, [t], bars, 1000, "CONSERVATIVE");
  const o = runPhase(CHALLENGE, [t], bars, 1000, "OPTIMISTIC");
  assertEquals(c.outcome, "FAIL_MAX_LOSS");
  assert(o.outcome !== "FAIL_MAX_LOSS", "close-marked equity never saw the wick");
  assert(o.ambiguousBars > 0, "the divergence must be counted");
});

Deno.test("daily loss is measured against the balance at the CE(S)T day open", () => {
  // Day 1 books +$6,000. Day 2 may then lose $5,000 from 106,000, not from 100,000.
  const t1 = trade({ netR: 6, openTime: "2025-01-06T10:00:00Z", closeTime: "2025-01-06T11:00:00Z" });
  const t2 = trade({ netR: -4.9, openTime: "2025-01-07T10:00:00Z", closeTime: "2025-01-07T11:00:00Z" });
  const bars = [
    bar("2025-01-06T10:00:00Z", "EUR/USD", 1.0000, 1.0000, 1.0000),
    bar("2025-01-06T11:00:00Z", "EUR/USD", 1.0600, 1.0000, 1.0600),
    bar("2025-01-07T10:00:00Z", "EUR/USD", 1.0000, 1.0000, 1.0000),
    bar("2025-01-07T11:00:00Z", "EUR/USD", 1.0000, 0.9510, 0.9510),
  ];
  const r = runPhase(CHALLENGE, [t1, t2], bars, 1000, "OPTIMISTIC");
  assert(r.outcome !== "FAIL_DAILY_LOSS",
    `a 4.9k loss from a 106k day-open must not breach; got ${r.outcome}`);
  assertEquals(Math.round(r.endingBalance), 101_100);
});

Deno.test("the target does not count while a position is still open", () => {
  const t1 = trade({ netR: 11, openTime: "2025-01-06T10:00:00Z", closeTime: "2025-01-06T11:00:00Z" });
  const t2 = trade({ instrument: "USD/JPY", openTime: "2025-01-06T11:00:00Z",
    closeTime: "2025-01-20T11:00:00Z", entry: 150, stop: 149, risk: 1, netR: 0 });
  const bars: MarkBar[] = [
    bar("2025-01-06T10:00:00Z", "EUR/USD", 1.0000, 1.0000, 1.0000),
    bar("2025-01-06T11:00:00Z", "EUR/USD", 1.1100, 1.0000, 1.1100),
    bar("2025-01-06T11:00:00Z", "USD/JPY", 150, 150, 150),
  ];
  const r = runPhase(CHALLENGE, [t1, t2], bars, 1000, "OPTIMISTIC");
  assert(r.outcome !== "PASS", "target reached but USD/JPY was still open");
});

Deno.test("minimum trading days blocks an otherwise-passing run", () => {
  const t = trade({ netR: 11, openTime: "2025-01-06T10:00:00Z", closeTime: "2025-01-06T11:00:00Z" });
  const bars = [
    bar("2025-01-06T10:00:00Z", "EUR/USD", 1.0000, 1.0000, 1.0000),
    bar("2025-01-06T11:00:00Z", "EUR/USD", 1.1100, 1.0000, 1.1100),
  ];
  const r = runPhase(CHALLENGE, [t], bars, 1000, "OPTIMISTIC");
  assertEquals(r.outcome, "INCOMPLETE_MIN_DAYS");
  assert(r.endingBalance >= CHALLENGE.profitTarget);
  assertEquals(r.tradingDays, 1);
});

Deno.test("one position per instrument — a second is not opened", () => {
  const a = trade({ openTime: "2025-01-06T10:00:00Z", closeTime: "2025-01-06T14:00:00Z", netR: 1 });
  const b = trade({ openTime: "2025-01-06T11:00:00Z", closeTime: "2025-01-06T12:00:00Z", netR: 1 });
  const bars = [
    bar("2025-01-06T10:00:00Z", "EUR/USD", 1.0, 1.0, 1.0),
    bar("2025-01-06T11:00:00Z", "EUR/USD", 1.0, 1.0, 1.0),
    bar("2025-01-06T14:00:00Z", "EUR/USD", 1.0, 1.0, 1.0),
  ];
  const r = runPhase(CHALLENGE, [a, b], bars, 1000, "OPTIMISTIC", 0, true);
  assertEquals(r.statement.filter((l) => l.kind === "OPEN").length, 1);
});

Deno.test("phase 2 never reuses a phase 1 trade", () => {
  const trades: SimTrade[] = [];
  for (let i = 0; i < 40; i++) {
    const d = 6 + Math.floor(i / 2);
    trades.push(trade({ netR: 1, openTime: `2025-01-${String(d).padStart(2,"0")}T10:00:00Z`,
      closeTime: `2025-01-${String(d).padStart(2,"0")}T11:00:00Z` }));
  }
  const bars: MarkBar[] = [];
  for (const t of trades) {
    bars.push(bar(t.openTime, "EUR/USD", 1.0, 1.0, 1.0));
    bars.push(bar(t.closeTime, "EUR/USD", 1.0, 1.0, 1.0));
  }
  const r = runTwoStep(trades, bars, 1000, 1.0, "OPTIMISTIC");
  assertEquals(r.phase1.outcome, "PASS");
  assert(r.phase2 !== null);
  assert(r.phase2!.nextTradeIndex > r.phase1.nextTradeIndex, "phase 2 must consume later trades");
  assertEquals(r.phase1.tradesUsed + r.phase2!.tradesUsed <= trades.length, true);
});

Deno.test("verification resets to 100k and needs only +5%", () => {
  assertEquals(VERIFICATION.startBalance, 100_000);
  assertEquals(VERIFICATION.profitTarget, 105_000);
  assertEquals(CHALLENGE.profitTarget, 110_000);
  assertEquals(VERIFICATION.maxDailyLoss, 5_000);
  assertEquals(VERIFICATION.maxLossFloor, 90_000);
});

Deno.test("the simulator decides nothing about the strategy", async () => {
  const src = await Deno.readTextFile("supabase/functions/_shared/ipoFtmoSimulator.ts");
  const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  assertEquals(imports, [], "the account layer must not import the strategy stack");
  for (const rule of ["ipoLifecycle", "ipoRawBacktest", "ipoLiveEngine", "FVG", "hasFvg",
                      "runLifecycle", "volatility", "simulate("]) {
    assert(!src.includes(rule), `"${rule}" — this layer must not re-derive strategy rules`);
  }
});

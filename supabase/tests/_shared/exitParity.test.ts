import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildStructureInvalidationEvidence,
  computePartialCloseDecision,
} from "../../functions/_shared/exitParity.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

function partialInput(
  overrides: Partial<
    Parameters<typeof computePartialCloseDecision>[0]
  > = {},
) {
  return {
    symbol: "GBP/USD",
    direction: "long" as const,
    entryPrice: 1.25,
    originalSL: 1.248,
    currentPrice: 1.2522,
    favorablePrice: 1.2525,
    positionSize: 1,
    enabled: true,
    alreadyActivated: false,
    partialTPPercent: 50,
    partialTPLevel: 1,
    executionPriceMode: "threshold" as const,
    commissionPerLot: 7,
    ...overrides,
  };
}

function bearishChochCandles(): Candle[] {
  const candles: Candle[] = [];
  const baseTime = new Date("2026-07-01T10:00:00Z").getTime();
  let index = 0;
  const add = (open: number, high: number, low: number, close: number) => {
    candles.push({
      datetime: new Date(baseTime + index++ * 15 * 60 * 1000)
        .toISOString(),
      open,
      high,
      low,
      close,
      volume: 1500,
    });
  };

  for (let i = 0; i < 6; i++) {
    const price = 1.348 + i * 0.0007;
    add(price, price + 0.0008, price - 0.0003, price + 0.0006);
  }
  for (let i = 0; i < 4; i++) {
    const price = 1.3525 - i * 0.0007;
    add(price, price + 0.0003, price - 0.0008, price - 0.0006);
  }
  for (let i = 0; i < 6; i++) {
    const price = 1.35 + i * 0.001;
    add(price, price + 0.0008, price - 0.0003, price + 0.0006);
  }
  for (let i = 0; i < 4; i++) {
    const price = 1.356 - i * 0.0008;
    add(price, price + 0.0003, price - 0.0008, price - 0.0006);
  }
  for (let i = 0; i < 6; i++) {
    const price = 1.353 + i * 0.0012;
    add(price, price + 0.0008, price - 0.0003, price + 0.0006);
  }
  for (let i = 0; i < 4; i++) {
    const price = 1.36 - i * 0.0015;
    add(price, price + 0.0003, price - 0.0015, price - 0.0012);
  }
  add(1.354, 1.3545, 1.348, 1.3485);
  for (let i = 0; i < 4; i++) {
    const price = 1.349 + i * 0.0008;
    add(price, price + 0.0008, price - 0.0003, price + 0.0006);
  }
  add(1.3525, 1.354, 1.352, 1.3535);
  for (let i = 0; i < 4; i++) {
    const price = 1.353 - i * 0.001;
    add(price, price + 0.0003, price - 0.001, price - 0.0008);
  }
  add(1.349, 1.3495, 1.344, 1.3445);
  for (let i = 0; i < 4; i++) {
    const price = 1.345 + i * 0.0005;
    add(price, price + 0.0006, price - 0.0003, price + 0.0004);
  }
  return candles;
}

Deno.test("partial close uses one trigger, lot rounding, and accounting contract", () => {
  const decision = computePartialCloseDecision(partialInput());

  assertEquals(decision.triggered, true);
  assertEquals(decision.contractVersion, "exit-parity.v1");
  assertEquals(decision.triggerPrice, 1.252);
  assertEquals(decision.executionPrice, 1.252);
  assertEquals(decision.closeSize, 0.5);
  assertEquals(decision.remainingSize, 0.5);
  assert(Math.abs(decision.pnlPips - 20) < 0.000001);
  assertEquals(decision.commission, 7);
  assert(Math.abs(decision.netPnl - 93) < 0.000001);
});

Deno.test("live and backtest share sizing while explicitly modeling fill price", () => {
  const backtest = computePartialCloseDecision(partialInput());
  const live = computePartialCloseDecision(
    partialInput({ executionPriceMode: "observed_market" }),
  );

  assertEquals(live.triggered, backtest.triggered);
  assertEquals(live.triggerPrice, backtest.triggerPrice);
  assertEquals(live.closeSize, backtest.closeSize);
  assertEquals(live.remainingSize, backtest.remainingSize);
  assertEquals(backtest.executionPrice, 1.252);
  assertEquals(live.executionPrice, 1.2522);
  assert(live.netPnl > backtest.netPnl);
});

Deno.test("partial close waits below threshold and rejects zero-remainder sizing", () => {
  const waiting = computePartialCloseDecision(
    partialInput({ favorablePrice: 1.251 }),
  );
  const invalidSize = computePartialCloseDecision(
    partialInput({
      positionSize: 0.01,
      partialTPPercent: 50,
      favorablePrice: 1.253,
    }),
  );

  assertEquals(waiting.triggered, false);
  assertEquals(waiting.triggerPrice, 1.252);
  assertEquals(invalidSize.triggered, false);
  assertEquals(
    invalidSize.reason,
    "Partial TP would leave an invalid position size",
  );
});

Deno.test("structure evidence uses the shared 120-candle CHoCH window", () => {
  const evidence = buildStructureInvalidationEvidence({
    direction: "long",
    structureCandles: bearishChochCandles(),
    regimeCandles: [],
  });

  assertEquals(evidence.contractVersion, "exit-parity.v1");
  assertEquals(evidence.structureCandleCount, 45);
  assertEquals(evidence.regime, "unknown");
  assertEquals(evidence.regimeSuppressed, false);
  assertEquals(evidence.trend, "bearish");
  assert(evidence.chochAgainstCount > 0);
  assertEquals(evidence.structureCheck?.trend, "bearish");
});

Deno.test("structure evidence fails open when candles are unavailable", () => {
  const evidence = buildStructureInvalidationEvidence({
    direction: "short",
    structureCandles: bearishChochCandles().slice(0, 10),
  });

  assertEquals(evidence.structureCheck, null);
  assertEquals(evidence.reason, "Insufficient structure candles");
});

Deno.test("structure evidence excludes the still-open daily candle", () => {
  const regimeCandles = Array.from({ length: 21 }, (_, index): Candle => ({
    datetime: new Date(Date.UTC(2026, 6, index + 1)).toISOString(),
    open: 1 + index * 0.001,
    high: 1.002 + index * 0.001,
    low: 0.999 + index * 0.001,
    close: 1.001 + index * 0.001,
    volume: 1000,
  }));
  const evidence = buildStructureInvalidationEvidence({
    direction: "long",
    structureCandles: bearishChochCandles(),
    regimeCandles,
    evaluatedAt: "2026-07-21T13:30:00Z",
  });

  assertEquals(evidence.regimeCandleCount, 20);
});

Deno.test("partial close refuses unsupported-instrument accounting", () => {
  const decision = computePartialCloseDecision(
    partialInput({ symbol: "UNSUPPORTED" }),
  );

  assertEquals(decision.triggered, false);
  assertEquals(decision.reason, "Partial TP P&L is invalid: unsupported_symbol");
  assertEquals(decision.netPnl, 0);
});

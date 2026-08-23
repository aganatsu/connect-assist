import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

const paperTrading = await Deno.readTextFile(
  new URL("../../functions/paper-trading/index.ts", import.meta.url),
);
const botScanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const propFirmGate = await Deno.readTextFile(
  new URL("../../functions/_shared/propFirmGate.ts", import.meta.url),
);
const exitParity = await Deno.readTextFile(
  new URL("../../functions/_shared/exitParity.ts", import.meta.url),
);
const backtestEngine = await Deno.readTextFile(
  new URL("../../functions/backtest-engine/index.ts", import.meta.url),
);

Deno.test("all persistent and simulated PnL callers handle invalid calculations", () => {
  assertEquals(occurrences(paperTrading, "const pnlResult = calcPnl"), 3);
  assertEquals(occurrences(paperTrading, "if (!pnlResult.valid)"), 3);

  assertEquals(occurrences(botScanner, "const pnlResult = calcPnl"), 1);
  assertEquals(occurrences(botScanner, "if (!pnlResult.valid)"), 1);
  assertEquals(occurrences(botScanner, "const oppPnlResult = calcPnl"), 1);
  assertEquals(occurrences(botScanner, "if (!oppPnlResult.valid)"), 1);

  assertEquals(occurrences(propFirmGate, "const pnlResult = calcPnl"), 2);
  assertEquals(occurrences(propFirmGate, "if (!pnlResult.valid)"), 2);

  assertEquals(occurrences(exitParity, "const pnlResult = calcPnl"), 1);
  assertEquals(occurrences(exitParity, "if (!pnlResult.valid)"), 1);

  assertEquals(occurrences(backtestEngine, "const pnlResult = calcPnl"), 2);
  assertEquals(occurrences(backtestEngine, "if (!pnlResult.valid)"), 2);
});

function callArguments(source: string, functionName: string): string[] {
  const calls: string[] = [];
  const marker = `${functionName}(`;
  let searchFrom = 0;
  while (true) {
    const start = source.indexOf(marker, searchFrom);
    if (start < 0) return calls;
    let depth = 1;
    let cursor = start + marker.length;
    for (; cursor < source.length && depth > 0; cursor++) {
      if (source[cursor] === "(") depth++;
      if (source[cursor] === ")") depth--;
    }
    if (depth !== 0) throw new Error(`Unbalanced ${functionName} call`);
    calls.push(source.slice(start + marker.length, cursor - 1));
    searchFrom = cursor;
  }
}

Deno.test("paper PnL calls preserve stored symbols and the live rate map", () => {
  const calls = callArguments(paperTrading, "calcPnl");
  assertEquals(calls.length, 4);
  for (const args of calls) {
    assertEquals(
      /\b(?:pos|p)\.symbol\b/.test(args),
      true,
      "paper P&L must resolve the stored instrument symbol",
    );
    assertEquals(
      args.includes("_rateMap"),
      true,
      "paper P&L must use the request conversion-rate map",
    );
  }
});

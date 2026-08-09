import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeFuturesPositionSize,
  FUTURES_CONTRACTS,
  parseFuturesContractSymbol,
} from "../functions/_shared/futuresContracts.ts";

Deno.test("futures registry derives correct tick economics", () => {
  assertEquals(FUTURES_CONTRACTS.MES.tickValue, 1.25);
  assertEquals(FUTURES_CONTRACTS.MNQ.tickValue, 0.5);
  assertEquals(FUTURES_CONTRACTS.MGC.tickValue, 1);
  assertEquals(FUTURES_CONTRACTS.MCL.tickValue, 1);
  assertEquals(FUTURES_CONTRACTS.M6E.tickValue, 1.25);
});

Deno.test("futures sizing returns integer contracts within risk and account cap", () => {
  const result = computeFuturesPositionSize({
    balance: 50_000, riskPercent: 0.25,
    entryPrice: 20_000, stopLoss: 19_990,
    root: "MNQ", commissionPerContract: 2, maxContracts: 2,
  });
  assertEquals(result.stopTicks, 40);
  assertEquals(result.riskPerContractUSD, 22);
  assertEquals(result.contracts, 2);
  assertEquals(result.totalRiskUSD, 44);
});

Deno.test("futures sizing rejects a risk budget below one contract", () => {
  const result = computeFuturesPositionSize({
    balance: 1_000, riskPercent: 0.1,
    entryPrice: 6_000, stopLoss: 5_990, root: "MES",
  });
  assertEquals(result.contracts, 0);
  assertEquals(result.rejected, true);
});

Deno.test("contract symbols retain root month and year identity", () => {
  assertEquals(parseFuturesContractSymbol("MNQU26"), {
    root: "MNQ", monthCode: "U", month: 9, year: 2026,
  });
  assertEquals(parseFuturesContractSymbol("MESZ6"), {
    root: "MES", monthCode: "Z", month: 12, year: 2026,
  });
  assertEquals(parseFuturesContractSymbol("NAS100"), null);
});

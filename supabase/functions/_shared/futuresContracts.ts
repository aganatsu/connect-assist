export const FUTURES_CONTRACT_AUTHORITY_VERSION = "futures-contract-authority.v1";

export type FuturesRoot = "MES" | "MNQ" | "MGC" | "MCL" | "M6E";

export interface FuturesContractSpec {
  root: FuturesRoot;
  name: string;
  exchange: "CME" | "COMEX" | "NYMEX";
  tickSize: number;
  pointValue: number;
  tickValue: number;
  currency: "USD";
  assetClass: "equity_index" | "metal" | "energy" | "currency";
}

export const FUTURES_CONTRACTS: Record<FuturesRoot, FuturesContractSpec> = {
  MES: { root: "MES", name: "Micro E-mini S&P 500", exchange: "CME", tickSize: 0.25, pointValue: 5, tickValue: 1.25, currency: "USD", assetClass: "equity_index" },
  MNQ: { root: "MNQ", name: "Micro E-mini Nasdaq-100", exchange: "CME", tickSize: 0.25, pointValue: 2, tickValue: 0.5, currency: "USD", assetClass: "equity_index" },
  MGC: { root: "MGC", name: "Micro Gold", exchange: "COMEX", tickSize: 0.1, pointValue: 10, tickValue: 1, currency: "USD", assetClass: "metal" },
  MCL: { root: "MCL", name: "Micro WTI Crude Oil", exchange: "NYMEX", tickSize: 0.01, pointValue: 100, tickValue: 1, currency: "USD", assetClass: "energy" },
  M6E: { root: "M6E", name: "Micro EUR/USD", exchange: "CME", tickSize: 0.0001, pointValue: 12_500, tickValue: 1.25, currency: "USD", assetClass: "currency" },
};

export interface FuturesPositionSizeInput {
  balance: number;
  riskPercent: number;
  entryPrice: number;
  stopLoss: number;
  root: FuturesRoot;
  commissionPerContract?: number;
  maxContracts?: number;
}

export interface FuturesPositionSizeResult {
  contractVersion: typeof FUTURES_CONTRACT_AUTHORITY_VERSION;
  root: FuturesRoot;
  contracts: number;
  stopTicks: number;
  riskBudgetUSD: number;
  riskPerContractUSD: number;
  totalRiskUSD: number;
  rejected: boolean;
  reason: string;
}

export function getFuturesContractSpec(root: string): FuturesContractSpec | null {
  return FUTURES_CONTRACTS[root.toUpperCase() as FuturesRoot] ?? null;
}

export function computeFuturesPositionSize(
  input: FuturesPositionSizeInput,
): FuturesPositionSizeResult {
  const spec = FUTURES_CONTRACTS[input.root];
  const riskBudgetUSD = input.balance * (input.riskPercent / 100);
  const distance = Math.abs(input.entryPrice - input.stopLoss);
  const stopTicks = Math.ceil((distance / spec.tickSize) - 1e-10);
  const commission = Math.max(0, input.commissionPerContract ?? 0);
  const riskPerContractUSD = stopTicks * spec.tickValue + commission;
  const rawContracts = riskPerContractUSD > 0
    ? Math.floor(riskBudgetUSD / riskPerContractUSD)
    : 0;
  const maxContracts = Math.max(0, Math.floor(input.maxContracts ?? Number.MAX_SAFE_INTEGER));
  const contracts = Math.min(rawContracts, maxContracts);
  const rejected = !Number.isFinite(riskBudgetUSD) || riskBudgetUSD <= 0 ||
    !Number.isFinite(distance) || distance <= 0 || contracts < 1;
  return {
    contractVersion: FUTURES_CONTRACT_AUTHORITY_VERSION,
    root: input.root,
    contracts: rejected ? 0 : contracts,
    stopTicks,
    riskBudgetUSD,
    riskPerContractUSD,
    totalRiskUSD: rejected ? 0 : contracts * riskPerContractUSD,
    rejected,
    reason: rejected
      ? "Risk budget cannot support one contract at the requested stop"
      : `${contracts} ${input.root} contract(s), ${stopTicks} ticks of stop risk`,
  };
}

const CONTRACT_MONTHS: Record<string, number> = {
  F: 1, G: 2, H: 3, J: 4, K: 5, M: 6,
  N: 7, Q: 8, U: 9, V: 10, X: 11, Z: 12,
};

export function parseFuturesContractSymbol(symbol: string): {
  root: FuturesRoot; monthCode: string; month: number; year: number;
} | null {
  const match = symbol.trim().toUpperCase().match(/^(MES|MNQ|MGC|MCL|M6E)([FGHJKMNQUVXZ])(\d{1,2})$/);
  if (!match) return null;
  const yearDigits = Number(match[3]);
  const year = match[3].length === 1 ? 2020 + yearDigits : 2000 + yearDigits;
  return { root: match[1] as FuturesRoot, monthCode: match[2], month: CONTRACT_MONTHS[match[2]], year };
}

import { parsePairCurrencies } from "./fotsi.ts";
import {
  getCorrelation,
  getDirectionalCorrelation,
} from "./portfolioCorrelation.ts";
import { SMT_PAIRS } from "./smcAnalysis.ts";

export interface CorrelationPosition {
  symbol: string;
  direction?: string | null;
}

export interface CorrelationGateInput {
  enabled: boolean;
  symbol: string;
  direction: "long" | "short";
  openPositions: CorrelationPosition[];
  maxCorrelation: number;
  maxCorrelatedPositions: number;
}

export interface CorrelationGateResult {
  passed: boolean;
  reason: string;
}

/**
 * Canonical correlation-exposure gate used by both candidate scanning and the
 * final execution authority. It blocks self-cancelling hedges and caps repeated
 * exposure to the same correlated move.
 */
export function checkCorrelationExposure(
  input: CorrelationGateInput,
): CorrelationGateResult {
  if (!input.enabled) {
    return { passed: true, reason: "Correlation filter disabled" };
  }

  const maxCorrelatedPositions = Math.max(
    1,
    Number(input.maxCorrelatedPositions) || 1,
  );
  const threshold = Number(input.maxCorrelation) || 0.8;
  const newPairCurrencies = parsePairCurrencies(input.symbol);
  const smtPair = SMT_PAIRS[input.symbol];
  const hits: Array<{
    detail: string;
    kind: "doubling" | "hedge";
  }> = [];

  for (const position of input.openPositions) {
    if (
      position.symbol === input.symbol ||
      (position.direction !== "long" && position.direction !== "short")
    ) {
      continue;
    }

    const positionDirection = position.direction;
    const rawCorrelation = getCorrelation(input.symbol, position.symbol);
    const effectiveCorrelation = getDirectionalCorrelation(
      { symbol: input.symbol, direction: input.direction },
      { symbol: position.symbol, direction: positionDirection },
    );

    let matched = false;
    if (Math.abs(rawCorrelation) >= threshold) {
      if (effectiveCorrelation >= threshold) {
        hits.push({
          kind: "doubling",
          detail:
            `${position.symbol} ${positionDirection} (raw ρ=${
              rawCorrelation.toFixed(2)
            }, ` +
            `eff=${(effectiveCorrelation * 100).toFixed(0)}%) — doubling`,
        });
        matched = true;
      } else if (effectiveCorrelation <= -threshold) {
        hits.push({
          kind: "hedge",
          detail:
            `${position.symbol} ${positionDirection} (raw ρ=${
              rawCorrelation.toFixed(2)
            }, ` +
            `eff=${(effectiveCorrelation * 100).toFixed(0)}%) — hedge conflict`,
        });
        matched = true;
      }
    }

    if (!matched && smtPair && position.symbol === smtPair) {
      hits.push({
        kind: positionDirection === input.direction ? "doubling" : "hedge",
        detail: `${position.symbol} ${positionDirection} — SMT pair ${
          positionDirection === input.direction ? "doubling" : "hedge"
        }`,
      });
      matched = true;
    }

    if (!matched && newPairCurrencies) {
      const positionCurrencies = parsePairCurrencies(position.symbol);
      if (!positionCurrencies) continue;

      const [newBase, newQuote] = newPairCurrencies;
      const [positionBase, positionQuote] = positionCurrencies;
      const newBuying = input.direction === "long" ? newBase : newQuote;
      const newSelling = input.direction === "long" ? newQuote : newBase;
      const positionBuying = positionDirection === "long"
        ? positionBase
        : positionQuote;
      const positionSelling = positionDirection === "long"
        ? positionQuote
        : positionBase;

      if (
        newBuying === positionSelling &&
        newSelling === positionBuying
      ) {
        hits.push({
          kind: "hedge",
          detail:
            `${position.symbol} ${positionDirection} — perfect currency hedge on ` +
            `${newBuying}/${newSelling}`,
        });
      } else if (
        newBuying === positionBuying &&
        newSelling === positionSelling
      ) {
        hits.push({
          kind: "doubling",
          detail:
            `${position.symbol} ${positionDirection} — identical currency exposure`,
        });
      }
    }
  }

  const hedgeHits = hits.filter((hit) => hit.kind === "hedge");
  if (hedgeHits.length > 0) {
    return {
      passed: false,
      reason:
        `Hedge conflict on correlated pair(s) blocked (threshold ${threshold}): ` +
        hedgeHits.map((hit) => hit.detail).join("; "),
    };
  }

  const doublingHits = hits.filter((hit) => hit.kind === "doubling");
  if (doublingHits.length >= maxCorrelatedPositions) {
    return {
      passed: false,
      reason: `Correlated same-direction cap hit (threshold ${threshold}): ` +
        `${doublingHits.length}/${maxCorrelatedPositions} — ` +
        doublingHits.map((hit) => hit.detail).join("; "),
    };
  }

  if (doublingHits.length > 0) {
    return {
      passed: true,
      reason: `Correlated same-direction positions: ` +
        `${doublingHits.length}/${maxCorrelatedPositions} — ` +
        doublingHits.map((hit) => hit.detail).join("; "),
    };
  }

  return {
    passed: true,
    reason: `No correlated conflicts (threshold ${threshold})`,
  };
}

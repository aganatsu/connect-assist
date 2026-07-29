import { checkDailyLossLimit } from "./gateDailyLossLimit.ts";
import { checkDuplicateDirection } from "./gateDuplicateDirection.ts";
import { checkMaxDrawdown } from "./gateMaxDrawdown.ts";
import { checkMaxPerSymbol } from "./gateMaxPerSymbol.ts";
import { checkMaxPositions } from "./gateMaxPositions.ts";
import { type GamePlanEnforcementMode } from "./gamePlanGate.ts";
import type { SessionGamePlan } from "./gamePlan.ts";
import type { ThesisValidationResult } from "./thesisValidator.ts";
import type { FinalRuntimeGateStates } from "./finalRuntimeGates.ts";
import {
  type DecisionHierarchyResult,
  type DirectionVerdictDecision,
  type EntryConfirmationDecision,
  evaluateDecisionHierarchy,
} from "./decisionContract.ts";

export type TradeDirection = "long" | "short";

export type FinalAuthorizationCode =
  | "account_missing"
  | "bot_stopped"
  | "bot_paused"
  | "kill_switch"
  | "execution_mode"
  | "invalid_price"
  | "invalid_orientation"
  | "price_or_candle_stale"
  | "direction_unavailable"
  | "direction_blocked"
  | "direction_conflict"
  | "game_plan_blocked"
  | "thesis_unavailable"
  | "thesis_invalid"
  | "confirmation_unavailable"
  | "confirmation_blocked"
  | "prop_firm_unavailable"
  | "prop_firm_blocked"
  | "max_positions"
  | "duplicate_direction"
  | "max_per_symbol"
  | "portfolio_heat"
  | "correlation"
  | "cooldown"
  | "news"
  | "session"
  | "daily_loss"
  | "max_drawdown"
  | "spread_unavailable"
  | "spread_too_wide"
  | "risk_reward"
  | "additional_gate"
  | "authorized";

export interface ExecutionAccountState {
  is_running?: boolean | null;
  is_paused?: boolean | null;
  kill_switch_active?: boolean | null;
  execution_mode?: "paper" | "live" | string | null;
  balance?: string | number | null;
  peak_balance?: string | number | null;
  daily_pnl_base?: string | number | null;
  daily_pnl_base_date?: string | null;
  daily_pnl_date?: string | null;
}

export interface PendingTradeCandidate {
  symbol: string;
  direction: TradeDirection;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
}

export interface OpenPositionForAuthorization {
  symbol: string;
  direction?: string | null;
  entry_price?: string | number | null;
  stop_loss?: string | number | null;
  size?: string | number | null;
}

export type DirectionVerdictForAuthorization = DirectionVerdictDecision;

export interface PropFirmAuthorizationState {
  enabled: boolean;
  allowed: boolean;
  reason?: string | null;
}

export interface SpreadAuthorizationState {
  required: boolean;
  available: boolean;
  passed: boolean;
  spreadPips?: number | null;
  maximumPips?: number | null;
}

export interface AdditionalAuthorizationGate {
  passed: boolean;
  reason: string;
}

export interface FinalTradeAuthorizationInput {
  account: ExecutionAccountState | null;
  candidate: PendingTradeCandidate;
  openPositions: OpenPositionForAuthorization[];
  maxOpenPositions: number;
  maxPerSymbol: number;
  allowSameDirectionStacking: boolean;
  maxDailyLoss: number;
  maxDrawdown: number;
  minimumRiskReward: number;
  directionVerdict: DirectionVerdictForAuthorization | null;
  requireDirectionVerdict?: boolean;
  gamePlan: SessionGamePlan | null;
  gamePlanEnabled: boolean;
  gamePlanMode: GamePlanEnforcementMode;
  gamePlanMinimumConfidence: number;
  thesisResult: ThesisValidationResult | null;
  requireThesisValidation: boolean;
  entryConfirmation?: EntryConfirmationDecision | null;
  propFirm: PropFirmAuthorizationState | null;
  requirePropFirmResult?: boolean;
  spread: SpreadAuthorizationState;
  runtimeGates: FinalRuntimeGateStates;
  additionalGates?: AdditionalAuthorizationGate[];
  now?: Date;
}

export interface FinalTradeAuthorizationDecision {
  authorized: boolean;
  code: FinalAuthorizationCode;
  reason: string;
  retryable: boolean;
  checks: AdditionalAuthorizationGate[];
  evaluatedAt: string;
  decisionHierarchy?: DecisionHierarchyResult;
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function deny(
  code: FinalAuthorizationCode,
  reason: string,
  retryable: boolean,
  checks: AdditionalAuthorizationGate[],
  now: Date,
): FinalTradeAuthorizationDecision {
  checks.push({ passed: false, reason });
  return {
    authorized: false,
    code,
    reason,
    retryable,
    checks,
    evaluatedAt: now.toISOString(),
  };
}

/**
 * Final, route-independent authorization for a confirmed trade.
 *
 * This function is deliberately pure. Callers must provide fresh account,
 * position, thesis, Game Plan, Direction Verdict, prop-firm and spread state.
 * The database RPC remains the final atomic guard against stale account state
 * and duplicate fills.
 */
export function evaluateFinalTradeAuthorization(
  input: FinalTradeAuthorizationInput,
): FinalTradeAuthorizationDecision {
  const now = input.now ?? new Date();
  const checks: AdditionalAuthorizationGate[] = [];
  const account = input.account;

  if (!account) {
    return deny(
      "account_missing",
      "Execution account is unavailable",
      true,
      checks,
      now,
    );
  }
  if (account.kill_switch_active === true) {
    return deny("kill_switch", "Kill switch is active", true, checks, now);
  }
  if (account.is_running !== true) {
    return deny("bot_stopped", "Bot is stopped", true, checks, now);
  }
  if (account.is_paused === true) {
    return deny("bot_paused", "Bot is paused", true, checks, now);
  }
  checks.push({
    passed: true,
    reason: "Account is running and execution is enabled",
  });

  const namedRuntimeGates: Array<{
    code: FinalAuthorizationCode;
    gate: AdditionalAuthorizationGate;
  }> = [
    { code: "execution_mode", gate: input.runtimeGates.executionMode },
    {
      code: "price_or_candle_stale",
      gate: input.runtimeGates.freshness,
    },
    { code: "session", gate: input.runtimeGates.session },
    { code: "news", gate: input.runtimeGates.news },
    { code: "cooldown", gate: input.runtimeGates.cooldown },
    { code: "correlation", gate: input.runtimeGates.correlation },
    { code: "portfolio_heat", gate: input.runtimeGates.portfolioHeat },
  ];
  for (const { code, gate } of namedRuntimeGates) {
    if (!gate.passed) {
      return deny(code, gate.reason, true, checks, now);
    }
    checks.push(gate);
  }

  const { candidate } = input;
  const entry = asFiniteNumber(candidate.entryPrice);
  const stop = asFiniteNumber(candidate.stopLoss);
  const target = asFiniteNumber(candidate.takeProfit);
  if (entry <= 0 || stop <= 0 || target <= 0) {
    return deny(
      "invalid_price",
      "Entry, stop-loss and take-profit must be positive finite values",
      false,
      checks,
      now,
    );
  }
  const orientationValid = candidate.direction === "long"
    ? stop < entry && target > entry
    : stop > entry && target < entry;
  if (!orientationValid) {
    return deny(
      "invalid_orientation",
      `SL/TP orientation is invalid for ${candidate.direction}: entry=${entry}, SL=${stop}, TP=${target}`,
      false,
      checks,
      now,
    );
  }
  checks.push({
    passed: true,
    reason: "Entry, stop-loss and take-profit orientation is valid",
  });

  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const rr = risk > 0 ? reward / risk : 0;
  if (rr < input.minimumRiskReward) {
    return deny(
      "risk_reward",
      `Risk/reward ${rr.toFixed(2)} is below ${
        input.minimumRiskReward.toFixed(2)
      }`,
      false,
      checks,
      now,
    );
  }
  checks.push({
    passed: true,
    reason: `Risk/reward ${rr.toFixed(2)} meets minimum`,
  });

  const decisionHierarchy = evaluateDecisionHierarchy({
    symbol: candidate.symbol,
    direction: candidate.direction,
    gamePlan: input.gamePlan,
    gamePlanEnabled: input.gamePlanEnabled,
    gamePlanMode: input.gamePlanMode,
    gamePlanMinimumConfidence: input.gamePlanMinimumConfidence,
    directionVerdict: input.directionVerdict,
    requireDirectionVerdict: input.requireDirectionVerdict !== false,
    thesisResult: input.thesisResult,
    requireThesisValidation: input.requireThesisValidation,
    entryConfirmation: input.entryConfirmation,
  });
  checks.push(...decisionHierarchy.checks.map((check) => ({
    passed: check.passed,
    reason: `${check.layer}: ${check.reason}`,
  })));
  if (!decisionHierarchy.passed) {
    return {
      ...deny(
        decisionHierarchy.code as FinalAuthorizationCode,
        decisionHierarchy.reason,
        decisionHierarchy.retryable,
        checks,
        now,
      ),
      decisionHierarchy,
    };
  }

  if (input.requirePropFirmResult && !input.propFirm) {
    return deny(
      "prop_firm_unavailable",
      "Prop-firm compliance could not be verified",
      true,
      checks,
      now,
    );
  }
  if (input.propFirm?.enabled) {
    if (!input.propFirm.allowed) {
      return deny(
        "prop_firm_blocked",
        input.propFirm.reason || "Prop-firm compliance blocks execution",
        true,
        checks,
        now,
      );
    }
    checks.push({
      passed: true,
      reason: input.propFirm.reason || "Prop-firm compliance passed",
    });
  }

  const maxPositions = checkMaxPositions({
    openPositionCount: input.openPositions.length,
    maxOpenPositions: input.maxOpenPositions,
  });
  if (!maxPositions.passed) {
    return deny("max_positions", maxPositions.reason, true, checks, now);
  }
  checks.push(maxPositions);

  const symbolPositions = input.openPositions.filter((position) =>
    position.symbol === candidate.symbol
  );
  const duplicate = checkDuplicateDirection({
    sameDirectionExists: symbolPositions.some((position) =>
      position.direction === candidate.direction
    ),
    allowSameDirectionStacking: input.allowSameDirectionStacking,
    direction: candidate.direction,
    symbol: candidate.symbol,
  });
  if (!duplicate.passed) {
    return deny("duplicate_direction", duplicate.reason, true, checks, now);
  }
  checks.push(duplicate);

  const perSymbol = checkMaxPerSymbol({
    symbolPositionCount: symbolPositions.length,
    maxPerSymbol: input.maxPerSymbol,
    symbol: candidate.symbol,
  });
  if (!perSymbol.passed) {
    return deny("max_per_symbol", perSymbol.reason, true, checks, now);
  }
  checks.push(perSymbol);

  const balance = asFiniteNumber(account.balance);
  if (input.propFirm?.enabled) {
    // Match the main scanner: an active prop-firm gate already checked these
    // limits against its authoritative equity and stricter rule set.
    checks.push({
      passed: true,
      reason: "Daily loss and drawdown delegated to prop-firm compliance",
    });
  } else {
    const today = now.toISOString().slice(0, 10);
    const baselineDate = account.daily_pnl_base_date ?? account.daily_pnl_date;
    const storedDailyBase = asFiniteNumber(account.daily_pnl_base, balance);
    const actualDailyBase = baselineDate === today ? storedDailyBase : balance;
    const dailyLossPercent = actualDailyBase > 0
      ? ((actualDailyBase - balance) / actualDailyBase) * 100
      : 0;
    const dailyLoss = checkDailyLossLimit({
      dailyLossPercent,
      maxDailyLoss: input.maxDailyLoss,
    });
    if (!dailyLoss.passed) {
      return deny("daily_loss", dailyLoss.reason, true, checks, now);
    }
    checks.push(dailyLoss);

    const drawdown = checkMaxDrawdown({
      balance,
      peakBalance: asFiniteNumber(account.peak_balance, balance),
      maxDrawdown: input.maxDrawdown,
    });
    if (!drawdown.passed) {
      return deny("max_drawdown", drawdown.reason, true, checks, now);
    }
    checks.push(drawdown);
  }

  if (input.spread.required) {
    if (!input.spread.available) {
      return deny(
        "spread_unavailable",
        "Live spread could not be verified",
        true,
        checks,
        now,
      );
    }
    if (!input.spread.passed) {
      return deny(
        "spread_too_wide",
        `Spread ${
          asFiniteNumber(input.spread.spreadPips).toFixed(2)
        } pips exceeds ${
          asFiniteNumber(input.spread.maximumPips).toFixed(2)
        } pips`,
        true,
        checks,
        now,
      );
    }
    checks.push({
      passed: true,
      reason: `Spread ${
        asFiniteNumber(input.spread.spreadPips).toFixed(2)
      } pips is within limit`,
    });
  }

  for (const gate of input.additionalGates ?? []) {
    if (!gate.passed) {
      return deny("additional_gate", gate.reason, true, checks, now);
    }
    checks.push(gate);
  }

  const reason =
    `Authorized ${candidate.symbol} ${candidate.direction} after ${checks.length} final checks`;
  checks.push({ passed: true, reason });
  return {
    authorized: true,
    code: "authorized",
    reason,
    retryable: false,
    checks,
    evaluatedAt: now.toISOString(),
    decisionHierarchy,
  };
}

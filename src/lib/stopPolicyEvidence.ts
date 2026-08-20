import { getAssetType, getPipSize, rawPipsToDisplay } from "@/lib/pipDisplay";

export interface StopPolicyObservation {
  id: string;
  candidate_id: string;
  observed_at: string;
  symbol: string;
  direction: "long" | "short";
  trading_style: string;
  confirmation_timeframe: string;
  entry_price: number;
  current_plan_valid: boolean;
  current_stop_loss: number | null;
  current_take_profit: number | null;
  current_risk_reward: number | null;
  current_take_profit_source: string | null;
  current_plan_reason: string | null;
  shadow_plan_valid: boolean;
  shadow_stop_loss: number | null;
  shadow_take_profit: number | null;
  shadow_risk_reward: number | null;
  shadow_take_profit_source: string | null;
  shadow_plan_reason: string | null;
  execution_floor_source: "spread_proxy" | "broker_snapshot";
  broker_stops_level: number | null;
  broker_digits: number | null;
  tick_size: number | null;
  shadow_measurements: {
    riskCapBreached?: boolean | null;
    reason?: string | null;
  } | null;
}

export interface StopPolicyEvidenceRow extends StopPolicyObservation {
  currentStopDistancePips: number | null;
  shadowStopDistancePips: number | null;
  stopDistanceDeltaPips: number | null;
}

function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function average(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value != null);
  return present.length
    ? present.reduce((sum, value) => sum + value, 0) / present.length
    : null;
}

export function buildStopPolicyEvidenceReport(observations: StopPolicyObservation[]) {
  const rows: StopPolicyEvidenceRow[] = observations.map((observation) => {
    const entry = finite(observation.entry_price);
    const currentStop = finite(observation.current_stop_loss);
    const shadowStop = finite(observation.shadow_stop_loss);
    const pipSize = getPipSize(observation.symbol);
    const displayDistance = (stop: number | null) => entry == null || stop == null
      ? null
      : rawPipsToDisplay(Math.abs(entry - stop) / pipSize, observation.symbol);
    const currentStopDistancePips = displayDistance(currentStop);
    const shadowStopDistancePips = displayDistance(shadowStop);
    return {
      ...observation,
      currentStopDistancePips,
      shadowStopDistancePips,
      stopDistanceDeltaPips:
        currentStopDistancePips == null || shadowStopDistancePips == null
          ? null
          : shadowStopDistancePips - currentStopDistancePips,
    };
  });
  const comparable = rows.filter((row) =>
    row.current_plan_valid && row.shadow_plan_valid &&
    row.currentStopDistancePips != null && row.shadowStopDistancePips != null
  );
  const comparableFx = comparable.filter((row) => getAssetType(row.symbol) === "forex");
  const epsilon = 0.05;
  return {
    summary: {
      total: rows.length,
      currentValid: rows.filter((row) => row.current_plan_valid).length,
      shadowValid: rows.filter((row) => row.shadow_plan_valid).length,
      comparable: comparable.length,
      tighter: comparable.filter((row) => (row.stopDistanceDeltaPips ?? 0) < -epsilon).length,
      wider: comparable.filter((row) => (row.stopDistanceDeltaPips ?? 0) > epsilon).length,
      unchanged: comparable.filter((row) => Math.abs(row.stopDistanceDeltaPips ?? 0) <= epsilon).length,
      capBreaches: rows.filter((row) => row.shadow_measurements?.riskCapBreached === true).length,
      proxySamples: rows.filter((row) => row.execution_floor_source === "spread_proxy").length,
      exactBrokerSamples: rows.filter((row) => row.execution_floor_source === "broker_snapshot").length,
      averageCurrentStopPips: average(comparableFx.map((row) => row.currentStopDistancePips)),
      averageShadowStopPips: average(comparableFx.map((row) => row.shadowStopDistancePips)),
      averageCurrentRiskReward: average(comparable.map((row) => finite(row.current_risk_reward))),
      averageShadowRiskReward: average(comparable.map((row) => finite(row.shadow_risk_reward))),
    },
    rows,
  };
}

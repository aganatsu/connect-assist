export type ZoneStopPolicyMode = "observe" | "enforce_paper" | "enforce_live";
export type StopPolicyRuntimeTarget = "paper" | "live";

export interface ZoneStopPolicyResolution {
  requestedMode: ZoneStopPolicyMode;
  runtimeTarget: StopPolicyRuntimeTarget;
  enforced: boolean;
  reason: string;
}

export interface BrokerStopConstraintSnapshot {
  bid: number;
  ask: number;
  digits: number;
  stopsLevel: number;
  tickSize: number;
}

export function normalizeZoneStopPolicyMode(
  value: unknown,
): ZoneStopPolicyMode {
  return value === "enforce_paper" || value === "enforce_live"
    ? value
    : "observe";
}

export function resolveZoneStopPolicyMode(
  value: unknown,
  runtimeTarget: StopPolicyRuntimeTarget,
): ZoneStopPolicyResolution {
  const requestedMode = normalizeZoneStopPolicyMode(value);
  const enforced = requestedMode === "enforce_live" ||
    (requestedMode === "enforce_paper" && runtimeTarget === "paper");
  return {
    requestedMode,
    runtimeTarget,
    enforced,
    reason: enforced
      ? `Style-aware Zone Setup stop policy enforced on ${runtimeTarget}`
      : requestedMode === "enforce_paper" && runtimeTarget === "live"
      ? "Paper-only stop policy selected; live execution retains the current stop policy"
      : "Stop policy remains observation-only",
  };
}

export function calculateBrokerExecutionFloor(
  snapshots: BrokerStopConstraintSnapshot[],
  spreadSafetyMultiplier = 1.5,
): number | null {
  if (snapshots.length === 0 || !(spreadSafetyMultiplier > 0)) return null;
  const floors = snapshots.map((snapshot) => {
    const bid = Number(snapshot.bid);
    const ask = Number(snapshot.ask);
    const digits = Number(snapshot.digits);
    const stopsLevel = Number(snapshot.stopsLevel);
    const tickSize = Number(snapshot.tickSize);
    if (
      ![bid, ask, digits, stopsLevel, tickSize].every(Number.isFinite) ||
      bid <= 0 || ask < bid || digits < 0 || !Number.isInteger(digits) ||
      stopsLevel < 0 || tickSize <= 0
    ) return null;
    return Math.max(
      (ask - bid) * spreadSafetyMultiplier,
      stopsLevel * Math.pow(10, -digits),
      tickSize,
    );
  });
  return floors.some((floor) => floor === null)
    ? null
    : Math.max(...floors as number[]);
}

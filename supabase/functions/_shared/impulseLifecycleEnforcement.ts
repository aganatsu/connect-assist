export const IMPULSE_LIFECYCLE_ENFORCEMENT_VERSION = "impulse-lifecycle-enforcement.v2";

export interface ImpulseLifecycleCertificate {
  evidence_hash: string;
  status: "collecting" | "eligible" | "rejected";
  reviewed: boolean;
  reviewed_at: string | null;
  replay_count: number;
  resolved_count: number;
  rescued_winners: number;
  added_losses: number;
  minimum_sample_ready: boolean;
  is_current: boolean;
}

export interface ImpulseLifecycleEnforcementResolution {
  contractVersion: typeof IMPULSE_LIFECYCLE_ENFORCEMENT_VERSION;
  requestedMode: "off" | "observe" | "enforce";
  effectiveMode: "off" | "observe" | "enforce";
  allowed: boolean;
  reason: string;
  evidenceHash: string | null;
}

export function resolveImpulseLifecycleEnforcement(
  requested: unknown,
  certificate: ImpulseLifecycleCertificate | null,
): ImpulseLifecycleEnforcementResolution {
  const requestedMode = requested === "off" || requested === "enforce"
    ? requested
    : "observe";
  if (requestedMode !== "enforce") {
    return {
      contractVersion: IMPULSE_LIFECYCLE_ENFORCEMENT_VERSION,
      requestedMode, effectiveMode: requestedMode, allowed: true,
      reason: requestedMode === "off" ? "Lifecycle disabled" : "Observation requested",
      evidenceHash: certificate?.evidence_hash || null,
    };
  }
  return {
    contractVersion: IMPULSE_LIFECYCLE_ENFORCEMENT_VERSION,
    requestedMode,
    effectiveMode: "enforce",
    allowed: true,
    reason: "Lifecycle enforcement requested by saved Bot Config",
    evidenceHash: certificate?.evidence_hash || null,
  };
}

export async function loadImpulseLifecycleCertificate(
  client: any,
  userId: string,
  botId = "smc",
): Promise<ImpulseLifecycleCertificate | null> {
  const { data, error } = await client
    .from("impulse_lifecycle_enforcement_certificates")
    .select("evidence_hash,status,reviewed,reviewed_at,replay_count,resolved_count,rescued_winners,added_losses,minimum_sample_ready,is_current")
    .eq("user_id", userId).eq("bot_id", botId).eq("is_current", true)
    .maybeSingle();
  if (error) throw new Error(`Lifecycle certificate unavailable: ${error.message}`);
  return data || null;
}

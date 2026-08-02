import {
  CROSS_TF_ACTIVATION_FEATURE,
  type CrossTimeframeActivationSnapshot,
} from "./crossTimeframeAuthority.ts";

interface ActivationClient {
  from(table: string): any;
}

async function globalScopeHash(): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("{}"),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function loadCrossTimeframeActivation(
  client: ActivationClient,
  input: { userId: string; botId: string },
): Promise<CrossTimeframeActivationSnapshot | null> {
  try {
    const { data, error } = await client
      .from("strategy_activation_registry")
      .select(
        "authority_stage, runtime_scope, runtime_enforced, revision, evidence_hash, updated_at",
      )
      .eq("user_id", input.userId)
      .eq("bot_id", input.botId)
      .eq("feature_key", CROSS_TF_ACTIVATION_FEATURE)
      .eq("variant_key", "default")
      .eq("activation_scope_hash", await globalScopeHash())
      .maybeSingle();
    if (error || !data) return null;
    return {
      authorityStage: data.authority_stage,
      runtimeScope: data.runtime_scope,
      runtimeEnforced: data.runtime_enforced === true,
      revision: Number.isFinite(Number(data.revision))
        ? Number(data.revision)
        : null,
      evidenceHash: typeof data.evidence_hash === "string"
        ? data.evidence_hash
        : null,
      updatedAt: typeof data.updated_at === "string" ? data.updated_at : null,
    };
  } catch {
    return null;
  }
}

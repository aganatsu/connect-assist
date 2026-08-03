import type { StreamlinedEvidenceCertificate } from "./streamlinedDecisionEnforcement.ts";

export async function loadStreamlinedDecisionCertificate(
  supabase: any,
  userId: string,
): Promise<StreamlinedEvidenceCertificate | null> {
  const { data, error } = await supabase
    .from("streamlined_decision_certificates")
    .select("certified,expires_at,runtime_targets,styles,minimum_comparable,comparable")
    .eq("user_id", userId)
    .eq("certified", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return {
    certified: data.certified === true,
    expiresAt: data.expires_at,
    runtimeTargets: data.runtime_targets || [],
    styles: data.styles || [],
    minimumComparable: data.minimum_comparable || 100,
    comparable: data.comparable || 0,
  };
}

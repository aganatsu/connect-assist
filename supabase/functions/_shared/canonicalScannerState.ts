export const LEGACY_CANONICAL_SCANNER_STATE_VERSION =
  "canonical-scanner-state.v1";
export const CANONICAL_SCANNER_STATE_VERSION = "canonical-scanner-state.v2";

export type CanonicalScannerStage =
  | "context"
  | "discovery"
  | "watching"
  | "at_poi"
  | "awaiting_liquidity"
  | "awaiting_confirmation"
  | "awaiting_retracement"
  | "authorized"
  | "entered"
  | "managing"
  | "closed"
  | "blocked"
  | "invalidated"
  | "expired";

export type ScannerAuthorityRole =
  | "direction"
  | "structure"
  | "entry_zone"
  | "location"
  | "liquidity"
  | "confirmation"
  | "thesis"
  | "safety"
  | "execution";

export interface ScannerAuthorityReference {
  role: ScannerAuthorityRole;
  source: string;
  available: boolean;
  passed: boolean | null;
  evidenceId?: string | null;
  reasonCode?: string | null;
}

export interface CanonicalScannerStateInput {
  evaluatedAt: string;
  identity: { candidateId: string; symbol: string; direction: "long" | "short" | null };
  lifecycle?: { status?: string | null; positionOpen?: boolean; positionClosed?: boolean };
  direction: { available: boolean; allowed: boolean | null; source?: string; evidenceId?: string | null; reasonCode?: string | null };
  structure?: { required: boolean; decision: "allow" | "watch" | "block" | "unavailable"; source?: string; evidenceId?: string | null; reasonCode?: string | null };
  zone: { available: boolean; valid: boolean | null; atPoi: boolean; source?: string; evidenceId?: string | null; reasonCode?: string | null };
  location: { required: boolean; available: boolean; allowed: boolean | null; source?: string; evidenceId?: string | null; reasonCode?: string | null };
  liquidity: { policy: "required" | "supporting" | "not_required"; state: "none" | "unswept" | "swept_rejected" | "swept_absorbed" | "unavailable"; source?: string; evidenceId?: string | null };
  confirmation: { required: boolean; passed: boolean | null; awaitingRetracement?: boolean; source?: string; evidenceId?: string | null; reasonCode?: string | null };
  thesis: { required: boolean; valid: boolean | null; source?: string; evidenceId?: string | null; reasonCode?: string | null };
  safety: { complete: boolean; passed: boolean | null; source?: string; reasonCode?: string | null };
  execution?: { authorized?: boolean | null; entered?: boolean; source?: string; evidenceId?: string | null; reasonCode?: string | null };
}

export interface CanonicalScannerState {
  contractVersion: typeof CANONICAL_SCANNER_STATE_VERSION;
  observationOnly: true;
  affectsAuthorization: false;
  evaluatedAt: string;
  identity: CanonicalScannerStateInput["identity"];
  stage: CanonicalScannerStage;
  reasonCode: string;
  explanation: string;
  authorities: ScannerAuthorityReference[];
}

const terminalStage = (status?: string | null): CanonicalScannerStage | null => {
  if (status === "invalidated") return "invalidated";
  if (status === "expired") return "expired";
  if (status === "closed") return "closed";
  if (status === "filled" || status === "entered") return "entered";
  if (status === "blocked_after_qualification" || status === "blocked") return "blocked";
  return null;
};

const CANONICAL_SCANNER_STAGES = new Set<CanonicalScannerStage>([
  "context", "discovery", "watching", "at_poi", "awaiting_liquidity",
  "awaiting_confirmation", "awaiting_retracement", "authorized", "entered",
  "managing", "closed", "blocked", "invalidated", "expired",
]);

const SCANNER_AUTHORITY_ROLES = new Set<ScannerAuthorityRole>([
  "direction", "structure", "entry_zone", "location", "liquidity",
  "confirmation", "thesis", "safety", "execution",
]);

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any> : {};
}

/** Converts stored v1 `impulse_zone` roles to the neutral v2 role. */
export function normalizeCanonicalScannerState(
  value: unknown,
): CanonicalScannerState | null {
  const state = record(value);
  if (
    state.contractVersion !== CANONICAL_SCANNER_STATE_VERSION &&
    state.contractVersion !== LEGACY_CANONICAL_SCANNER_STATE_VERSION
  ) return null;
  if (!CANONICAL_SCANNER_STAGES.has(state.stage) || !Array.isArray(state.authorities)) {
    return null;
  }
  const authorities = state.authorities.map((authority: unknown) => {
    const item = record(authority);
    const role = item.role === "impulse_zone" ? "entry_zone" : item.role;
    return { ...item, role };
  });
  if (authorities.some((authority) => !SCANNER_AUTHORITY_ROLES.has(authority.role))) {
    return null;
  }
  return {
    ...state,
    contractVersion: CANONICAL_SCANNER_STATE_VERSION,
    observationOnly: true,
    affectsAuthorization: false,
    authorities,
  } as CanonicalScannerState;
}

export function projectCanonicalScannerState(input: CanonicalScannerStateInput): CanonicalScannerState {
  let stage: CanonicalScannerStage = "context";
  let reasonCode = "direction_evidence_pending";
  let explanation = "Waiting for authoritative directional context";
  const terminal = terminalStage(input.lifecycle?.status);

  if (input.lifecycle?.positionClosed) {
    stage = "closed"; reasonCode = "position_closed"; explanation = "Position lifecycle is complete";
  } else if (input.lifecycle?.positionOpen) {
    stage = "managing"; reasonCode = "position_managing"; explanation = "Open position is under trade management";
  } else if (terminal) {
    stage = terminal; reasonCode = `lifecycle_${terminal}`; explanation = `Setup lifecycle is ${terminal}`;
  } else if (!input.direction.available || input.direction.allowed === null) {
    stage = "context";
  } else if (!input.direction.allowed) {
    stage = "blocked"; reasonCode = input.direction.reasonCode || "direction_blocked"; explanation = "Direction authority does not permit this setup";
  } else if (input.structure?.required && input.structure.decision === "block") {
    stage = "blocked"; reasonCode = input.structure.reasonCode || "structure_blocked"; explanation = "Canonical external structure opposes this setup";
  } else if (!input.zone.available) {
    stage = "discovery"; reasonCode = "entry_zone_pending"; explanation = "Direction is available; searching for a qualified entry POI";
  } else if (input.zone.valid === false) {
    stage = "invalidated"; reasonCode = input.zone.reasonCode || "zone_invalid"; explanation = "The frozen entry zone is no longer valid";
  } else if (!input.zone.atPoi) {
    stage = "watching"; reasonCode = "approaching_poi"; explanation = "Qualified setup is preserved while price approaches its active POI";
  } else if (input.structure?.required && input.structure.decision !== "allow") {
    stage = input.structure.reasonCode === "sweep_and_shift_pending" ? "awaiting_liquidity" : "awaiting_confirmation";
    reasonCode = input.structure.reasonCode || "structure_sequence_pending";
    explanation = input.structure.decision === "unavailable" ? "Canonical structure evidence is unavailable" : "Price is at the POI and the frozen liquidity-to-structure sequence is not complete";
  } else if (input.liquidity.policy === "required" && input.liquidity.state !== "swept_rejected") {
    stage = "awaiting_liquidity";
    reasonCode = input.liquidity.state === "swept_absorbed" ? "liquidity_reconfirmation_required" : "qualified_liquidity_sweep_pending";
    explanation = input.liquidity.state === "swept_absorbed" ? "The local liquidity level was absorbed; a fresh trigger is required" : "Price is at the POI and is waiting for the required local liquidity sweep and rejection";
  } else if (input.confirmation.required && input.confirmation.passed !== true) {
    stage = "awaiting_confirmation"; reasonCode = input.confirmation.reasonCode || "confirmation_pending"; explanation = "Price is at the POI; the frozen entry confirmation contract has not passed";
  } else if (input.confirmation.awaitingRetracement) {
    stage = "awaiting_retracement"; reasonCode = "post_confirmation_retracement_pending"; explanation = "Confirmation is locked; waiting for the frozen retracement entry";
  } else if ((input.location.required && (!input.location.available || input.location.allowed !== true)) || (input.thesis.required && input.thesis.valid !== true)) {
    stage = "blocked";
    reasonCode = input.location.required && input.location.allowed !== true ? (input.location.reasonCode || "location_blocked") : (input.thesis.reasonCode || "thesis_blocked");
    explanation = input.location.required && input.location.allowed !== true ? "Canonical impulse-range location does not authorize entry" : "The frozen setup thesis is no longer valid";
  } else if (!input.safety.complete || input.safety.passed !== true) {
    stage = "blocked"; reasonCode = input.safety.reasonCode || "safety_blocked"; explanation = "Final operational safety has not authorized execution";
  } else if (input.execution?.entered) {
    stage = "entered"; reasonCode = "execution_entered"; explanation = "The candidate has entered execution";
  } else if (input.execution?.authorized === true) {
    stage = "authorized"; reasonCode = "entry_authorized"; explanation = "All owned strategy and operational authorities permit entry";
  } else {
    stage = "at_poi"; reasonCode = "poi_active"; explanation = "Price is at the active POI and entry evidence is being evaluated";
  }

  const authorities: ScannerAuthorityReference[] = [
    { role: "direction", source: input.direction.source || "direction_verdict", available: input.direction.available, passed: input.direction.allowed, evidenceId: input.direction.evidenceId, reasonCode: input.direction.reasonCode },
    ...(input.structure ? [{ role: "structure" as const, source: input.structure.source || "canonical_structure", available: input.structure.decision !== "unavailable", passed: input.structure.decision === "allow" ? true : input.structure.decision === "block" ? false : null, evidenceId: input.structure.evidenceId, reasonCode: input.structure.reasonCode }] : []),
    { role: "entry_zone", source: input.zone.source || "entry_zone_authority", available: input.zone.available, passed: input.zone.valid, evidenceId: input.zone.evidenceId, reasonCode: input.zone.reasonCode },
    { role: "location", source: input.location.source || "canonical_impulse_range", available: !input.location.required || input.location.available, passed: input.location.required ? input.location.allowed : true, evidenceId: input.location.evidenceId, reasonCode: input.location.reasonCode },
    { role: "liquidity", source: input.liquidity.source || "zone_liquidity", available: input.liquidity.policy !== "required" || input.liquidity.state !== "unavailable", passed: input.liquidity.policy !== "required" ? true : input.liquidity.state === "swept_rejected", evidenceId: input.liquidity.evidenceId, reasonCode: input.liquidity.state },
    { role: "confirmation", source: input.confirmation.source || "confirmation_contract", available: !input.confirmation.required || input.confirmation.passed !== null, passed: input.confirmation.required ? input.confirmation.passed : true, evidenceId: input.confirmation.evidenceId, reasonCode: input.confirmation.reasonCode },
    { role: "thesis", source: input.thesis.source || "thesis_validation", available: !input.thesis.required || input.thesis.valid !== null, passed: input.thesis.required ? input.thesis.valid : true, evidenceId: input.thesis.evidenceId, reasonCode: input.thesis.reasonCode },
    { role: "safety", source: input.safety.source || "final_authorization", available: input.safety.complete, passed: input.safety.passed, reasonCode: input.safety.reasonCode },
    { role: "execution", source: input.execution?.source || "broker_execution_ledger", available: input.execution?.authorized !== null, passed: input.execution?.authorized ?? null, evidenceId: input.execution?.evidenceId, reasonCode: input.execution?.reasonCode },
  ];

  return { contractVersion: CANONICAL_SCANNER_STATE_VERSION, observationOnly: true, affectsAuthorization: false, evaluatedAt: input.evaluatedAt, identity: input.identity, stage, reasonCode, explanation, authorities };
}

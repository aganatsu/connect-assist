export type PendingOrderDisplayStage =
  | "watching"
  | "confirmation"
  | "retracement"
  | "reconciliation"
  | "history";

interface PendingOrderDisplayInput {
  status: string;
  confirmation_config?: { entryMode?: unknown } | null;
  impulse_entry_lifecycle?: { entryMode?: unknown } | null;
  post_confirmation_entry?: { state?: string | null } | null;
}

export type PendingOrderConfirmationMethod =
  | "choch"
  | "indicators"
  | "choch_and_indicators";

export type PendingOrderPipelineState = "complete" | "active" | "pending";

interface PendingOrderDistanceInput {
  current_price?: unknown;
  entry_price?: unknown;
  entry_zone_low?: unknown;
  entry_zone_high?: unknown;
}

/** Returns quote-price distance to either the exact entry or the outer zone. */
export function pendingOrderDistancePrice(
  order: PendingOrderDistanceInput,
  target: "entry" | "outer_zone" = "entry",
): number | null {
  const current = Number(order.current_price);
  if (!Number.isFinite(current)) return null;
  if (target === "outer_zone") {
    const rawLow = Number(order.entry_zone_low);
    const rawHigh = Number(order.entry_zone_high);
    if (!Number.isFinite(rawLow) || !Number.isFinite(rawHigh)) return null;
    const low = Math.min(rawLow, rawHigh);
    const high = Math.max(rawLow, rawHigh);
    if (current < low) return low - current;
    if (current > high) return current - high;
    return 0;
  }
  const entry = Number(order.entry_price);
  return Number.isFinite(entry) ? Math.abs(current - entry) : null;
}

export interface PendingOrderPostConfirmationPresentation {
  step: {
    label: string;
    detail: string;
    state: PendingOrderPipelineState;
  } | null;
  entryReady: boolean;
}

interface PendingOrderConfirmationInput {
  status?: unknown;
  confirmation_method?: unknown;
  confirmation_config?: {
    afterChochMode?: unknown;
    entryMode?: unknown;
    nestedPoiEntry?: unknown;
  } | null;
  signal_reason?: unknown;
  frozen_strategy_context?: {
    contractVersion?: unknown;
    nestedPoiEntry?: unknown;
  } | null;
  nested_poi_entry?: unknown;
  impulse_entry_lifecycle?: {
    mode?: unknown;
    entryMode?: unknown;
    status?: unknown;
  } | null;
  confirmation_build_diagnostic?: { reasonCode?: unknown } | null;
  pending_authorization_observation?: {
    confirmation?: {
      latest?: {
        sampledAt?: unknown;
        method?: unknown;
        lifecycleMode?: unknown;
        detectorPassed?: unknown;
        lifecyclePassed?: unknown;
        lifecycleGatePassed?: unknown;
      } | null;
    } | null;
    finalAuthorization?: { evaluatedAt?: unknown } | null;
  } | null;
  post_confirmation_entry?: unknown;
  final_authorization?: unknown;
}

export interface PendingOrderConfirmationPresentation {
  method: PendingOrderConfirmationMethod;
  methodSource:
    | "frozen"
    | "legacy_persisted"
    | "runtime_observation"
    | "fallback";
  methodKnown: boolean;
  label: string;
  detail: string;
  complete: boolean;
  frozenAtSetup: boolean;
  structureLifecycleEnforced: boolean;
}

export interface PendingOrderNestedPoiPresentation {
  route: "none" | "observe" | "enforce";
  label: string;
  detail: string;
  complete: boolean;
  entryReady: boolean;
  frozenAtSetup: boolean;
}

/** Presentation-only projection of the persisted pending-order lifecycle. */
export function pendingOrderDisplayStage(
  order: PendingOrderDisplayInput,
): PendingOrderDisplayStage {
  const retracementState = order.post_confirmation_entry?.state;
  const isNestedPoiEntry =
    order.impulse_entry_lifecycle?.entryMode === "nested_poi_market" ||
    order.confirmation_config?.entryMode === "nested_poi_market";
  const isActive = order.status === "pending" || order.status === "awaiting_confirmation";
  if (
    isActive &&
    !isNestedPoiEntry &&
    (retracementState === "awaiting_retracement" || retracementState === "ready")
  ) {
    return "retracement";
  }
  if (order.status === "reconciliation_required") return "reconciliation";
  if (order.status === "awaiting_confirmation") return "confirmation";
  if (order.status === "pending") return "watching";
  return "history";
}

function recordValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object"
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function confirmationMethodValue(
  value: unknown,
): PendingOrderConfirmationMethod | null {
  return value === "choch" ||
      value === "indicators" ||
      value === "choch_and_indicators"
    ? value
    : null;
}

function lifecycleModeValue(
  value: unknown,
): "off" | "observe" | "enforce" | null {
  return value === "off" || value === "observe" || value === "enforce"
    ? value
    : null;
}

function persistedConfirmationMethod(
  order: PendingOrderConfirmationInput,
): PendingOrderConfirmationMethod | null {
  const signalReason = recordValue(order.signal_reason);
  const watchlistLifecycle = recordValue(signalReason.watchlistLifecycle);
  return confirmationMethodValue(order.confirmation_method) ||
    confirmationMethodValue(watchlistLifecycle.confirmationMethod) ||
    confirmationMethodValue(signalReason.confirmationMethod);
}

function nestedPoiTypeLabel(type: unknown): string {
  if (type === "ob") return "Order Block";
  if (type === "fvg") return "FVG";
  if (type === "breaker") return "Active breaker";
  if (type === "support_resistance") return "S/R level";
  if (type === "fib") return "Fib level";
  return "Nested POI";
}

function nestedPoiPlan(
  order: PendingOrderConfirmationInput,
): Record<string, unknown> {
  const frozenContext = recordValue(order.frozen_strategy_context);
  const signalReason = recordValue(order.signal_reason);
  const watchlistLifecycle = recordValue(signalReason.watchlistLifecycle);
  const frozenSources = [
    frozenContext,
    recordValue(signalReason.frozenStrategyContext),
    recordValue(watchlistLifecycle.frozenStrategyContext),
  ];
  for (const context of frozenSources) {
    if (
      context.contractVersion !== "setup-policy-freeze.v1" &&
      context.contractVersion !== "setup-policy-freeze.v2"
    ) continue;
    const plan = recordValue(context.nestedPoiEntry);
    return plan.contractVersion === "nested-poi-entry.v1" ? plan : {};
  }

  // Legacy rows may predate the canonical frozen context. Only those rows may
  // fall back to duplicated persistence fields.
  const sources = [
    order.nested_poi_entry,
    signalReason.nestedPoiEntry,
    order.confirmation_config?.nestedPoiEntry,
  ];
  for (const source of sources) {
    const plan = recordValue(source);
    if (plan.contractVersion === "nested-poi-entry.v1") return plan;
  }
  return {};
}

function nestedPoiGeometryDetail(selected: Record<string, unknown>): string {
  const type = nestedPoiTypeLabel(selected.type);
  const timeframe = typeof selected.timeframe === "string" && selected.timeframe
    ? ` on ${selected.timeframe}`
    : "";
  const low = Number(selected.low);
  const high = Number(selected.high);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return `${type}${timeframe}`;
  if (selected.geometry === "level" || low === high) {
    return `${type} at ${low}${timeframe}`;
  }
  return `${type} ${low} - ${high}${timeframe}`;
}

/** Presentation-only projection of the frozen nested-POI entry route. */
export function pendingOrderNestedPoiPresentation(
  order: PendingOrderConfirmationInput,
): PendingOrderNestedPoiPresentation {
  const plan = nestedPoiPlan(order);
  const selected = recordValue(plan.selected);
  const hasPlan = Object.keys(plan).length > 0;
  const hasSelected = Object.keys(selected).length > 0;
  const lifecycleEntryMode = order.impulse_entry_lifecycle?.entryMode;
  const configuredEntryMode = order.confirmation_config?.entryMode;
  const enforced = lifecycleEntryMode === "nested_poi_market" ||
    configuredEntryMode === "nested_poi_market";
  const observed = !enforced && hasPlan && plan.mode !== "off";

  if (!enforced && !observed) {
    return {
      route: "none",
      label: "Nested POI trigger",
      detail: "Not active for this setup",
      complete: false,
      entryReady: false,
      frozenAtSetup: false,
    };
  }

  if (!hasSelected) {
    return {
      route: enforced ? "enforce" : "observe",
      label: enforced ? "Nested POI trigger" : "Nested POI observation",
      detail: enforced
        ? "Frozen nested trigger unavailable; entry remains blocked"
        : "No contained nested POI was selected; execution is unchanged",
      complete: false,
      entryReady: false,
      frozenAtSetup: hasPlan,
    };
  }

  const trigger = nestedPoiGeometryDetail(selected);
  const complete = enforced && order.impulse_entry_lifecycle?.status === "entered";
  return {
    route: enforced ? "enforce" : "observe",
    label: enforced ? "Nested POI trigger" : "Nested POI observation",
    detail: enforced
      ? complete
        ? `${trigger} touched by a closed candle`
        : `Waiting for a closed candle to touch frozen ${trigger}`
      : `${trigger} recorded only; it does not control entry`,
    complete: enforced ? complete : true,
    entryReady: complete,
    frozenAtSetup: true,
  };
}


/** Presentation-only projection of the frozen detector and structure gates. */
export function pendingOrderConfirmationPresentation(
  order: PendingOrderConfirmationInput,
): PendingOrderConfirmationPresentation {
  const latest = order.pending_authorization_observation?.confirmation?.latest;
  const directMethod = confirmationMethodValue(order.confirmation_method);
  const persistedMethod = persistedConfirmationMethod(order);
  const observedMethod = confirmationMethodValue(latest?.method);
  const method = persistedMethod || observedMethod || "choch";
  const methodSource = directMethod
    ? "frozen"
    : persistedMethod
    ? "legacy_persisted"
    : observedMethod
    ? "runtime_observation"
    : "fallback";
  const methodKnown = methodSource !== "fallback";
  const effectiveLifecycleMode =
    lifecycleModeValue(latest?.lifecycleMode) ||
    lifecycleModeValue(order.impulse_entry_lifecycle?.mode);
  const structureLifecycleEnforced = effectiveLifecycleMode === "enforce";
  const observationMatches =
    latest != null &&
    (!observedMethod || observedMethod === method);
  const detectorPassed = observationMatches &&
      typeof latest?.detectorPassed === "boolean"
    ? latest.detectorPassed
    : null;
  const lifecyclePassed = observationMatches &&
      typeof latest?.lifecyclePassed === "boolean"
    ? latest.lifecyclePassed
    : null;
  const lifecycleGatePassed = observationMatches &&
      typeof latest?.lifecycleGatePassed === "boolean"
    ? latest.lifecycleGatePassed
    : null;

  const postConfirmationEntry = recordValue(order.post_confirmation_entry);
  const finalAuthorization = recordValue(order.final_authorization);
  const hasPostConfirmationEntry =
    Object.keys(postConfirmationEntry).length > 0;
  const hasFinalAuthorization = Object.keys(finalAuthorization).length > 0;
  const latestSampleAt = Date.parse(
    typeof latest?.sampledAt === "string" ? latest.sampledAt : "",
  );
  const observedFinalAt =
    order.pending_authorization_observation?.finalAuthorization?.evaluatedAt;
  const finalEvaluatedAt = Date.parse(
    typeof observedFinalAt === "string"
      ? observedFinalAt
      : typeof finalAuthorization.evaluatedAt === "string"
      ? finalAuthorization.evaluatedAt
      : "",
  );
  const finalAuthorizationSuperseded =
    Number.isFinite(latestSampleAt) &&
    Number.isFinite(finalEvaluatedAt) &&
    latestSampleAt > finalEvaluatedAt;
  const latestAttemptNotReady = observationMatches &&
    (detectorPassed === false || lifecycleGatePassed === false);

  // Confirmation observations precede tier/refinement checks. A retracement
  // plan or a still-current final-authorization attempt is later proof.
  const complete = order.status !== "pending" && (
    hasPostConfirmationEntry ||
    (
      hasFinalAuthorization &&
      !finalAuthorizationSuperseded &&
      !latestAttemptNotReady
    )
  );
  const needsIndicators = method !== "choch";
  const needsStructure = method !== "indicators" ||
    structureLifecycleEnforced;
  const label = !methodKnown
    ? "Confirmation (runtime fallback)"
    : structureLifecycleEnforced
    ? needsIndicators
      ? "MSS / CHoCH + indicators"
      : "Displaced MSS / CHoCH"
    : method === "indicators"
    ? "Indicator consensus"
    : method === "choch_and_indicators"
    ? "MSS / CHoCH, displacement, or reversal + indicators"
    : "MSS / CHoCH, displacement, or reversal";
  const diagnosticValue = order.confirmation_build_diagnostic?.reasonCode;
  const diagnostic = typeof diagnosticValue === "string"
    ? diagnosticValue.replace(/_/g, " ")
    : null;

  let detail: string;
  if (!methodKnown) {
    detail = "This legacy setup uses the current confirmation settings";
  } else if (complete) {
    detail = needsStructure && needsIndicators
      ? "Structure and indicator confirmation recorded"
      : needsIndicators
      ? "Indicator confirmation recorded"
      : "Closed-bar confirmation recorded";
  } else if (
    detectorPassed === true &&
    structureLifecycleEnforced &&
    lifecyclePassed === false
  ) {
    detail = method === "indicators"
      ? "Indicator consensus ready; waiting for protected structure"
      : "Confirmation signal ready; waiting for protected structure";
  } else if (
    detectorPassed === false &&
    structureLifecycleEnforced &&
    lifecyclePassed === true
  ) {
    detail = method === "indicators"
      ? "Protected structure ready; waiting for indicator consensus"
      : method === "choch_and_indicators"
      ? "Protected structure ready; waiting for MSS / CHoCH and indicators"
      : "Protected structure ready; waiting for displaced MSS / CHoCH";
  } else if (
    detectorPassed === true && lifecycleGatePassed === true
  ) {
    detail = "Confirmation gates observed; completing downstream checks";
  } else if (structureLifecycleEnforced) {
    const detectorRequirement = needsIndicators
      ? method === "indicators"
        ? "indicator consensus also required"
        : "MSS / CHoCH and indicator consensus also required"
      : "displaced MSS / CHoCH also required";
    detail = diagnostic
      ? `${diagnostic}; ${detectorRequirement}`
      : needsIndicators
      ? "Building protected structure and indicator consensus"
      : "Building protected structure";
  } else {
    detail = method === "indicators"
      ? "Waiting for indicator consensus"
      : method === "choch_and_indicators"
      ? "Waiting for MSS / CHoCH and indicator consensus"
      : "Waiting for displaced MSS / CHoCH";
  }

  const frozenAfterChochMode =
    order.confirmation_config?.afterChochMode === "confirmation_close" ||
    order.confirmation_config?.afterChochMode === "observe_retracement" ||
    order.confirmation_config?.afterChochMode === "wait_retracement";

  return {
    method,
    methodSource,
    methodKnown,
    label,
    detail,
    complete,
    frozenAtSetup:
      methodSource === "frozen" && frozenAfterChochMode,
    structureLifecycleEnforced,
  };
}

function retracementStepLabel(
  retracement: Record<string, unknown>,
  hasRetracement: boolean,
): string {
  if (!hasRetracement) return "Post-confirmation retracement";
  const zoneType = recordValue(retracement.zone).type;
  if (zoneType === "fvg_ob_overlap") return "FVG + OB retracement";
  if (zoneType === "fvg") return "FVG retracement";
  if (zoneType === "micro_ob") return "Micro OB retracement";
  if (zoneType === "displacement_50") return "50% displacement retracement";
  return "Frozen retracement";
}

/** Presentation-only projection of the frozen post-confirmation entry mode. */
export function pendingOrderPostConfirmationPresentation(
  order: Pick<
    PendingOrderConfirmationInput,
    "confirmation_config" | "post_confirmation_entry" | "final_authorization"
  >,
  confirmationDone: boolean,
): PendingOrderPostConfirmationPresentation {
  const mode = order.confirmation_config?.afterChochMode;
  const modeKnown =
    mode === "confirmation_close" ||
    mode === "observe_retracement" ||
    mode === "wait_retracement";
  const retracement = recordValue(order.post_confirmation_entry);
  const finalAuthorization = recordValue(order.final_authorization);
  const retracementState = typeof retracement.state === "string"
    ? retracement.state
    : null;
  const hasRetracement = Object.keys(retracement).length > 0;
  const hasFinalAuthorization = Object.keys(finalAuthorization).length > 0;
  const requiresRetracement = mode === "wait_retracement";
  const observesRetracement = mode === "observe_retracement";
  const bypassedRetracement =
    confirmationDone &&
    hasFinalAuthorization &&
    !hasRetracement &&
    (requiresRetracement || observesRetracement);

  if (
    !requiresRetracement &&
    !observesRetracement &&
    !hasRetracement &&
    modeKnown
  ) {
    return { step: null, entryReady: confirmationDone };
  }

  const legacyMode = !modeKnown && !hasRetracement;
  const step = {
    label: hasRetracement
      ? retracementStepLabel(retracement, true)
      : observesRetracement
      ? "Retracement observation"
      : requiresRetracement
      ? retracementStepLabel(retracement, false)
      : "Post-confirmation mode",
    detail: legacyMode
      ? "Resolved from current settings for this legacy setup"
      : bypassedRetracement
      ? observesRetracement
        ? "Observation did not block authorization"
        : "Not required by the accepted confirmation"
      : hasRetracement
      ? retracementState?.replace(/_/g, " ") || "Retracement plan active"
      : observesRetracement
      ? "Observation only; does not block entry"
      : "Begins after confirmation",
    state: (
      bypassedRetracement || retracementState === "ready"
        ? "complete"
        : retracementState === "awaiting_retracement"
        ? "active"
        : observesRetracement && confirmationDone
        ? "complete"
        : legacyMode && hasFinalAuthorization
        ? "complete"
        : "pending"
    ) as PendingOrderPipelineState,
  };

  const entryReady = confirmationDone && (
    bypassedRetracement
      ? true
      : requiresRetracement || hasRetracement
      ? retracementState === "ready"
      : modeKnown
      ? true
      : hasFinalAuthorization
  );

  return { step, entryReady };
}

export type ScannerOperation = "scan" | "manage" | "zone_confirmation";
export type ScannerTriggerSource = "cron" | "manual";
export type ScannerRunStatus =
  | "invoked"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export interface ScannerRuntimeRun {
  id: string;
  user_id: string;
  bot_id: string;
  function_name: string;
  operation: ScannerOperation;
  trigger_source: ScannerTriggerSource;
  status: ScannerRunStatus;
  phase: string;
  invoked_at: string;
  scan_started_at?: string | null;
  pair_processing_completed_at?: string | null;
  scan_completed_at?: string | null;
  position_management_completed_at?: string | null;
  heartbeat_at: string;
  expected_pairs?: number | null;
  processed_pairs?: number | null;
  error_code?: string | null;
  error_message?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface BeginScannerOperationInput {
  userId: string;
  botId: string;
  functionName: string;
  operation: ScannerOperation;
  triggerSource: ScannerTriggerSource;
  scanCycleId?: string;
  metadata?: Record<string, unknown>;
}

export interface ScannerOperationHandle {
  runId: string;
  persisted: boolean;
}

export interface ScannerLockHandle {
  token: string;
  acquired: boolean;
}

export type ScannerOperationalAlertType =
  | "scanner_heartbeat_missing"
  | "scan_incomplete"
  | "metaapi_certificate_failure"
  | "metaapi_connection_failure"
  | "candle_source_exhaustion"
  | "stuck_confirmation_order"
  | "authorization_error"
  | "migration_drift";

export interface CandleSourceOperationalIssue {
  code:
    | "metaapi_certificate_failure"
    | "metaapi_connection_failure"
    | "candle_source_exhaustion";
  provider: "metaapi" | "all";
  symbol: string;
  interval: string;
  message: string;
}

const nowIso = () => new Date().toISOString();

export function taskKey(functionName: string, action: string): string {
  if (functionName === "bot-scanner") {
    return `${functionName}:${action === "manage" ? "manage" : "scan"}`;
  }
  if (functionName === "zone-confirmation-scanner") {
    return `${functionName}:zone_confirmation`;
  }
  return `${functionName}:${action}`;
}

export function runTaskKey(
  run: Pick<ScannerRuntimeRun, "function_name" | "operation">,
): string {
  return `${run.function_name}:${run.operation}`;
}

export async function beginScannerOperation(
  supabase: any,
  input: BeginScannerOperationInput,
): Promise<ScannerOperationHandle> {
  const runId = crypto.randomUUID();
  const timestamp = nowIso();
  const { error } = await supabase.from("scanner_operation_runs").insert({
    id: runId,
    user_id: input.userId,
    bot_id: input.botId,
    function_name: input.functionName,
    operation: input.operation,
    trigger_source: input.triggerSource,
    status: "invoked",
    phase: input.triggerSource === "cron" ? "cron_invoked" : "manual_invoked",
    scan_cycle_id: input.scanCycleId ?? null,
    invoked_at: timestamp,
    heartbeat_at: timestamp,
    metadata: input.metadata ?? {},
  });

  if (error) {
    console.warn(
      `[scanner-runtime] Could not persist invocation ${runId}: ${error.message}`,
    );
  }
  return { runId, persisted: !error };
}

export async function markScannerOperation(
  supabase: any,
  runId: string | undefined,
  phase: string,
  updates: Record<string, unknown> = {},
): Promise<void> {
  if (!runId) return;
  const timestamp = nowIso();
  const { error } = await supabase
    .from("scanner_operation_runs")
    .update({
      ...updates,
      phase,
      heartbeat_at: timestamp,
      updated_at: timestamp,
    })
    .eq("id", runId);
  if (error) {
    console.warn(
      `[scanner-runtime] Could not update ${runId}: ${error.message}`,
    );
  }
}

export async function completeScannerOperation(
  supabase: any,
  runId: string | undefined,
  operation: ScannerOperation,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  if (!runId) return;
  const timestamp = nowIso();
  const completionColumn = operation === "manage"
    ? "position_management_completed_at"
    : "scan_completed_at";
  await markScannerOperation(supabase, runId, "completed", {
    status: "completed",
    [completionColumn]: timestamp,
    metadata,
  });
}

export async function skipScannerOperation(
  supabase: any,
  runId: string | undefined,
  reason: string,
): Promise<void> {
  await markScannerOperation(supabase, runId, "skipped", {
    status: "skipped",
    error_code: reason,
  });
}

export async function failScannerOperation(
  supabase: any,
  runId: string | undefined,
  error: unknown,
  errorCode = "runtime_error",
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await markScannerOperation(supabase, runId, "failed", {
    status: "failed",
    error_code: errorCode,
    error_message: message.slice(0, 1000),
  });
}

export async function claimScannerLock(
  supabase: any,
  input: {
    userId: string;
    botId: string;
    runId: string;
    scope?: string;
    leaseSeconds?: number;
  },
): Promise<ScannerLockHandle> {
  const token = crypto.randomUUID();
  const { data, error } = await supabase.rpc("claim_scanner_runtime_lock", {
    p_user_id: input.userId,
    p_bot_id: input.botId,
    p_lock_scope: input.scope ?? "full_scan",
    p_lease_token: token,
    p_run_id: input.runId,
    p_lease_seconds: input.leaseSeconds ?? 180,
  });
  if (error) {
    throw new Error(`Scanner lock authority unavailable: ${error.message}`);
  }
  return { token, acquired: data === true };
}

export async function heartbeatScannerLock(
  supabase: any,
  input: {
    userId: string;
    botId: string;
    token: string;
    scope?: string;
    leaseSeconds?: number;
  },
): Promise<boolean> {
  const { data, error } = await supabase.rpc("heartbeat_scanner_runtime_lock", {
    p_user_id: input.userId,
    p_bot_id: input.botId,
    p_lock_scope: input.scope ?? "full_scan",
    p_lease_token: input.token,
    p_lease_seconds: input.leaseSeconds ?? 180,
  });
  if (error) {
    console.warn(`[scanner-runtime] Lock heartbeat failed: ${error.message}`);
    return false;
  }
  return data === true;
}

export async function releaseScannerLock(
  supabase: any,
  input: {
    userId: string;
    botId: string;
    token: string;
    scope?: string;
  },
): Promise<boolean> {
  const { data, error } = await supabase.rpc("release_scanner_runtime_lock", {
    p_user_id: input.userId,
    p_bot_id: input.botId,
    p_lock_scope: input.scope ?? "full_scan",
    p_lease_token: input.token,
  });
  if (error) {
    console.warn(`[scanner-runtime] Lock release failed: ${error.message}`);
    return false;
  }
  return data === true;
}

export async function upsertScannerAlert(
  supabase: any,
  input: {
    userId: string;
    botId: string;
    alertType: ScannerOperationalAlertType;
    dedupeKey: string;
    severity: "info" | "warning" | "critical";
    title: string;
    message: string;
    runId?: string;
    evidence?: Record<string, unknown>;
  },
): Promise<string | null> {
  const { data, error } = await supabase.rpc(
    "upsert_scanner_operational_alert",
    {
      p_user_id: input.userId,
      p_bot_id: input.botId,
      p_alert_type: input.alertType,
      p_dedupe_key: input.dedupeKey,
      p_severity: input.severity,
      p_title: input.title,
      p_message: input.message,
      p_run_id: input.runId ?? null,
      p_evidence: input.evidence ?? {},
    },
  );
  if (error) {
    console.warn(`[scanner-runtime] Could not persist alert: ${error.message}`);
    return null;
  }
  return typeof data === "string" ? data : null;
}

export async function resolveScannerAlert(
  supabase: any,
  input: {
    userId: string;
    botId: string;
    alertType: ScannerOperationalAlertType;
    dedupeKey: string;
  },
): Promise<void> {
  const { error } = await supabase.rpc(
    "resolve_scanner_operational_alert",
    {
      p_user_id: input.userId,
      p_bot_id: input.botId,
      p_alert_type: input.alertType,
      p_dedupe_key: input.dedupeKey,
    },
  );
  if (error) {
    console.warn(`[scanner-runtime] Could not resolve alert: ${error.message}`);
  }
}

export async function publishCandleSourceAlerts(
  supabase: any,
  input: {
    userId: string;
    botId: string;
    runId?: string;
    issues: CandleSourceOperationalIssue[];
    metaapiAttempted: boolean;
  },
): Promise<void> {
  const issueTypes: CandleSourceOperationalIssue["code"][] = [
    "metaapi_certificate_failure",
    "metaapi_connection_failure",
    "candle_source_exhaustion",
  ];

  for (const issueType of issueTypes) {
    const matching = input.issues.filter((issue) => issue.code === issueType);
    const shouldEvaluate = issueType === "candle_source_exhaustion" ||
      input.metaapiAttempted;
    if (!shouldEvaluate) continue;

    if (matching.length === 0) {
      await resolveScannerAlert(supabase, {
        userId: input.userId,
        botId: input.botId,
        alertType: issueType,
        dedupeKey: issueType === "candle_source_exhaustion"
          ? "all_sources"
          : "metaapi",
      });
      continue;
    }

    const pairs = [...new Set(matching.map((issue) => issue.symbol))];
    const evidence = {
      affected_pairs: pairs,
      affected_requests: matching.length,
      samples: matching.slice(0, 10),
    };
    if (issueType === "metaapi_certificate_failure") {
      await upsertScannerAlert(supabase, {
        userId: input.userId,
        botId: input.botId,
        alertType: issueType,
        dedupeKey: "metaapi",
        severity: "critical",
        title: "MetaAPI certificate failure",
        message:
          `MetaAPI certificate validation failed for ${pairs.length} pair(s).`,
        runId: input.runId,
        evidence,
      });
    } else if (issueType === "metaapi_connection_failure") {
      await upsertScannerAlert(supabase, {
        userId: input.userId,
        botId: input.botId,
        alertType: issueType,
        dedupeKey: "metaapi",
        severity: "warning",
        title: "MetaAPI connection failure",
        message:
          `MetaAPI could not serve ${matching.length} candle request(s); fallbacks may have been used.`,
        runId: input.runId,
        evidence,
      });
    } else {
      await upsertScannerAlert(supabase, {
        userId: input.userId,
        botId: input.botId,
        alertType: issueType,
        dedupeKey: "all_sources",
        severity: "critical",
        title: "All candle sources exhausted",
        message:
          `No candle provider could serve ${matching.length} request(s) across ${pairs.length} pair(s).`,
        runId: input.runId,
        evidence,
      });
    }
  }
}

export async function recordScannerAuthorizationFailure(
  supabase: any,
  functionName: string,
  reason: string,
  requestMetadata: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await supabase.from("scanner_authorization_failures")
    .insert({
      function_name: functionName,
      reason: reason.slice(0, 500),
      request_metadata: requestMetadata,
    });
  if (error) {
    console.warn(
      `[scanner-runtime] Could not record authorization failure: ${error.message}`,
    );
  }
}

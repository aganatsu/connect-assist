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

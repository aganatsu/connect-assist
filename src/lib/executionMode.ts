export type ExecutionMode = "paper" | "live";

export interface ExecutionModeResponse {
  success?: boolean;
  executionMode?: string;
  error?: string;
  fallback?: boolean;
}

/**
 * A mode switch is complete only when the edge function returns the value it
 * read back from the database. Transient fallback objects and ambiguous
 * success responses must never make the UI claim that live execution is on.
 */
export function requirePersistedExecutionMode(
  response: ExecutionModeResponse | null | undefined,
  requestedMode: ExecutionMode,
): ExecutionMode {
  if (response?.fallback) {
    throw new Error(
      response.error ||
        "Execution mode could not be verified. It was not changed.",
    );
  }
  if (!response?.success) {
    throw new Error(response?.error || "Execution mode was not changed.");
  }
  if (response.executionMode !== requestedMode) {
    throw new Error(
      `Execution mode verification failed: requested ${requestedMode}, but the database returned ${
        response.executionMode || "no value"
      }.`,
    );
  }
  return requestedMode;
}

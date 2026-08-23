export type ExecutionMode = "paper" | "live";
export type ExecutionModeState = ExecutionMode | "unknown";

export interface ActiveBrokerConnection {
  id: string;
  is_active?: boolean;
  display_name?: string;
}

export interface FreshTradingTruthReaders {
  readPaperStatus: () => Promise<unknown>;
  listBrokerConnections: () => Promise<readonly ActiveBrokerConnection[]>;
  readBrokerConnectionStatus: (connectionId: string) => Promise<unknown>;
  readBrokerAccount: (connectionId: string) => Promise<unknown>;
  readBrokerOpenTrades: (connectionId: string) => Promise<unknown>;
}

export interface FreshTradingTruthSnapshot {
  mode: ExecutionMode;
  paperStatus: unknown;
  activeConnections: readonly ActiveBrokerConnection[];
  brokerSnapshots: readonly {
    connection: ActiveBrokerConnection;
    connectionStatus: unknown;
    account: unknown;
    openTrades: unknown;
  }[];
}

type ExecutionModePayload = {
  executionMode?: unknown;
  account?: { execution_mode?: unknown };
  state?: unknown;
  fallback?: unknown;
  ok?: unknown;
  error?: unknown;
};

/** Missing, failed, or fallback status is unknown, never implicitly paper. */
export function readExecutionMode(status: unknown): ExecutionModeState {
  if (!status || typeof status !== "object" || Array.isArray(status)) return "unknown";
  const candidate = status as ExecutionModePayload;
  if (
    candidate.state === "unknown" ||
    candidate.state === "unavailable" ||
    candidate.fallback === true ||
    candidate.ok === false ||
    candidate.error
  ) {
    return "unknown";
  }
  const mode = candidate.executionMode ?? candidate.account?.execution_mode;
  return mode === "paper" || mode === "live" ? mode : "unknown";
}

/** Trading mutations require a known account mode and every active live broker to be ready. */
export function canUseTradingControls(
  mode: ExecutionModeState,
  liveBrokerStates: readonly boolean[],
): boolean {
  return mode === "paper" ||
    (mode === "live" && liveBrokerStates.length > 0 && liveBrokerStates.every(Boolean));
}

function isAvailableObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return payload.ok !== false && payload.fallback !== true &&
    payload.state !== "unknown" && payload.state !== "unavailable" &&
    !payload.error;
}

/**
 * Re-read execution truth immediately before a risk-changing mutation.
 * Cached UI query state is presentation only and must not authorize writes.
 */
export async function requireFreshTradingTruth(
  readers: FreshTradingTruthReaders,
  options: { targetMode?: ExecutionMode } = {},
): Promise<FreshTradingTruthSnapshot> {
  const paperStatus = await readers.readPaperStatus();
  const currentMode = readExecutionMode(paperStatus);
  if (currentMode === "unknown") {
    throw new Error(
      "Current account state is unavailable. Refresh before changing trading state.",
    );
  }

  const brokerTruthRequired = currentMode === "live" ||
    options.targetMode === "live";
  if (!brokerTruthRequired) {
    return {
      mode: currentMode,
      paperStatus,
      activeConnections: [],
      brokerSnapshots: [],
    };
  }

  const connections = await readers.listBrokerConnections();
  if (!Array.isArray(connections)) {
    throw new Error(
      "Broker connection state is unavailable. Refresh before changing trading state.",
    );
  }
  const activeConnections = connections.filter((connection) =>
    connection?.is_active === true
  );
  if (activeConnections.length === 0) {
    throw new Error(
      "At least one active broker connection is required for live execution.",
    );
  }

  const brokerSnapshots = await Promise.all(activeConnections.map(async (connection) => {
    const [connectionStatus, account, openTrades] = await Promise.all([
      readers.readBrokerConnectionStatus(connection.id),
      readers.readBrokerAccount(connection.id),
      readers.readBrokerOpenTrades(connection.id),
    ]);
    const ready = isAvailableObject(connectionStatus) &&
      connectionStatus.ready === true &&
      isAvailableObject(account) &&
      Array.isArray(openTrades);
    if (!ready) {
      throw new Error(
        `${connection.display_name || "Broker"} is not ready or its current account state is unavailable.`,
      );
    }
    return { connection, connectionStatus, account, openTrades };
  }));

  if (!canUseTradingControls("live", brokerSnapshots.map(() => true))) {
    throw new Error(
      "Current broker state is unavailable. Refresh before changing trading state.",
    );
  }
  if (
    currentMode === "live" && options.targetMode === "paper" &&
    brokerSnapshots.some((snapshot) =>
      Array.isArray(snapshot.openTrades) && snapshot.openTrades.length > 0
    )
  ) {
    throw new Error(
      "Close all live broker positions before switching execution to paper.",
    );
  }

  return {
    mode: currentMode,
    paperStatus,
    activeConnections,
    brokerSnapshots,
  };
}

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

/**
 * Prefer the edge function's read-after-write result. If an older deployed
 * function omits that field, verify the final database-backed status before
 * deciding whether the switch succeeded.
 */
export async function verifyExecutionModeChange(
  response: ExecutionModeResponse | null | undefined,
  requestedMode: ExecutionMode,
  readPersistedMode: () => Promise<string | undefined>,
): Promise<ExecutionMode> {
  try {
    return requirePersistedExecutionMode(response, requestedMode);
  } catch (responseError) {
    let persistedMode: string | undefined;
    try {
      persistedMode = await readPersistedMode();
    } catch {
      throw responseError;
    }

    if (persistedMode === requestedMode) {
      return requestedMode;
    }
    if (persistedMode) {
      throw new Error(
        `Execution mode verification failed: requested ${requestedMode}, but the database returned ${persistedMode}.`,
      );
    }
    throw responseError;
  }
}

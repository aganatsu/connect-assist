export type RemoteReadFailure = {
  ok?: false;
  fallback?: boolean;
  error?: string;
  state?: "unknown" | "unavailable";
};

function unavailableMessage(value: unknown, label: string): string {
  if (value && typeof value === "object") {
    const error = (value as RemoteReadFailure).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return label + " is unavailable. Refresh and try again.";
}

/**
 * Read-only broker/account calls fail closed. An unavailable payload must not
 * be interpreted as an empty collection, because empty means the broker was
 * reached and positively reported no rows.
 */
export function requireAvailableCollection<T>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) throw new Error(unavailableMessage(value, label));
  return value as T[];
}

/** Distinguish a confirmed object response from a transport fallback. */
export function requireAvailableObject<T extends Record<string, unknown>>(
  value: unknown,
  label: string,
  isComplete?: (candidate: T) => boolean,
): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(unavailableMessage(value, label));
  }
  const failure = value as RemoteReadFailure;
  if (failure.state === "unknown" || failure.state === "unavailable" || failure.fallback === true || failure.ok === false || failure.error) {
    throw new Error(unavailableMessage(value, label));
  }
  const candidate = value as T;
  if (isComplete && !isComplete(candidate)) {
    throw new Error(label + " response is incomplete. Refresh and try again.");
  }
  return candidate;
}

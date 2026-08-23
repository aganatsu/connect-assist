export type BrokerMutationResult = {
  brokerExecutionStatus?: "succeeded" | "rejected" | "uncertain";
  error?: unknown;
  fallback?: boolean;
};

export const BROKER_MUTATION_UNCERTAIN_MESSAGE =
  "Broker execution outcome is unknown. Check broker state before retrying.";

export function requireConfirmedBrokerMutation<T extends BrokerMutationResult>(
  result: T,
): T {
  const failed = result?.fallback === true ||
    result?.brokerExecutionStatus === "rejected" ||
    result?.brokerExecutionStatus === "uncertain" ||
    Boolean(result?.error);
  if (!failed) return result;

  const brokerStatus = result?.brokerExecutionStatus;
  const defaultMessage =
    brokerStatus === "uncertain" || result?.fallback === true
      ? BROKER_MUTATION_UNCERTAIN_MESSAGE
      : "Broker rejected the request.";
  throw new Error(
    typeof result?.error === "string" && result.error.trim()
      ? result.error
      : defaultMessage,
  );
}

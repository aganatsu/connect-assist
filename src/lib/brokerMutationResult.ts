export type BrokerMutationResult = {
  ok?: boolean;
  brokerExecutionStatus?: "succeeded" | "rejected" | "uncertain";
  error?: unknown;
  fallback?: boolean;
};

export const BROKER_MUTATION_UNCERTAIN_MESSAGE =
  "Broker execution outcome is unknown. Check broker state before retrying.";

export function requireConfirmedBrokerMutation<T extends BrokerMutationResult>(
  result: T,
): T {
  const confirmed = result?.ok === true &&
    result?.brokerExecutionStatus === "succeeded" &&
    result?.fallback !== true &&
    !result?.error;
  if (confirmed) return result;

  const brokerStatus = result?.brokerExecutionStatus;
  const defaultMessage =
    brokerStatus !== "rejected" || result?.fallback === true
      ? BROKER_MUTATION_UNCERTAIN_MESSAGE
      : "Broker rejected the request.";
  throw new Error(
    typeof result?.error === "string" && result.error.trim()
      ? result.error
      : defaultMessage,
  );
}

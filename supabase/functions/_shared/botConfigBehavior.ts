/**
 * Pure behavior decisions driven directly by the canonical Bot Config.
 *
 * Keep these decisions small and testable so a visible control cannot be
 * silently overridden inside a scanner route.
 */

export interface PendingZoneOrderDecisionInput {
  pendingZoneOrdersEnabled: boolean;
  useMarketFillAtZone: boolean;
  hasLimitEntry: boolean;
}

export function shouldCreatePendingZoneOrder(
  input: PendingZoneOrderDecisionInput,
): boolean {
  return input.pendingZoneOrdersEnabled &&
    !input.useMarketFillAtZone &&
    input.hasLimitEntry;
}

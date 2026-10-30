// Unified gate decisions, kept pure so the "Require Unified Zone" contract is testable.
//
// 2026-10-28/30: with requireUnifiedZone ON and simplification.unifiedModifiersEnabled
// OFF, a confirmed Unified setup was logged but never counted as passed, so the
// require-unified skip fired on every pair for ~36h. The contract now:
//   - requireUnifiedZone decides WHETHER a pair may trade: only when Unified confirms;
//   - unifiedModifiersEnabled decides WHOSE entry/stop is used (Unified's or Impulse's).
// Neither switch can make the other block everything.

export interface UnifiedZoneLike {
  hasZone?: boolean;
  state?: string;
  confirmation?: { entryReady?: boolean } | null;
}

/** Unified reached triggered/confirmed with an entry-ready confirmation. */
export function isUnifiedConfirmed(u: UnifiedZoneLike | null | undefined): boolean {
  return !!u?.hasZone && (u.state === "triggered" || u.state === "confirmed") && u.confirmation?.entryReady === true;
}

/**
 * Whether the "Require Unified Zone" rule skips the pair. A confirmed Unified
 * setup always satisfies it; with modifiers OFF the pair then continues as a
 * standalone Impulse trade (Impulse gate, entry and stop), as Step 8 intends.
 */
export function requireUnifiedSkips(o: { requireUnifiedZone: boolean; unifiedGatePassed: boolean; unifiedConfirmed: boolean }): boolean {
  return o.requireUnifiedZone && !o.unifiedGatePassed && !o.unifiedConfirmed;
}

/**
 * Resolving the management toggles for a position.
 *
 * These settings live in three places and the UI was reading only the oldest:
 *
 *   trade_overrides            per-position, set from the Trade Override editor
 *   bot config                 the global setting, editable at any time
 *   signal_reason.exitFlags    a SNAPSHOT frozen when the position opened
 *
 * `scannerManagement` resolves override > live > (nothing), and since #490
 * `paper-trading` does the same. The UI did not: it read `exitFlags` alone, so
 * enabling break-even on a live position moved the stop while the BE column
 * still showed "—". Observed 2026-09-08 with NZD/USD sitting at a stop of
 * 0.58805 — its break-even level — and the column reading disabled.
 *
 * Hold time was the exception and already consulted live config, which is why
 * that column was right while the other two were wrong.
 *
 * Precedence here matches the backend: override > live config > snapshot.
 */

export interface ResolvedExitSettings {
  breakEvenEnabled: boolean;
  breakEvenPips: number | undefined;
  breakEvenActivated: boolean;
  trailingStopEnabled: boolean;
  trailingStopPips: number | undefined;
  trailingStopActivated: boolean;
  maxHoldEnabled: boolean;
  maxHoldHours: number | undefined;
  /** Which source supplied breakEvenEnabled — useful in tooltips and tests. */
  breakEvenSource: "override" | "config" | "snapshot" | "default";
}

function parseOverrides(position: any): Record<string, any> {
  const raw = position?.trade_overrides ?? position?.tradeOverrides;
  if (!raw) return {};
  if (typeof raw !== "string") return raw as Record<string, any>;
  try { return JSON.parse(raw); } catch { return {}; }
}

/**
 * BotConfigModal writes these at the TOP LEVEL of config_json; older shapes
 * nest them under `exit`. Read both rather than guess which one an account has.
 */
function liveFlag(config: any, key: string): any {
  return config?.exit?.[key] ?? config?.[key];
}

export function resolveExitSettings(
  position: any,
  exitFlags: Record<string, any> | null | undefined,
  botConfig: any,
): ResolvedExitSettings {
  const ov = parseOverrides(position);
  const ef = exitFlags ?? {};

  const pick = (key: string, legacyKey?: string) => {
    if (ov[key] !== undefined) return { v: ov[key], src: "override" as const };
    const live = liveFlag(botConfig, key);
    if (live !== undefined && live !== null) return { v: live, src: "config" as const };
    if (ef[key] !== undefined) return { v: ef[key], src: "snapshot" as const };
    if (legacyKey && ef[legacyKey] !== undefined) return { v: ef[legacyKey], src: "snapshot" as const };
    return { v: undefined, src: "default" as const };
  };

  const be = pick("breakEvenEnabled", "breakEven");
  const trail = pick("trailingStopEnabled", "trailingStop");
  const hold = pick("maxHoldEnabled");

  return {
    breakEvenEnabled: be.v ?? false,
    breakEvenPips: pick("breakEvenPips").v,
    // Activation is RUNTIME STATE, not a setting — it only ever comes from the
    // position. Reading it from config would show every position as activated.
    breakEvenActivated: ef.breakEvenActivated === true,
    trailingStopEnabled: trail.v ?? false,
    trailingStopPips: pick("trailingStopPips").v,
    trailingStopActivated: ef.trailingStopActivated === true,
    maxHoldEnabled: hold.v !== false && !!pick("maxHoldHours").v,
    maxHoldHours: pick("maxHoldHours").v,
    breakEvenSource: be.src,
  };
}

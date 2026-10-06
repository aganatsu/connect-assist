/**
 * STEP 12 — one owner for the position caps.
 *
 * Before this, five paths each read their own cap with their own fallback:
 *   placement (Gates 4/5)  config.maxOpenPositions / pairConfig.maxPerSymbol (pair-overridable)
 *   hunt fill check        parseInt(config.maxOpenPositions) || 3 / config.maxPerSymbol || 2
 *   scan-stop              parseInt(config.maxOpenPositions) || 3
 *   second poller          raw risk.maxOpenPositions || 3 / raw risk.maxPerSymbol || 2
 *   decision record        config.maxPositionsPerSymbol — a key that never exists (always null)
 * With the live config that meant 7/3 at placement and fill, but 3/2 in the
 * second poller, which made all four historical position-cap cancellations.
 *
 * `simplification.capsMode = "unified"` → every path gets the same two numbers
 * from `simplification.maxOpenPositions` / `simplification.maxPerSymbol`;
 * per-pair maxPerSymbol overrides are ignored. Absent → each path's legacy
 * read, reproduced exactly, so deploying this changes nothing.
 *
 * Same-direction stacking is a separate rule and is not decided here.
 */

export type CapPath = "placement" | "hunt_fill" | "scan_stop" | "second_poller" | "decision_record";

export interface PositionCaps {
  mode: "legacy" | "unified";
  maxOpenPositions: number;
  maxPerSymbol: number;
  /** Where the numbers came from, for logs and decision records. */
  source: string;
}

/** The approved step 12 values; also the fallback for invalid unified values. */
export const UNIFIED_CAP_DEFAULTS = { maxOpenPositions: 3, maxPerSymbol: 1 } as const;

const intIn = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null;

/**
 * @param rawConfigJson the nested config_json — owns capsMode and the unified values.
 * @param path          which enforcement point is asking (selects the legacy read).
 * @param legacy        the flat config that path read before step 12 (the
 *                      pair-overridden copy at placement). Ignored in unified mode.
 */
export function resolvePositionCaps(
  rawConfigJson: Record<string, any> | null | undefined,
  path: CapPath,
  legacy?: { maxOpenPositions?: unknown; maxPerSymbol?: unknown } | null,
): PositionCaps {
  const s = (rawConfigJson?.simplification ?? {}) as Record<string, unknown>;
  if (s.capsMode === "unified") {
    const g = intIn(s.maxOpenPositions, 1, 50);
    const p = intIn(s.maxPerSymbol, 1, 10);
    return {
      mode: "unified",
      maxOpenPositions: g ?? UNIFIED_CAP_DEFAULTS.maxOpenPositions,
      maxPerSymbol: p ?? UNIFIED_CAP_DEFAULTS.maxPerSymbol,
      source: g != null && p != null ? "simplification" : "simplification (invalid value → step 12 default)",
    };
  }

  // Legacy: each path's pre-step-12 expression, unchanged.
  const l = legacy ?? {};
  switch (path) {
    case "placement":
    case "decision_record":
      // Gates 4/5 compared the raw values (pair overrides already applied).
      return { mode: "legacy", maxOpenPositions: Number(l.maxOpenPositions), maxPerSymbol: Number(l.maxPerSymbol), source: "legacy flat config" };
    case "hunt_fill":
      return {
        mode: "legacy",
        maxOpenPositions: parseInt(String(l.maxOpenPositions), 10) || 3,
        maxPerSymbol: Number(l.maxPerSymbol || 2),
        source: "legacy flat config (fallback 3/2)",
      };
    case "scan_stop":
      return {
        mode: "legacy",
        maxOpenPositions: parseInt(String(l.maxOpenPositions), 10) || 3,
        maxPerSymbol: Number(l.maxPerSymbol || 2),
        source: "legacy flat config (fallback 3)",
      };
    case "second_poller": {
      const r = rawConfigJson ?? {};
      return {
        mode: "legacy",
        maxOpenPositions: parseInt(String(r.risk?.maxOpenPositions || r.maxOpenPositions || 3), 10),
        maxPerSymbol: Number(r.risk?.maxPerSymbol || r.maxPerSymbol || 2),
        source: "legacy raw risk.* (fallback 3/2)",
      };
    }
  }
}

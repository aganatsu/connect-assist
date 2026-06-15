/**
 * pipDisplay.ts — Universal pip/point display formatter
 * ─────────────────────────────────────────────────────
 * Converts raw pip values (as stored in the DB) into human-readable
 * display values with appropriate labels for each asset class.
 *
 * Problem: The outcome-tracker stores MFE/MAE as raw price movement / pipSize.
 * For ETH/USD with pipSize=0.01, a $5.55 move = 555 "pips" — technically correct
 * but confusing to read. For crypto and commodities, showing dollar amounts is
 * more intuitive. For indices, showing points is standard.
 *
 * This utility normalizes display across all asset types.
 */

import { INSTRUMENTS, type Instrument } from "./marketData";

// ── Display configuration per asset type ──

interface DisplayConfig {
  /** What to call the unit in the UI */
  label: string;
  /** How many decimal places to show */
  decimals: number;
  /** Multiplier to convert from raw pips to display units.
   *  For forex: 1 (pips are already in standard pip units)
   *  For crypto: pipSize (convert back to dollar amount)
   *  For indices: pipSize (convert back to points)
   *  For commodities: pipSize (convert back to dollar amount)
   */
  multiplier: number;
}

/**
 * Get the display configuration for a given symbol.
 * Returns the appropriate label, decimals, and multiplier.
 */
export function getDisplayConfig(symbol: string): DisplayConfig {
  const inst = INSTRUMENTS.find(i => i.symbol === symbol);
  if (!inst) {
    // Fallback: assume forex-like
    return { label: "pips", decimals: 1, multiplier: 1 };
  }

  switch (inst.type) {
    case "forex":
      return { label: "pips", decimals: 1, multiplier: 1 };
    case "crypto":
    case "index":
    case "commodity":
      // Always display as raw pips for consistency
      return { label: "pips", decimals: 1, multiplier: 1 };
    default:
      return { label: "pips", decimals: 1, multiplier: 1 };
  }
}

/**
 * Format a raw pip value for display.
 * @param rawPips - The raw pip value from the database
 * @param symbol - The trading symbol (e.g., "ETH/USD")
 * @param options - Formatting options
 * @returns Formatted string like "+45.3 pips" or "+$5.55" or "+12.5 pts"
 */
export function formatPipDisplay(
  rawPips: number | null | undefined,
  symbol: string,
  options: {
    showSign?: boolean;    // Show +/- prefix (default: true)
    showLabel?: boolean;   // Show unit label (default: true)
    absolute?: boolean;    // Show absolute value (default: false)
  } = {}
): string {
  const { showSign = true, showLabel = true, absolute = false } = options;

  if (rawPips === null || rawPips === undefined) return "—";

  const config = getDisplayConfig(symbol);
  let displayValue = rawPips * config.multiplier;

  if (absolute) displayValue = Math.abs(displayValue);

  const formatted = displayValue.toFixed(config.decimals);

  let result = "";

  // For $ prefix labels, put the label before the number
  if (config.label === "$") {
    const sign = showSign ? (displayValue >= 0 ? "+" : "") : (displayValue < 0 ? "-" : "");
    const absFormatted = Math.abs(displayValue).toFixed(config.decimals);
    result = `${sign}$${absFormatted}`;
  } else {
    // For suffix labels (pips, pts), put sign before number and label after
    const sign = showSign ? (displayValue >= 0 ? "+" : "") : "";
    result = `${sign}${formatted}`;
    if (showLabel) result += ` ${config.label}`;
  }

  return result;
}

/**
 * Get just the unit label for a symbol (for column headers, tooltips, etc.)
 * @returns "pips" | "$" | "pts"
 */
export function getPipLabel(symbol: string): string {
  return getDisplayConfig(symbol).label;
}

/**
 * Convert raw pips to display value (numeric, for charts/calculations)
 */
export function rawPipsToDisplay(rawPips: number, symbol: string): number {
  const config = getDisplayConfig(symbol);
  return rawPips * config.multiplier;
}

/**
 * Get the pip size for a symbol (convenience re-export)
 */
export function getPipSize(symbol: string): number {
  const inst = INSTRUMENTS.find(i => i.symbol === symbol);
  return inst?.pipSize ?? 0.0001;
}

/**
 * Get the asset type for a symbol
 */
export function getAssetType(symbol: string): Instrument["type"] | "unknown" {
  const inst = INSTRUMENTS.find(i => i.symbol === symbol);
  return inst?.type ?? "unknown";
}

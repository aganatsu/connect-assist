/**
 * Broker Symbol Resolution — Single Source of Truth
 *
 * Resolves a trading pair name (e.g. "EUR/USD") to the broker-specific symbol
 * by checking user-configured overrides first, then applying the connection's
 * symbol_suffix (e.g. ".pro", "m", etc.).
 *
 * Previously duplicated in bot-scanner, broker-execute, and zone-confirmation-scanner.
 */

import { normalizeSymKey } from "./smcAnalysis.ts";

/**
 * Resolve a trading pair to its broker-specific symbol.
 *
 * Resolution order:
 *   1. Check conn.symbol_overrides (normalized key comparison)
 *   2. Strip whitespace/slashes, uppercase, append conn.symbol_suffix
 *
 * @param symbol - The canonical pair name (e.g. "EUR/USD", "XAUUSD")
 * @param conn   - Broker connection object with optional symbol_overrides and symbol_suffix
 * @returns The broker-specific symbol string
 */
export function resolveSymbol(symbol: string, conn: { symbol_overrides?: Record<string, string>; symbol_suffix?: string }): string {
  const rawOverrides = conn.symbol_overrides || {};
  const norm = normalizeSymKey(symbol);
  for (const [k, v] of Object.entries(rawOverrides)) {
    if (normalizeSymKey(k) === norm && v) return String(v);
  }
  const base = symbol.trim().replace(/\s+/g, "").replace("/", "").toUpperCase();
  return base + (conn.symbol_suffix || "");
}

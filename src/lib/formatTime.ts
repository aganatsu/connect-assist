/**
 * Consistent date/time formatting across the app.
 * Format: "04/17, 02:05:23 PM"
 */

/**
 * Full date + time: "04/17, 02:05:23 PM"
 * Used in tables that show historical events (Close Audit, Broker Log, trade history)
 */
export function formatBrokerTime(dateStr: string | Date): string {
  const d = typeof dateStr === "string" ? new Date(dateStr) : dateStr;
  if (isNaN(d.getTime())) return "—";
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  let hours = d.getHours();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  const hh = String(hours).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${month}/${day}, ${hh}:${mm}:${ss} ${ampm}`;
}

/**
 * Time only: "02:05:23 PM"
 * Used in scan log lines where date context is already clear
 */
export function formatTimeOnly(dateStr: string | Date): string {
  const d = typeof dateStr === "string" ? new Date(dateStr) : dateStr;
  if (isNaN(d.getTime())) return "—";
  let hours = d.getHours();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  const hh = String(hours).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss} ${ampm}`;
}

/**
 * Full date + time for expanded details: "04/17/2026, 02:05:23 PM"
 */
export function formatFullDateTime(dateStr: string | Date): string {
  const d = typeof dateStr === "string" ? new Date(dateStr) : dateStr;
  if (isNaN(d.getTime())) return "—";
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const year = d.getFullYear();
  let hours = d.getHours();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  const hh = String(hours).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${month}/${day}/${year}, ${hh}:${mm}:${ss} ${ampm}`;
}

/* ─── Price / Percentage formatters ──────────────────────────────────────
 * Centralized so every page formats numbers the same way.
 * Respects instrument digit conventions:
 *   - JPY pairs → 3 digits
 *   - Indices / BTC / large-value → 2 digits
 *   - Forex / commodities default → 5 digits
 * Accepts either an instrument object (with `symbol` and `pipSize`) or a
 * bare symbol string; falls back to a safe default when neither is provided.
 */

type InstrumentLike =
  | { symbol?: string; pipSize?: number; type?: string }
  | string
  | null
  | undefined;

function resolveDigits(instrument: InstrumentLike, fallback = 5): number {
  if (!instrument) return fallback;
  if (typeof instrument === "string") {
    const sym = instrument.toUpperCase();
    if (sym.includes("JPY")) return 3;
    if (/(US30|NAS100|SPX500|BTC|ETH|OIL|XAU)/.test(sym)) return 2;
    return 5;
  }
  const sym = (instrument.symbol || "").toUpperCase();
  if (sym.includes("JPY")) return 3;
  if (instrument.type === "index" || instrument.type === "crypto") return 2;
  if (sym.includes("XAU") || sym.includes("OIL")) return 2;
  if (typeof instrument.pipSize === "number") {
    // Derive digits from pip size (0.0001 → 5, 0.01 → 3, 1 → 2)
    if (instrument.pipSize >= 1) return 2;
    if (instrument.pipSize >= 0.01) return 3;
    return 5;
  }
  return fallback;
}

/**
 * Format a price using the correct number of decimals for the instrument.
 * Returns "—" when value is not a finite number.
 */
export function formatPrice(
  value: unknown,
  instrument?: InstrumentLike,
  digitsOverride?: number,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const digits = digitsOverride ?? resolveDigits(instrument);
  return value.toFixed(digits);
}

/**
 * Format a percentage. Accepts either a fraction (0.42 → "42.0%") when
 * `fromFraction` is true, or an already-scaled value (42 → "42.0%").
 * Returns "—" when value is not finite.
 */
export function formatPct(
  value: unknown,
  digits = 1,
  opts: { fromFraction?: boolean; sign?: boolean } = {},
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const scaled = opts.fromFraction ? value * 100 : value;
  const str = `${scaled.toFixed(digits)}%`;
  if (opts.sign && scaled > 0) return `+${str}`;
  return str;
}

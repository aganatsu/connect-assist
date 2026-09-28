/**
 * What "ENTRY TIME" means on an IPO row.
 *
 * WHAT THIS EXISTS TO STOP. `entry_time` used to hold the strategy bar OPEN —
 * `bars[entryIndex].datetime` via `intent.barTime`. A 1h fill that actually
 * happened at 15:37 was stored and displayed as 15:00, and a BTC 1h position
 * whose bar opened 14:00 read as a 14:00 entry when price first reached the
 * level around 14:13. A bar open is not an execution time.
 *
 * Two fields, one meaning each:
 *   entry_time         the best-known causal entry INSTANT
 *   strategy_bar_time  the HTF bar that contained it, bar-aligned, always
 *
 * Precision is not a stored flag. `entry_minute_time` non-null means the tape
 * proved the minute; null means the minute is unknown and `entry_time` is still
 * the bar. Legacy rows are therefore self-describing — they are labelled
 * strategy-bar rather than passed off as exact.
 *
 * `entryInstant` reads `entry_minute_time` FIRST so the UI is right on a row
 * written before the repointing migration, where the minute was recorded but
 * `entry_time` still held the bar.
 */

export type EntryPrecision = "minute" | "strategy_bar";

/** The timestamp columns this module reads. All optional: legacy rows lack them. */
export interface EntryTimeFields {
  entry_time: string;
  strategy_bar_time?: string | null;
  entry_minute_time?: string | null;
}

/** Whether `entryInstant` is the proven fill minute or merely its bar. */
export const entryPrecision = (r: EntryTimeFields): EntryPrecision =>
  r.entry_minute_time ? "minute" : "strategy_bar";

/**
 * THE value to render under a label that says "entry time".
 *
 * Never rounds to the strategy timeframe, and never invents a minute: when none
 * was proven this returns the bar, and `entryPrecision` says so.
 */
export const entryInstant = (r: EntryTimeFields): string =>
  r.entry_minute_time ?? r.entry_time;

/** The parent bar. Falls back to `entry_time`, which is what a legacy row's is. */
export const strategyBar = (r: EntryTimeFields): string =>
  r.strategy_bar_time ?? r.entry_time;

/** True when the two are genuinely different and both are worth showing. */
export const entryDiffersFromBar = (r: EntryTimeFields): boolean =>
  new Date(entryInstant(r)).getTime() !== new Date(strategyBar(r)).getTime();

/**
 * `YYYY-MM-DD HH:MM`, extended to `:SS` only when the source carries seconds.
 *
 * UTC at the boundary: the stored value is timestamptz and the conversion to a
 * display zone must not be able to drop minutes. Slicing an ISO string keeps
 * the instant exact; `toLocaleString` would apply the browser's zone silently.
 */
export const formatInstant = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const s = d.toISOString();
  return d.getUTCSeconds() === 0
    ? s.slice(0, 16).replace("T", " ")
    : s.slice(0, 19).replace("T", " ");
};

/** Suffix marking a row whose minute was never proven. Empty when it was. */
export const precisionNote = (r: EntryTimeFields): string =>
  entryPrecision(r) === "minute" ? "" : "strategy bar — exact minute not recorded";

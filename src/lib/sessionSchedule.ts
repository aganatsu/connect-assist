/**
 * Client-side session detection — mirrors _shared/sessions.ts (SINGLE SOURCE OF TRUTH).
 *
 * Four non-overlapping sessions (NY local time):
 *   Asian     20:00 – 02:00 ET
 *   London    02:00 – 08:30 ET
 *   New York  08:30 – 16:00 ET
 *   Off-Hours 16:00 – 20:00 ET
 *
 * Config shape (canonical):
 *   sessions.filter: string[]  — e.g. ["london", "newyork"]
 *   Valid keys: "asian" | "london" | "newyork" | "offhours"
 *   Empty array = NOTHING enabled (bot pauses).
 */

export type SessionName = "Asian" | "London" | "New York" | "Off-Hours";
export type SessionFilterKey = "asian" | "london" | "newyork" | "offhours";

export const VALID_SESSION_KEYS: readonly SessionFilterKey[] = ["asian", "london", "newyork", "offhours"];

/**
 * Config shape accepted by all session functions.
 * Reads the canonical `sessions.filter` array from bot config.
 * Also supports legacy boolean format for backward compatibility.
 */
export interface SessionsConfig {
  filter?: string[];
  // Legacy boolean format (for backward compat during migration)
  londonEnabled?: boolean;
  newYorkEnabled?: boolean;
  asianEnabled?: boolean;
  sydneyEnabled?: boolean;
  offHoursEnabled?: boolean;
}

interface SessionWindow {
  name: SessionName;
  filterKey: SessionFilterKey;
  startNY: number;
  endNY: number;   // may be > 24 for midnight-wrapping windows
}

/** The four canonical, non-overlapping session windows. */
const SESSION_WINDOWS: readonly SessionWindow[] = [
  { name: "London",    filterKey: "london",   startNY: 2,    endNY: 8.5 },
  { name: "New York",  filterKey: "newyork",  startNY: 8.5,  endNY: 16 },
  { name: "Asian",     filterKey: "asian",    startNY: 20,   endNY: 26 },
  { name: "Off-Hours", filterKey: "offhours", startNY: 16,   endNY: 20 },
];

// ─── NY Time Helper ────────────────────────────────────────────────

/** Returns NY local decimal hours for a given Date (DST-aware via Intl). */
function nyDecimalHour(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  let h = get("hour");
  if (h === 24) h = 0;
  return h + get("minute") / 60 + get("second") / 3600;
}

function inWindow(t: number, start: number, end: number): boolean {
  if (end > 24) return t >= start || t < end - 24;
  return t >= start && t < end;
}

// ─── Config Normalization ──────────────────────────────────────────

/**
 * Extract the enabled session filter keys from a raw config object.
 * Handles both canonical filter-array and legacy boolean formats.
 */
function resolveFilter(cfg: SessionsConfig | null | undefined): SessionFilterKey[] {
  if (!cfg) return [];

  // Canonical format: sessions.filter array
  if (Array.isArray(cfg.filter)) {
    const migrationMap: Record<string, SessionFilterKey> = {
      "sydney": "offhours",
      "off-hours": "offhours",
      "off_hours": "offhours",
      "newyork": "newyork",
      "new_york": "newyork",
      "new york": "newyork",
    };
    const result = new Set<SessionFilterKey>();
    for (const item of cfg.filter) {
      if (typeof item !== "string") continue;
      const normalized = item.toLowerCase().trim().replace(/\s+/g, "");
      const migrated = migrationMap[normalized] ?? normalized;
      if (VALID_SESSION_KEYS.includes(migrated as SessionFilterKey)) {
        result.add(migrated as SessionFilterKey);
      }
    }
    return [...result];
  }

  // Legacy boolean format
  const result: SessionFilterKey[] = [];
  if (cfg.londonEnabled) result.push("london");
  if (cfg.newYorkEnabled) result.push("newyork");
  if (cfg.asianEnabled) result.push("asian");
  if (cfg.sydneyEnabled || cfg.offHoursEnabled) result.push("offhours");
  return result;
}

// ─── Core Detection ────────────────────────────────────────────────

export interface SessionResult {
  name: SessionName;
  filterKey: SessionFilterKey;
}

export function detectSession(now: Date = new Date()): SessionResult {
  const t = nyDecimalHour(now);
  for (const w of SESSION_WINDOWS) {
    if (inWindow(t, w.startNY, w.endNY)) {
      return { name: w.name, filterKey: w.filterKey };
    }
  }
  return { name: "Off-Hours", filterKey: "offhours" };
}

export function isCurrentSessionEnabled(now: Date, cfg: SessionsConfig | null | undefined): boolean {
  const session = detectSession(now);
  const enabledKeys = resolveFilter(cfg);
  if (enabledKeys.length === 0) return false; // empty = nothing enabled
  return enabledKeys.includes(session.filterKey);
}

// ─── Next Session Countdown ────────────────────────────────────────

/** Convert a NY decimal hour-of-day to a Date relative to `ref`. */
function nyHourToDate(targetHourNY: number, ref: Date): Date {
  const nowHourNY = nyDecimalHour(ref);
  let diff = targetHourNY - nowHourNY;
  if (targetHourNY >= 24) diff = (targetHourNY - 24) - nowHourNY + 24;
  const candidate = new Date(ref.getTime() + diff * 3600 * 1000);
  if (candidate.getTime() <= ref.getTime()) {
    return new Date(candidate.getTime() + 24 * 3600 * 1000);
  }
  return candidate;
}

export interface NextSessionInfo {
  name: SessionName;
  filterKey: SessionFilterKey;
  startsAt: Date;
  msUntil: number;
}

export function getNextEnabledSession(
  cfg: SessionsConfig | null | undefined,
  now: Date = new Date()
): NextSessionInfo | null {
  const enabledKeys = resolveFilter(cfg);
  if (enabledKeys.length === 0) return null;

  const enabledWindows = SESSION_WINDOWS.filter((w) => enabledKeys.includes(w.filterKey));
  if (enabledWindows.length === 0) return null;

  const candidates = enabledWindows
    .map((w) => {
      const startsAt = nyHourToDate(w.startNY, now);
      return { name: w.name, filterKey: w.filterKey, startsAt, msUntil: startsAt.getTime() - now.getTime() };
    })
    .sort((a, b) => a.msUntil - b.msUntil);

  return candidates[0] ?? null;
}

// ─── Formatting Helpers ────────────────────────────────────────────

export function formatCountdown(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatNYTime(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

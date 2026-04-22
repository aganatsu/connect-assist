/**
 * _shared/sessions.ts — SINGLE SOURCE OF TRUTH for trading session detection
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This module defines the ONLY session model used across the entire system:
 *   - bot-scanner (SMC)
 *   - bot-scanner-fotsi
 *   - backtest-engine
 *   - smcAnalysis.ts (shared analysis)
 *   - scannerManagement.ts (trade management)
 *   - Frontend (sessionSchedule.ts)
 *
 * FOUR non-overlapping sessions covering the full 24-hour cycle:
 *   Asian     20:00 – 02:00 NY (Tokyo / Hong Kong)
 *   London    02:00 – 08:30 NY (London open)
 *   New York  08:30 – 16:00 NY (NY open)
 *   Off-Hours 16:00 – 20:00 NY (gap between NY close & Asian open)
 *
 * NO "Sydney" session. The old Sydney (17:00–02:00) overlapped Asian and
 * created priority-order bugs. If you want 17:00–20:00 coverage, enable
 * Off-Hours. If you want 20:00–02:00 coverage, enable Asian.
 *
 * CONFIG SHAPE (canonical):
 *   sessions.filter: string[]
 *   Valid values: "asian" | "london" | "newyork" | "offhours"
 *   Empty array [] = NOTHING enabled (bot pauses). NOT "no filtering".
 *
 * DST-AWARE: Uses proper US DST rules (2nd Sunday March → 1st Sunday Nov).
 */

// ─── Types ────────────────────────────────────────────────────────────

export type SessionName = "Asian" | "London" | "New York" | "Off-Hours";

export type SessionFilterKey = "asian" | "london" | "newyork" | "offhours";

export interface SessionResult {
  name: SessionName;
  filterKey: SessionFilterKey;
  isKillZone: boolean;
}

export interface SessionWindow {
  name: SessionName;
  filterKey: SessionFilterKey;
  startNY: number;   // NY decimal hour (e.g. 20.0 for 8:00 PM)
  endNY: number;     // NY decimal hour (e.g. 26.0 = 02:00 next day for wrapping)
  killZoneStart?: number;
  killZoneEnd?: number;
}

// ─── Constants ────────────────────────────────────────────────────────

/** The four canonical, non-overlapping session windows (NY local time). */
export const SESSION_WINDOWS: readonly SessionWindow[] = [
  // Check order matters: London → New York → Asian → Off-Hours
  // London and NY are checked first because they're the primary trading sessions.
  // Asian wraps midnight so it's checked with the wrap-aware inWindow().
  // Off-Hours is the fallback for anything not covered by the other three.
  {
    name: "London",
    filterKey: "london",
    startNY: 2,
    endNY: 8.5,
    killZoneStart: 2,
    killZoneEnd: 5,
  },
  {
    name: "New York",
    filterKey: "newyork",
    startNY: 8.5,
    endNY: 16,
    killZoneStart: 8.5,
    killZoneEnd: 12,
  },
  {
    name: "Asian",
    filterKey: "asian",
    startNY: 20,
    endNY: 26,  // wraps: 20:00 → 02:00 (next day)
  },
  {
    name: "Off-Hours",
    filterKey: "offhours",
    startNY: 16,
    endNY: 20,
  },
] as const;

/** All valid filter keys. Use for validation. */
export const VALID_SESSION_KEYS: readonly SessionFilterKey[] = ["asian", "london", "newyork", "offhours"];

/** Human-readable labels for UI display. */
export const SESSION_LABELS: Record<SessionFilterKey, string> = {
  asian: "Asian Session (8:00 PM – 2:00 AM ET)",
  london: "London Session (2:00 AM – 8:30 AM ET)",
  newyork: "New York Session (8:30 AM – 4:00 PM ET)",
  offhours: "Off-Hours (4:00 PM – 8:00 PM ET)",
};

/** Map from display name → filter key. */
export const SESSION_NAME_TO_KEY: Record<SessionName, SessionFilterKey> = {
  "Asian": "asian",
  "London": "london",
  "New York": "newyork",
  "Off-Hours": "offhours",
};

// ─── DST-Aware NY Time ───────────────────────────────────────────────

/**
 * Convert a UTC Date to New York local time components.
 * Uses proper US DST rules: EDT starts 2nd Sunday of March at 2:00 AM local
 * (07:00 UTC), EST starts 1st Sunday of November at 2:00 AM local (06:00 UTC).
 */
export function toNYTime(utc: Date): { h: number; m: number; t: number; tMin: number; isEDT: boolean } {
  const year = utc.getUTCFullYear();

  // 2nd Sunday of March: March 1 + offset to get to 2nd Sunday
  const mar1 = new Date(Date.UTC(year, 2, 1));
  const marSun2 = 14 - mar1.getUTCDay(); // day of month for 2nd Sunday
  const edtStart = Date.UTC(year, 2, marSun2, 7, 0, 0); // 2 AM ET = 7 AM UTC

  // 1st Sunday of November
  const nov1 = new Date(Date.UTC(year, 10, 1));
  const novSun1 = nov1.getUTCDay() === 0 ? 1 : 8 - nov1.getUTCDay();
  const edtEnd = Date.UTC(year, 10, novSun1, 6, 0, 0); // 2 AM ET = 6 AM UTC (still EDT)

  const isEDT = utc.getTime() >= edtStart && utc.getTime() < edtEnd;
  const offsetH = isEDT ? 4 : 5;
  const nyMs = utc.getTime() - offsetH * 3600_000;
  const ny = new Date(nyMs);
  const h = ny.getUTCHours();
  const m = ny.getUTCMinutes();
  return { h, m, t: h + m / 60, tMin: h * 60 + m, isEDT };
}

/** Variant that accepts a UTC millisecond timestamp. */
export function toNYTimeAt(utcMs: number): { h: number; m: number; t: number; tMin: number; isEDT: boolean } {
  return toNYTime(new Date(utcMs));
}

// ─── Window Matching ─────────────────────────────────────────────────

/** Check if decimal hour `t` falls within (start, end), handling midnight wrap. */
function inWindow(t: number, start: number, end: number): boolean {
  if (end > 24) {
    // Wraps midnight: e.g. 20:00 → 02:00 (stored as 20 → 26)
    return t >= start || t < (end - 24);
  }
  return t >= start && t < end;
}

// ─── Core Detection ──────────────────────────────────────────────────

/**
 * Detect which session a given time falls in.
 * @param atMs  UTC timestamp in milliseconds. Defaults to Date.now().
 * @returns     SessionResult with name, filterKey, and isKillZone flag.
 */
export function detectSession(atMs?: number): SessionResult {
  const ny = atMs != null ? toNYTimeAt(atMs) : toNYTime(new Date());
  const t = ny.t;

  for (const w of SESSION_WINDOWS) {
    if (inWindow(t, w.startNY, w.endNY)) {
      const isKillZone = w.killZoneStart != null && w.killZoneEnd != null
        ? (t >= w.killZoneStart && t < w.killZoneEnd)
        : false;
      return { name: w.name, filterKey: w.filterKey, isKillZone };
    }
  }

  // Should never reach here since the 4 windows cover the full 24h,
  // but as a safety fallback:
  return { name: "Off-Hours", filterKey: "offhours", isKillZone: false };
}

// ─── Session Gating ──────────────────────────────────────────────────

/**
 * Check if a session is enabled in the user's filter array.
 *
 * IMPORTANT: Empty array = NOTHING enabled. The bot should pause.
 * This is the opposite of the old behavior where empty = "no filtering".
 */
export function isSessionEnabled(
  session: SessionResult,
  enabledSessions: string[],
): boolean {
  if (enabledSessions.length === 0) return false; // empty = nothing enabled
  return enabledSessions.includes(session.filterKey);
}

/**
 * Normalize a raw session filter array from config.
 * - Lowercases all values
 * - Strips whitespace
 * - Migrates legacy values: "sydney" → "offhours"
 * - Removes invalid values
 * - Deduplicates
 */
export function normalizeSessionFilter(raw: unknown): SessionFilterKey[] {
  if (!Array.isArray(raw)) return [];

  const migrationMap: Record<string, SessionFilterKey> = {
    "sydney": "offhours",
    "off-hours": "offhours",
    "off_hours": "offhours",
    "newyork": "newyork",
    "new_york": "newyork",
    "new york": "newyork",
  };

  const result = new Set<SessionFilterKey>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const normalized = item.toLowerCase().trim().replace(/\s+/g, "");
    const migrated = migrationMap[normalized] ?? normalized;
    if (VALID_SESSION_KEYS.includes(migrated as SessionFilterKey)) {
      result.add(migrated as SessionFilterKey);
    }
  }
  return [...result];
}

/**
 * Convert legacy boolean session config to filter array.
 * Used for FOTSI bot migration and any old configs with boolean flags.
 */
export function legacyBoolsToFilter(bools: {
  london?: boolean;
  newYork?: boolean;
  asian?: boolean;
  sydney?: boolean;
  offHours?: boolean;
}): SessionFilterKey[] {
  const result: SessionFilterKey[] = [];
  if (bools.london) result.push("london");
  if (bools.newYork) result.push("newyork");
  if (bools.asian) result.push("asian");
  // Sydney maps to offhours
  if (bools.sydney || bools.offHours) result.push("offhours");
  return result;
}

// ─── Silver Bullet Windows ──────────────────────────────────────────

export interface SilverBulletResult {
  active: boolean;
  window: string | null;
  minutesRemaining: number;
}

export function detectSilverBullet(atMs?: number): SilverBulletResult {
  const ny = atMs != null ? toNYTimeAt(atMs) : toNYTime(new Date());
  const t = ny.t;
  const windows = [
    { name: "London Open SB", start: 3, end: 4 },
    { name: "AM SB", start: 10, end: 11 },
    { name: "PM SB", start: 14, end: 15 },
  ];
  for (const w of windows) {
    if (t >= w.start && t < w.end) {
      return { active: true, window: w.name, minutesRemaining: Math.max(0, Math.round((w.end - t) * 60)) };
    }
  }
  return { active: false, window: null, minutesRemaining: 0 };
}

// ─── ICT Macro Windows ─────────────────────────────────────────────

export interface MacroWindowResult {
  active: boolean;
  window: string | null;
  minutesRemaining: number;
}

export function detectMacroWindow(atMs?: number): MacroWindowResult {
  const ny = atMs != null ? toNYTimeAt(atMs) : toNYTime(new Date());
  const tMin = ny.tMin;
  const windows = [
    { name: "London Macro 1",     start: 2 * 60 + 33, end: 2 * 60 + 50 },
    { name: "London Macro 2",     start: 4 * 60 + 3,  end: 4 * 60 + 20 },
    { name: "NY Pre-Open Macro",  start: 8 * 60 + 50, end: 9 * 60 + 10 },
    { name: "NY AM Macro",        start: 9 * 60 + 50, end: 10 * 60 + 10 },
    { name: "London Close Macro", start: 10 * 60 + 50, end: 11 * 60 + 10 },
    { name: "NY Lunch Macro",     start: 11 * 60 + 50, end: 12 * 60 + 10 },
    { name: "Last Hour Macro",    start: 13 * 60 + 10, end: 13 * 60 + 40 },
    { name: "PM Macro",           start: 15 * 60 + 15, end: 15 * 60 + 45 },
  ];
  for (const w of windows) {
    if (tMin >= w.start && tMin < w.end) {
      return { active: true, window: w.name, minutesRemaining: w.end - tMin };
    }
  }
  return { active: false, window: null, minutesRemaining: 0 };
}

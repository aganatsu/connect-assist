/**
 * ictKillZones.ts — ICT Kill Zone Time Filter
 * ════════════════════════════════════════════
 *
 * ICT defines specific time windows where institutional activity is highest
 * and setups have the best probability. Outside these windows, setups are
 * lower probability.
 *
 * ICT Kill Zones (New York local time):
 *   - London Kill Zone:    02:00 – 05:00 NY (London open)
 *   - New York Kill Zone:  08:30 – 11:00 NY (NY open / AM session)
 *   - Silver Bullet 1:     03:00 – 04:00 NY (London SB)
 *   - Silver Bullet 2:     10:00 – 11:00 NY (NY SB)
 *   - Silver Bullet 3:     14:00 – 15:00 NY (PM SB)
 *   - PM Session:          13:30 – 16:00 NY (afternoon continuation)
 *
 * ICT "Dead Zones" (avoid):
 *   - Lunch Hour:          12:00 – 13:30 NY (no institutional flow)
 *   - Asian Consolidation: 18:00 – 00:00 NY (low volatility for forex)
 *
 * The existing sessions.ts handles basic session detection. This module adds
 * ICT-specific kill zone granularity and the Silver Bullet windows.
 *
 * Gate modes: "hard" | "soft" | "off"
 */

// ─── Configuration ────────────────────────────────────────────────────
export interface ICTKillZoneConfig {
  enabled: boolean;
  gateMode: "hard" | "soft" | "off";
  /** Allow Silver Bullet windows as valid entry times */
  enableSilverBullet: boolean;
  /** Allow PM session entries */
  enablePMSession: boolean;
  /** Penalty for entries outside kill zones (soft mode) */
  outsideKZPenalty: number;
  /** Bonus for entries during prime kill zone time */
  primeKZBonus: number;
  /** Penalty for entries during dead zones (lunch, late Asian) */
  deadZonePenalty: number;
}

export const DEFAULT_ICT_KILLZONE_CONFIG: ICTKillZoneConfig = {
  enabled: true,
  gateMode: "off",
  enableSilverBullet: true,
  enablePMSession: true,
  outsideKZPenalty: -1.0,
  primeKZBonus: 0.5,
  deadZonePenalty: -2.0,
};

// ─── Types ────────────────────────────────────────────────────────────
export type ICTWindow =
  | "london_kz"
  | "ny_kz"
  | "silver_bullet_london"
  | "silver_bullet_ny"
  | "silver_bullet_pm"
  | "pm_session"
  | "lunch_dead"
  | "asian_dead"
  | "off_hours";

export interface ICTKillZoneResult {
  currentWindow: ICTWindow;
  windowLabel: string;
  isKillZone: boolean;
  isSilverBullet: boolean;
  isDeadZone: boolean;
  isPrime: boolean; // highest probability window
  nyHour: number;
  scoreAdjustment: number;
  passed: boolean;
  reason: string;
}

// ─── DST Helpers (matching sessions.ts) ───────────────────────────────

function isUST_DST(date: Date): boolean {
  const year = date.getUTCFullYear();
  // 2nd Sunday of March
  const marchFirst = new Date(Date.UTC(year, 2, 1));
  const marchFirstDay = marchFirst.getUTCDay();
  const secondSunday = marchFirstDay === 0 ? 8 : 15 - marchFirstDay;
  const dstStart = new Date(Date.UTC(year, 2, secondSunday, 7)); // 2am ET = 7am UTC

  // 1st Sunday of November
  const novFirst = new Date(Date.UTC(year, 10, 1));
  const novFirstDay = novFirst.getUTCDay();
  const firstSunday = novFirstDay === 0 ? 1 : 8 - novFirstDay;
  const dstEnd = new Date(Date.UTC(year, 10, firstSunday, 6)); // 2am ET = 6am UTC

  return date >= dstStart && date < dstEnd;
}

function toNYDecimalHour(date: Date): number {
  const utcHour = date.getUTCHours() + date.getUTCMinutes() / 60;
  const offset = isUST_DST(date) ? -4 : -5;
  let nyHour = utcHour + offset;
  if (nyHour < 0) nyHour += 24;
  if (nyHour >= 24) nyHour -= 24;
  return nyHour;
}

// ─── Window Detection ─────────────────────────────────────────────────

function inRange(hour: number, start: number, end: number): boolean {
  if (start <= end) return hour >= start && hour < end;
  // Wraps midnight
  return hour >= start || hour < end;
}

/**
 * Determine which ICT window the current time falls into.
 */
export function detectICTWindow(timestamp: Date | number): {
  window: ICTWindow;
  label: string;
  isKillZone: boolean;
  isSilverBullet: boolean;
  isDeadZone: boolean;
  isPrime: boolean;
  nyHour: number;
} {
  const date = typeof timestamp === "number" ? new Date(timestamp) : timestamp;
  const nyHour = toNYDecimalHour(date);

  // Silver Bullet windows (most specific, check first)
  if (inRange(nyHour, 3, 4)) {
    return { window: "silver_bullet_london", label: "London Silver Bullet (03:00-04:00)", isKillZone: true, isSilverBullet: true, isDeadZone: false, isPrime: true, nyHour };
  }
  if (inRange(nyHour, 10, 11)) {
    return { window: "silver_bullet_ny", label: "NY Silver Bullet (10:00-11:00)", isKillZone: true, isSilverBullet: true, isDeadZone: false, isPrime: true, nyHour };
  }
  if (inRange(nyHour, 14, 15)) {
    return { window: "silver_bullet_pm", label: "PM Silver Bullet (14:00-15:00)", isKillZone: true, isSilverBullet: true, isDeadZone: false, isPrime: false, nyHour };
  }

  // London Kill Zone (02:00 - 05:00)
  if (inRange(nyHour, 2, 5)) {
    return { window: "london_kz", label: "London Kill Zone (02:00-05:00)", isKillZone: true, isSilverBullet: false, isDeadZone: false, isPrime: true, nyHour };
  }

  // NY Kill Zone (08:30 - 11:00)
  if (inRange(nyHour, 8.5, 11)) {
    return { window: "ny_kz", label: "NY Kill Zone (08:30-11:00)", isKillZone: true, isSilverBullet: false, isDeadZone: false, isPrime: true, nyHour };
  }

  // PM Session (13:30 - 16:00)
  if (inRange(nyHour, 13.5, 16)) {
    return { window: "pm_session", label: "PM Session (13:30-16:00)", isKillZone: true, isSilverBullet: false, isDeadZone: false, isPrime: false, nyHour };
  }

  // Dead Zones
  if (inRange(nyHour, 12, 13.5)) {
    return { window: "lunch_dead", label: "Lunch Dead Zone (12:00-13:30)", isKillZone: false, isSilverBullet: false, isDeadZone: true, isPrime: false, nyHour };
  }
  if (inRange(nyHour, 18, 24) || inRange(nyHour, 0, 2)) {
    return { window: "asian_dead", label: "Asian/Off-Hours (18:00-02:00)", isKillZone: false, isSilverBullet: false, isDeadZone: true, isPrime: false, nyHour };
  }

  // Everything else (05:00-08:30 gap, 11:00-12:00, 16:00-18:00)
  return { window: "off_hours", label: `Off-Hours (${nyHour.toFixed(1)} NY)`, isKillZone: false, isSilverBullet: false, isDeadZone: false, isPrime: false, nyHour };
}

// ─── Gate Function ────────────────────────────────────────────────────

/**
 * Evaluate whether the current time passes the ICT Kill Zone gate.
 *
 * @param timestamp - Current time (Date or epoch ms)
 * @param config - Configuration
 */
export function evaluateICTKillZone(
  timestamp: Date | number,
  config: ICTKillZoneConfig = DEFAULT_ICT_KILLZONE_CONFIG,
): ICTKillZoneResult {
  if (!config.enabled) {
    return {
      currentWindow: "off_hours",
      windowLabel: "Disabled",
      isKillZone: false,
      isSilverBullet: false,
      isDeadZone: false,
      isPrime: false,
      nyHour: 0,
      scoreAdjustment: 0,
      passed: true,
      reason: "ICT Kill Zone filter disabled",
    };
  }

  const detection = detectICTWindow(timestamp);

  // Determine if this window is allowed
  let isAllowed = detection.isKillZone;

  // Silver Bullet requires explicit enable
  if (detection.isSilverBullet && !config.enableSilverBullet) {
    isAllowed = detection.window !== "silver_bullet_london" &&
                detection.window !== "silver_bullet_ny" &&
                detection.window !== "silver_bullet_pm";
  }

  // PM Session requires explicit enable
  if (detection.window === "pm_session" && !config.enablePMSession) {
    isAllowed = false;
  }

  // Gate decision
  let passed = true;
  let scoreAdjustment = 0;
  let reason = "";

  if (config.gateMode === "off") {
    passed = true;
    scoreAdjustment = 0;
    if (detection.isDeadZone) {
      reason = `[OFF] DEAD ZONE: ${detection.label} — would have penalized (${config.deadZonePenalty})`;
    } else if (detection.isPrime) {
      reason = `[OFF] PRIME: ${detection.label} — would have applied +${config.primeKZBonus}`;
    } else if (!isAllowed) {
      reason = `[OFF] Outside KZ: ${detection.label} — would have ${config.gateMode === "hard" ? "blocked" : "penalized"}`;
    } else {
      reason = `[OFF] In KZ: ${detection.label}`;
    }
  } else if (detection.isDeadZone) {
    if (config.gateMode === "hard") {
      passed = false;
      reason = `DEAD ZONE BLOCKED: ${detection.label} — no institutional flow`;
    } else {
      passed = true;
      scoreAdjustment = config.deadZonePenalty;
      reason = `Dead zone: ${detection.label} (${config.deadZonePenalty} penalty)`;
    }
  } else if (!isAllowed) {
    if (config.gateMode === "hard") {
      passed = false;
      reason = `Outside ICT Kill Zone: ${detection.label}`;
    } else {
      passed = true;
      scoreAdjustment = config.outsideKZPenalty;
      reason = `Outside KZ: ${detection.label} (${config.outsideKZPenalty} penalty)`;
    }
  } else if (detection.isPrime) {
    passed = true;
    scoreAdjustment = config.primeKZBonus;
    reason = `Prime Kill Zone: ${detection.label} (+${config.primeKZBonus})`;
  } else {
    passed = true;
    reason = `In Kill Zone: ${detection.label}`;
  }

  return {
    currentWindow: detection.window,
    windowLabel: detection.label,
    isKillZone: detection.isKillZone,
    isSilverBullet: detection.isSilverBullet,
    isDeadZone: detection.isDeadZone,
    isPrime: detection.isPrime,
    nyHour: detection.nyHour,
    scoreAdjustment,
    passed,
    reason,
  };
}

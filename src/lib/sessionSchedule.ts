// Client-side mirror of bot-scanner's session detection (DST-aware via America/New_York).
// Honors custom session windows from bot config (interpreted as NY/ET time, DST-aware).
// Source of truth: supabase/functions/bot-scanner/index.ts detectSession().

export type SessionName = "Sydney" | "Asian" | "London" | "New York" | "Off-Hours";

// Returns NY local decimal hours for a given Date (DST-aware).
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

function parseHHMM(s: any, fallback: number): number {
  if (typeof s !== "string") return fallback;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  return Number(m[1]) + Number(m[2]) / 60;
}

export interface SessionsConfig {
  londonEnabled?: boolean;
  londonStart?: string;
  londonEnd?: string;
  newYorkEnabled?: boolean;
  newYorkStart?: string;
  newYorkEnd?: string;
  asianEnabled?: boolean;
  asianStart?: string;
  asianEnd?: string;
  sydneyEnabled?: boolean;
  sydneyStart?: string;
  sydneyEnd?: string;
  offHoursEnabled?: boolean;
}

interface ResolvedWindow {
  name: SessionName;
  startNY: number;     // NY decimal hour
  endNY: number;       // NY decimal hour (may be > 24 if wraps midnight)
  enabled: boolean;
}

function resolveWindows(cfg: SessionsConfig | null | undefined): ResolvedWindow[] {
  const s = cfg ?? {};
  const lonStart = parseHHMM(s.londonStart, 2);
  const lonEnd   = parseHHMM(s.londonEnd, 8.5);
  const nyStart  = parseHHMM(s.newYorkStart, 8.5);
  const nyEnd    = parseHHMM(s.newYorkEnd, 16);
  const asiaStart = parseHHMM(s.asianStart, 20);
  const asiaEndRaw = parseHHMM(s.asianEnd, 2);
  const asiaEnd = asiaEndRaw <= asiaStart ? asiaEndRaw + 24 : asiaEndRaw;
  const sydStart = parseHHMM(s.sydneyStart, 17);
  const sydEndRaw = parseHHMM(s.sydneyEnd, 2);
  const sydEnd = sydEndRaw <= sydStart ? sydEndRaw + 24 : sydEndRaw;

  return [
    { name: "London",   startNY: lonStart, endNY: lonEnd, enabled: s.londonEnabled !== false },
    { name: "New York", startNY: nyStart,  endNY: nyEnd,  enabled: s.newYorkEnabled !== false },
    { name: "Asian",    startNY: asiaStart, endNY: asiaEnd, enabled: s.asianEnabled === true },
    { name: "Sydney",   startNY: sydStart, endNY: sydEnd, enabled: s.sydneyEnabled === true },
  ];
}

function inWindow(t: number, start: number, end: number): boolean {
  if (end > 24) return t >= start || t < end - 24;
  return t >= start && t < end;
}

export function detectSession(now: Date = new Date(), cfg?: SessionsConfig | null): SessionName {
  const t = nyDecimalHour(now);
  const windows = resolveWindows(cfg);
  for (const w of windows) {
    if (inWindow(t, w.startNY, w.endNY)) return w.name;
  }
  return "Off-Hours";
}

export function isCurrentSessionEnabled(now: Date, cfg: SessionsConfig | null | undefined): boolean {
  const current = detectSession(now, cfg);
  if (current === "Off-Hours") return cfg?.offHoursEnabled === true;
  const w = resolveWindows(cfg).find((x) => x.name === current);
  return w?.enabled ?? false;
}

// Convert a NY decimal hour-of-day to a Date relative to `ref`.
// If the resulting time is in the past, advances by 24h.
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
  startsAt: Date;
  msUntil: number;
}

export function getNextEnabledSession(
  cfg: SessionsConfig | null | undefined,
  now: Date = new Date()
): NextSessionInfo | null {
  const windows = resolveWindows(cfg).filter((w) => w.enabled);
  if (windows.length === 0) return null;
  const candidates = windows
    .map((w) => {
      const startsAt = nyHourToDate(w.startNY, now);
      return { name: w.name, startsAt, msUntil: startsAt.getTime() - now.getTime() };
    })
    .sort((a, b) => a.msUntil - b.msUntil);
  return candidates[0] ?? null;
}

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

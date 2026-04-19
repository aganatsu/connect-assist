// Client-side mirror of bot-scanner's session detection (DST-aware via America/New_York).
// Source of truth: supabase/functions/bot-scanner/index.ts detectSession().

export type SessionName = "Asian" | "London" | "New York" | "Off-Hours";

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
  if (h === 24) h = 0; // en-US sometimes returns 24
  return h + get("minute") / 60 + get("second") / 3600;
}

// Mirrors scanner: 20–02 Asian, 02–08.5 London, 08.5–16 New York, 16–20 Off-Hours.
export function detectSession(now: Date = new Date()): SessionName {
  const t = nyDecimalHour(now);
  if (t >= 20 || t < 2) return "Asian";
  if (t >= 2 && t < 8.5) return "London";
  if (t >= 8.5 && t < 16) return "New York";
  return "Off-Hours";
}

// Maps UI-config keys to session names. UI uses londonEnabled / newYorkEnabled / asianEnabled / sydneyEnabled.
// Sydney is treated as part of Asian (pre-Tokyo). Off-Hours is only "enabled" when explicitly toggled.
export interface EnabledSessions {
  londonEnabled?: boolean;
  newYorkEnabled?: boolean;
  asianEnabled?: boolean;
  sydneyEnabled?: boolean;
  offHoursEnabled?: boolean;
}

export function isSessionEnabled(session: SessionName, cfg: EnabledSessions | undefined | null): boolean {
  if (!cfg) return true; // no config = assume all enabled
  switch (session) {
    case "London":
      return cfg.londonEnabled !== false;
    case "New York":
      return cfg.newYorkEnabled !== false;
    case "Asian":
      return cfg.asianEnabled === true || cfg.sydneyEnabled === true;
    case "Off-Hours":
      return cfg.offHoursEnabled === true;
  }
}

// Session windows in NY decimal hours. Order matters for "next" lookup.
const SESSION_WINDOWS: Array<{ name: SessionName; startNY: number }> = [
  { name: "London", startNY: 2 },
  { name: "New York", startNY: 8.5 },
  { name: "Off-Hours", startNY: 16 },
  { name: "Asian", startNY: 20 },
];

// Convert NY decimal hour-of-day to a Date for today (or tomorrow if already past).
function nyHourToDate(targetHourNY: number, ref: Date): Date {
  const nowHourNY = nyDecimalHour(ref);
  const diffHours = targetHourNY - nowHourNY;
  const ms = diffHours * 3600 * 1000;
  const candidate = new Date(ref.getTime() + ms);
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

// Find next enabled session start time. Returns null if none enabled.
export function getNextEnabledSession(
  cfg: EnabledSessions | undefined | null,
  now: Date = new Date()
): NextSessionInfo | null {
  // Build candidate start Dates for each session (today or tomorrow).
  const candidates = SESSION_WINDOWS
    .filter((w) => isSessionEnabled(w.name, cfg))
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

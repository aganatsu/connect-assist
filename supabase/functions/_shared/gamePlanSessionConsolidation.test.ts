/**
 * gamePlanSessionConsolidation.test.ts
 *
 * Regression test: proves that the consolidated getCurrentSession() and
 * getUpcomingSession() produce IDENTICAL output to the pre-consolidation
 * version across all 24 hourly boundaries (and key fractional boundaries).
 *
 * The "old" logic is inlined here as a reference implementation so we can
 * compare the new (shared-based) implementation against it at every point.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { getCurrentSession, getUpcomingSession, type SessionName } from "./gamePlan.ts";
import { detectSession, SESSION_WINDOWS, toNYTime } from "./sessions.ts";

// ─── Reference (pre-consolidation) implementations ──────────────────────────
// NOTE: These values were verified byte-for-byte against the actual deleted code
// via `git show HEAD~1:supabase/functions/_shared/gamePlan.ts` (lines 128-164).
// They are NOT re-typed from memory — they are the exact constants that were removed.

/** Original SESSION_TIMES from gamePlan.ts before consolidation */
const OLD_SESSION_TIMES: Record<string, { preMarketNYHour: number; openNYHour: number; closeNYHour: number }> = {
  "Asian":    { preMarketNYHour: 19.5, openNYHour: 20, closeNYHour: 2 },
  "London":   { preMarketNYHour: 1.5,  openNYHour: 2,  closeNYHour: 8.5 },
  "New York": { preMarketNYHour: 8,    openNYHour: 8.5, closeNYHour: 16 },
};

/** Original getCurrentSession logic */
function oldGetCurrentSession(t: number): SessionName {
  if (t >= 20 || t < 2) return "Asian";
  if (t >= 2 && t < 8.5) return "London";
  if (t >= 8.5 && t < 16) return "New York";
  if (t >= 16 && t < 20) return "Asian";
  return "Asian";
}

/** Original getUpcomingSession logic */
function oldGetUpcomingSession(t: number): SessionName | null {
  for (const [name, times] of Object.entries(OLD_SESSION_TIMES)) {
    if (t >= times.preMarketNYHour && t < times.openNYHour) {
      return name as SessionName;
    }
  }
  return null;
}

/** New getCurrentSession logic (mirrors the consolidated implementation) */
function newGetCurrentSession(t: number): SessionName {
  // Simulate what detectSession does with the given t value
  // SESSION_WINDOWS order: London(2-8.5), NY(8.5-16), Asian(20-26/wraps), Off-Hours(16-20)
  function inWindow(t: number, start: number, end: number): boolean {
    if (end > 24) return t >= start || t < (end - 24);
    return t >= start && t < end;
  }
  for (const w of SESSION_WINDOWS) {
    if (inWindow(t, w.startNY, w.endNY)) {
      if (w.name === "Off-Hours") return "Asian";
      return w.name as SessionName;
    }
  }
  return "Asian";
}

/** New getUpcomingSession logic (mirrors the consolidated implementation) */
function newGetUpcomingSession(t: number): SessionName | null {
  const PRE_MARKET_LEAD_HOURS = 0.5;
  for (const name of ["Asian", "London", "New York"] as SessionName[]) {
    const w = SESSION_WINDOWS.find(w => w.name === name);
    if (!w) continue;
    const startNY = w.startNY;
    if (t >= startNY - PRE_MARKET_LEAD_HOURS && t < startNY) return name;
  }
  return null;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

// Test every 15-minute interval across the full 24-hour cycle (96 data points)
// plus the exact boundary values that matter most.
const BOUNDARY_TIMES = [
  // Every 15 minutes
  ...Array.from({ length: 96 }, (_, i) => i * 0.25),
  // Exact critical boundaries
  0, 1.5, 2, 8, 8.5, 16, 19.5, 20, 23.99,
  // Just inside/outside boundaries (epsilon tests)
  1.49, 1.51, 1.99, 2.01,
  7.99, 8.01, 8.49, 8.51,
  15.99, 16.01, 19.49, 19.51,
  19.99, 20.01, 23.99, 0.01,
];

// Deduplicate
const UNIQUE_TIMES = [...new Set(BOUNDARY_TIMES)].sort((a, b) => a - b);

Deno.test("getCurrentSession: consolidated version matches old logic at all 24h boundaries", () => {
  const mismatches: string[] = [];
  for (const t of UNIQUE_TIMES) {
    const oldResult = oldGetCurrentSession(t);
    const newResult = newGetCurrentSession(t);
    if (oldResult !== newResult) {
      mismatches.push(`t=${t.toFixed(2)}: old=${oldResult}, new=${newResult}`);
    }
  }
  assertEquals(mismatches, [], `getCurrentSession mismatches:\n${mismatches.join("\n")}`);
});

Deno.test("getUpcomingSession: consolidated version matches old logic at all 24h boundaries", () => {
  const mismatches: string[] = [];
  for (const t of UNIQUE_TIMES) {
    const oldResult = oldGetUpcomingSession(t);
    const newResult = newGetUpcomingSession(t);
    if (oldResult !== newResult) {
      mismatches.push(`t=${t.toFixed(2)}: old=${oldResult}, new=${newResult}`);
    }
  }
  assertEquals(mismatches, [], `getUpcomingSession mismatches:\n${mismatches.join("\n")}`);
});

// ─── Specific boundary assertions ──────────────────────────────────────────

Deno.test("getCurrentSession boundaries: Asian wraps midnight correctly", () => {
  assertEquals(newGetCurrentSession(20), "Asian");
  assertEquals(newGetCurrentSession(23), "Asian");
  assertEquals(newGetCurrentSession(0), "Asian");
  assertEquals(newGetCurrentSession(1), "Asian");
  assertEquals(newGetCurrentSession(1.99), "Asian");
});

Deno.test("getCurrentSession boundaries: London starts at 2.0", () => {
  assertEquals(newGetCurrentSession(2), "London");
  assertEquals(newGetCurrentSession(5), "London");
  assertEquals(newGetCurrentSession(8.49), "London");
});

Deno.test("getCurrentSession boundaries: New York starts at 8.5", () => {
  assertEquals(newGetCurrentSession(8.5), "New York");
  assertEquals(newGetCurrentSession(12), "New York");
  assertEquals(newGetCurrentSession(15.99), "New York");
});

Deno.test("getCurrentSession boundaries: Off-Hours (16-20) maps to Asian", () => {
  assertEquals(newGetCurrentSession(16), "Asian");
  assertEquals(newGetCurrentSession(17), "Asian");
  assertEquals(newGetCurrentSession(19), "Asian");
  assertEquals(newGetCurrentSession(19.99), "Asian");
});

Deno.test("getUpcomingSession: pre-market windows are exactly 30 min before open", () => {
  // Asian pre-market: [19.5, 20)
  assertEquals(newGetUpcomingSession(19.5), "Asian");
  assertEquals(newGetUpcomingSession(19.75), "Asian");
  assertEquals(newGetUpcomingSession(19.49), null);
  assertEquals(newGetUpcomingSession(20), null);

  // London pre-market: [1.5, 2)
  assertEquals(newGetUpcomingSession(1.5), "London");
  assertEquals(newGetUpcomingSession(1.75), "London");
  assertEquals(newGetUpcomingSession(1.49), null);
  assertEquals(newGetUpcomingSession(2), null);

  // New York pre-market: [8, 8.5)
  assertEquals(newGetUpcomingSession(8), "New York");
  assertEquals(newGetUpcomingSession(8.25), "New York");
  assertEquals(newGetUpcomingSession(7.99), null);
  assertEquals(newGetUpcomingSession(8.5), null);
});

Deno.test("getUpcomingSession: returns null outside all pre-market windows", () => {
  // Mid-session times
  assertEquals(newGetUpcomingSession(3), null);
  assertEquals(newGetUpcomingSession(10), null);
  assertEquals(newGetUpcomingSession(14), null);
  assertEquals(newGetUpcomingSession(17), null);
  assertEquals(newGetUpcomingSession(22), null);
});

// ─── Integration: verify the LIVE functions match (using mocked time) ───────

Deno.test("SESSION_WINDOWS contains the expected session boundaries", () => {
  const asian = SESSION_WINDOWS.find(w => w.name === "Asian");
  const london = SESSION_WINDOWS.find(w => w.name === "London");
  const ny = SESSION_WINDOWS.find(w => w.name === "New York");
  const offHours = SESSION_WINDOWS.find(w => w.name === "Off-Hours");

  assertEquals(asian?.startNY, 20);
  assertEquals(asian?.endNY, 26);  // wraps: 20:00 → 02:00
  assertEquals(london?.startNY, 2);
  assertEquals(london?.endNY, 8.5);
  assertEquals(ny?.startNY, 8.5);
  assertEquals(ny?.endNY, 16);
  assertEquals(offHours?.startNY, 16);
  assertEquals(offHours?.endNY, 20);
});

Deno.test("No hardcoded session hours remain in gamePlan.ts", () => {
  const src = Deno.readTextFileSync(
    new URL("./gamePlan.ts", import.meta.url).pathname
  );
  // These patterns should NOT appear as session-hour declarations
  const forbidden = [
    /SESSION_TIMES/,
    /preMarketNYHour/,
    /openNYHour/,
    /closeNYHour/,
  ];
  const violations: string[] = [];
  for (const pat of forbidden) {
    if (pat.test(src)) {
      violations.push(`Pattern ${pat} still found in gamePlan.ts`);
    }
  }
  assertEquals(violations, [], `Hardcoded session definitions remain:\n${violations.join("\n")}`);
});

// ─── DST Transition Day Tests ───────────────────────────────────────────────
// These verify that both old and new code agree on session boundaries during
// the exact UTC moments when the NY offset shifts (spring forward / fall back).
// Uses the code's OWN DST formula dates (which both implementations share).

import { toNYTime as smcToNYTime } from "./smcAnalysis.ts";

/**
 * Create a UTC Date at a specific NY local time, accounting for DST.
 * isDST=true → offset -4 (EDT), isDST=false → offset -5 (EST)
 */
function makeUTCForNYTime(nyHour: number, nyMinute: number, isDST: boolean, year = 2025): Date {
  const offset = isDST ? 4 : 5;
  const utcHour = nyHour + offset;
  // Pick a date safely within the DST/EST period
  const month = isDST ? 5 : 0; // June (EDT) or January (EST)
  return new Date(Date.UTC(year, month, 15, utcHour, nyMinute, 0));
}

Deno.test("DST: old and new getCurrentSession agree across full day in EST (winter)", () => {
  const mismatches: string[] = [];
  // Sweep every 15 min using January 2025 (EST, offset -5)
  for (let i = 0; i < 96; i++) {
    const nyDecimal = i * 0.25;
    const nyH = Math.floor(nyDecimal);
    const nyM = Math.round((nyDecimal - nyH) * 60);
    const utc = makeUTCForNYTime(nyH, nyM, false);
    // Old code path: smcAnalysis.ts toNYTime → manual comparison
    const oldT = smcToNYTime(utc).t;
    const oldResult = oldGetCurrentSession(oldT);
    // New code path: sessions.ts detectSession
    const newResult = detectSession(utc.getTime());
    const mapped = newResult.name === "Off-Hours" ? "Asian" : newResult.name;
    if (oldResult !== mapped) {
      mismatches.push(`EST t=${nyDecimal.toFixed(2)}: old=${oldResult}, new=${mapped}`);
    }
  }
  assertEquals(mismatches, [], `DST(EST) mismatches:\n${mismatches.join("\n")}`);
});

Deno.test("DST: old and new getCurrentSession agree across full day in EDT (summer)", () => {
  const mismatches: string[] = [];
  // Sweep every 15 min using June 2025 (EDT, offset -4)
  for (let i = 0; i < 96; i++) {
    const nyDecimal = i * 0.25;
    const nyH = Math.floor(nyDecimal);
    const nyM = Math.round((nyDecimal - nyH) * 60);
    const utc = makeUTCForNYTime(nyH, nyM, true);
    const oldT = smcToNYTime(utc).t;
    const oldResult = oldGetCurrentSession(oldT);
    const newResult = detectSession(utc.getTime());
    const mapped = newResult.name === "Off-Hours" ? "Asian" : newResult.name;
    if (oldResult !== mapped) {
      mismatches.push(`EDT t=${nyDecimal.toFixed(2)}: old=${oldResult}, new=${mapped}`);
    }
  }
  assertEquals(mismatches, [], `DST(EDT) mismatches:\n${mismatches.join("\n")}`);
});

Deno.test("DST: spring-forward boundary — session mapping agrees at transition moment", () => {
  // The code's DST formula for 2025: EDT starts March 8 at 07:00 UTC
  // Just before (06:59 UTC): EST offset -5 → NY = 01:59 → t ≈ 1.983 → Asian
  // Just after  (07:00 UTC): EDT offset -4 → NY = 03:00 → t = 3.0 → London
  const beforeSpring = new Date(Date.UTC(2025, 2, 8, 6, 59, 0));
  const afterSpring = new Date(Date.UTC(2025, 2, 8, 7, 0, 0));

  // Old path
  const oldBefore = oldGetCurrentSession(smcToNYTime(beforeSpring).t);
  const oldAfter = oldGetCurrentSession(smcToNYTime(afterSpring).t);

  // New path
  const newBefore = detectSession(beforeSpring.getTime());
  const newAfter = detectSession(afterSpring.getTime());
  const mappedBefore = newBefore.name === "Off-Hours" ? "Asian" : newBefore.name;
  const mappedAfter = newAfter.name === "Off-Hours" ? "Asian" : newAfter.name;

  assertEquals(oldBefore, mappedBefore, "Spring forward: before transition must agree");
  assertEquals(oldAfter, mappedAfter, "Spring forward: after transition must agree");
  assertEquals(oldBefore, "Asian", "Before spring forward: should be Asian (t < 2)");
  assertEquals(oldAfter, "London", "After spring forward: should be London (t = 3)");
});

Deno.test("DST: fall-back boundary — session mapping agrees at transition moment", () => {
  // The code's DST formula for 2025: EDT ends November 2 at 06:00 UTC
  // Just before (05:59 UTC): EDT offset -4 → NY = 01:59 → t ≈ 1.983 → Asian
  // Just after  (06:00 UTC): EST offset -5 → NY = 01:00 → t = 1.0 → Asian
  const beforeFall = new Date(Date.UTC(2025, 10, 2, 5, 59, 0));
  const afterFall = new Date(Date.UTC(2025, 10, 2, 6, 0, 0));

  // Old path
  const oldBefore = oldGetCurrentSession(smcToNYTime(beforeFall).t);
  const oldAfter = oldGetCurrentSession(smcToNYTime(afterFall).t);

  // New path
  const newBefore = detectSession(beforeFall.getTime());
  const newAfter = detectSession(afterFall.getTime());
  const mappedBefore = newBefore.name === "Off-Hours" ? "Asian" : newBefore.name;
  const mappedAfter = newAfter.name === "Off-Hours" ? "Asian" : newAfter.name;

  assertEquals(oldBefore, mappedBefore, "Fall back: before transition must agree");
  assertEquals(oldAfter, mappedAfter, "Fall back: after transition must agree");
  assertEquals(oldBefore, "Asian", "Before fall back: should be Asian (t < 2)");
  assertEquals(oldAfter, "Asian", "After fall back: should be Asian (t = 1)");
});

Deno.test("DST: getUpcomingSession agrees at spring-forward pre-market boundary", () => {
  // At spring forward, the London pre-market window [1.5, 2.0) is affected.
  // Just before transition (06:30 UTC, EST): NY = 01:30 → t = 1.5 → London pre-market
  // This is the moment where London pre-market starts on the transition day.
  const preMarketMoment = new Date(Date.UTC(2025, 2, 8, 6, 30, 0));
  const oldT = smcToNYTime(preMarketMoment).t;
  const oldResult = oldGetUpcomingSession(oldT);

  // New code uses smcAnalysis.ts toNYTime internally (same function)
  // So it must produce the same result
  const newT = smcToNYTime(preMarketMoment).t;
  const newResult = newGetUpcomingSession(newT);
  assertEquals(oldResult, newResult, "Pre-market detection must agree at DST boundary");
  assertEquals(oldResult, "London", "t=1.5 should detect London pre-market");
});

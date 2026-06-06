import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  detectICTWindow,
  evaluateICTKillZone,
  DEFAULT_ICT_KILLZONE_CONFIG,
  type ICTKillZoneConfig,
} from "./ictKillZones.ts";

// ─── Test Helpers ─────────────────────────────────────────────────────

/**
 * Create a Date at a specific NY time (accounting for UTC offset).
 * During DST (Mar-Nov): NY = UTC-4
 * Outside DST (Nov-Mar): NY = UTC-5
 */
function nyTime(hour: number, minute: number = 0, isDST: boolean = true): Date {
  const offset = isDST ? 4 : 5;
  const utcHour = hour + offset;
  // Use a date in June (DST) or January (no DST)
  const month = isDST ? 5 : 0; // June or January
  return new Date(Date.UTC(2024, month, 15, utcHour, minute, 0));
}

// ─── Tests: Window Detection ──────────────────────────────────────────

Deno.test("detectICTWindow: London Kill Zone (02:00-05:00 NY)", () => {
  const result = detectICTWindow(nyTime(2, 30));
  assertEquals(result.window, "london_kz");
  assertEquals(result.isKillZone, true);
  assertEquals(result.isPrime, true);
  assertEquals(result.isDeadZone, false);
});

Deno.test("detectICTWindow: London Silver Bullet (03:00-04:00 NY)", () => {
  const result = detectICTWindow(nyTime(3, 30));
  assertEquals(result.window, "silver_bullet_london");
  assertEquals(result.isKillZone, true);
  assertEquals(result.isSilverBullet, true);
  assertEquals(result.isPrime, true);
});

Deno.test("detectICTWindow: NY Kill Zone (08:30-11:00 NY)", () => {
  const result = detectICTWindow(nyTime(9, 0));
  assertEquals(result.window, "ny_kz");
  assertEquals(result.isKillZone, true);
  assertEquals(result.isPrime, true);
});

Deno.test("detectICTWindow: NY Silver Bullet (10:00-11:00 NY)", () => {
  const result = detectICTWindow(nyTime(10, 30));
  assertEquals(result.window, "silver_bullet_ny");
  assertEquals(result.isKillZone, true);
  assertEquals(result.isSilverBullet, true);
  assertEquals(result.isPrime, true);
});

Deno.test("detectICTWindow: PM Silver Bullet (14:00-15:00 NY)", () => {
  const result = detectICTWindow(nyTime(14, 30));
  assertEquals(result.window, "silver_bullet_pm");
  assertEquals(result.isKillZone, true);
  assertEquals(result.isSilverBullet, true);
  assertEquals(result.isPrime, false); // PM SB is not prime
});

Deno.test("detectICTWindow: PM Session (13:30-16:00 NY)", () => {
  const result = detectICTWindow(nyTime(15, 30)); // After PM SB
  assertEquals(result.window, "pm_session");
  assertEquals(result.isKillZone, true);
  assertEquals(result.isPrime, false);
});

Deno.test("detectICTWindow: Lunch Dead Zone (12:00-13:30 NY)", () => {
  const result = detectICTWindow(nyTime(12, 30));
  assertEquals(result.window, "lunch_dead");
  assertEquals(result.isKillZone, false);
  assertEquals(result.isDeadZone, true);
});

Deno.test("detectICTWindow: Asian Dead Zone (18:00-02:00 NY)", () => {
  const result = detectICTWindow(nyTime(20, 0));
  assertEquals(result.window, "asian_dead");
  assertEquals(result.isKillZone, false);
  assertEquals(result.isDeadZone, true);
});

Deno.test("detectICTWindow: Off hours (05:00-08:30 NY)", () => {
  const result = detectICTWindow(nyTime(6, 0));
  assertEquals(result.window, "off_hours");
  assertEquals(result.isKillZone, false);
  assertEquals(result.isDeadZone, false);
});

// ─── Tests: Gate Evaluation ───────────────────────────────────────────

Deno.test("evaluateICTKillZone: prime KZ gives bonus in soft mode", () => {
  const config: ICTKillZoneConfig = { ...DEFAULT_ICT_KILLZONE_CONFIG, gateMode: "soft" };
  const result = evaluateICTKillZone(nyTime(9, 30), config);

  assertEquals(result.passed, true);
  assertEquals(result.isPrime, true);
  assertEquals(result.scoreAdjustment, config.primeKZBonus);
});

Deno.test("evaluateICTKillZone: dead zone blocked in hard mode", () => {
  const config: ICTKillZoneConfig = { ...DEFAULT_ICT_KILLZONE_CONFIG, gateMode: "hard" };
  const result = evaluateICTKillZone(nyTime(12, 30), config);

  assertEquals(result.passed, false);
  assertEquals(result.isDeadZone, true);
  assertEquals(result.reason.includes("DEAD ZONE"), true);
});

Deno.test("evaluateICTKillZone: dead zone penalized in soft mode", () => {
  const config: ICTKillZoneConfig = { ...DEFAULT_ICT_KILLZONE_CONFIG, gateMode: "soft" };
  const result = evaluateICTKillZone(nyTime(12, 30), config);

  assertEquals(result.passed, true);
  assertEquals(result.scoreAdjustment, config.deadZonePenalty);
});

Deno.test("evaluateICTKillZone: off hours blocked in hard mode", () => {
  const config: ICTKillZoneConfig = { ...DEFAULT_ICT_KILLZONE_CONFIG, gateMode: "hard" };
  const result = evaluateICTKillZone(nyTime(6, 0), config);

  assertEquals(result.passed, false);
  assertEquals(result.reason.includes("Outside ICT Kill Zone"), true);
});

Deno.test("evaluateICTKillZone: off mode always passes", () => {
  const config: ICTKillZoneConfig = { ...DEFAULT_ICT_KILLZONE_CONFIG, gateMode: "off" };
  const result = evaluateICTKillZone(nyTime(12, 30), config);

  assertEquals(result.passed, true);
  assertEquals(result.scoreAdjustment, 0);
  assertEquals(result.reason.includes("[OFF]"), true);
});

Deno.test("evaluateICTKillZone: disabled config always passes", () => {
  const config: ICTKillZoneConfig = { ...DEFAULT_ICT_KILLZONE_CONFIG, enabled: false, gateMode: "hard" };
  const result = evaluateICTKillZone(nyTime(12, 30), config);

  assertEquals(result.passed, true);
});

Deno.test("evaluateICTKillZone: PM session disabled blocks PM entries", () => {
  const config: ICTKillZoneConfig = { ...DEFAULT_ICT_KILLZONE_CONFIG, gateMode: "hard", enablePMSession: false };
  const result = evaluateICTKillZone(nyTime(15, 30), config);

  assertEquals(result.passed, false);
});

Deno.test("evaluateICTKillZone: Silver Bullet disabled still allows London KZ", () => {
  const config: ICTKillZoneConfig = { ...DEFAULT_ICT_KILLZONE_CONFIG, gateMode: "hard", enableSilverBullet: false };
  // 02:30 is London KZ but not Silver Bullet
  const result = evaluateICTKillZone(nyTime(2, 30), config);

  assertEquals(result.passed, true);
  assertEquals(result.isKillZone, true);
});

Deno.test("evaluateICTKillZone: non-DST time calculation works", () => {
  // January (no DST), 9:00 NY = 14:00 UTC
  const result = detectICTWindow(nyTime(9, 0, false));
  assertEquals(result.window, "ny_kz");
  assertEquals(result.isKillZone, true);
});

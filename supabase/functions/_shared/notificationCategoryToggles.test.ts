/**
 * Tests for Telegram notification category toggle logic.
 * Verifies that the shouldNotify helper correctly reads telegramNotifyCategories
 * from preferences_json and respects the default-ON, explicit-OFF pattern.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Replicate the exact logic used in bot-scanner/index.ts
function shouldNotify(
  prefs: Record<string, any>,
  category: string
): boolean {
  const notifyCategories: Record<string, boolean> = prefs.telegramNotifyCategories || {};
  return notifyCategories[category] !== false;
}

// All notification categories defined in the UI
const ALL_CATEGORIES = [
  "trade_opened",
  "zone_setup_active",
  "zone_touched",
  "confirmed_entry",
  "trade_closed",
  "trade_management",
  "thesis_invalidated",
  "prop_firm_alert",
  "daily_review",
  "weekly_advisor",
  "gate_effectiveness",
  "game_plan",
] as const;

Deno.test("shouldNotify — all categories default to true when telegramNotifyCategories is missing", () => {
  const prefs = {}; // No telegramNotifyCategories field
  for (const cat of ALL_CATEGORIES) {
    assertEquals(shouldNotify(prefs, cat), true, `Expected ${cat} to default to true`);
  }
});

Deno.test("shouldNotify — all categories default to true when telegramNotifyCategories is empty object", () => {
  const prefs = { telegramNotifyCategories: {} };
  for (const cat of ALL_CATEGORIES) {
    assertEquals(shouldNotify(prefs, cat), true, `Expected ${cat} to default to true`);
  }
});

Deno.test("shouldNotify — explicitly disabled category returns false", () => {
  const prefs = {
    telegramNotifyCategories: {
      trade_opened: false,
      zone_touched: false,
    },
  };
  assertEquals(shouldNotify(prefs, "trade_opened"), false);
  assertEquals(shouldNotify(prefs, "zone_touched"), false);
  // Others still default to true
  assertEquals(shouldNotify(prefs, "trade_closed"), true);
  assertEquals(shouldNotify(prefs, "confirmed_entry"), true);
});

Deno.test("shouldNotify — explicitly enabled category returns true", () => {
  const prefs = {
    telegramNotifyCategories: {
      trade_opened: true,
      prop_firm_alert: true,
    },
  };
  assertEquals(shouldNotify(prefs, "trade_opened"), true);
  assertEquals(shouldNotify(prefs, "prop_firm_alert"), true);
});

Deno.test("shouldNotify — toggle all OFF disables every category", () => {
  const allOff: Record<string, boolean> = {};
  for (const cat of ALL_CATEGORIES) {
    allOff[cat] = false;
  }
  const prefs = { telegramNotifyCategories: allOff };
  for (const cat of ALL_CATEGORIES) {
    assertEquals(shouldNotify(prefs, cat), false, `Expected ${cat} to be false when toggled off`);
  }
});

Deno.test("shouldNotify — toggle all ON enables every category", () => {
  const allOn: Record<string, boolean> = {};
  for (const cat of ALL_CATEGORIES) {
    allOn[cat] = true;
  }
  const prefs = { telegramNotifyCategories: allOn };
  for (const cat of ALL_CATEGORIES) {
    assertEquals(shouldNotify(prefs, cat), true, `Expected ${cat} to be true when toggled on`);
  }
});

Deno.test("shouldNotify — mixed toggles respected correctly", () => {
  const prefs = {
    telegramNotifyCategories: {
      trade_opened: true,
      zone_setup_active: false,
      zone_touched: true,
      confirmed_entry: false,
      trade_closed: true,
      trade_management: false,
      thesis_invalidated: true,
      prop_firm_alert: true, // Never disable this in practice, but test it
      daily_review: false,
      weekly_advisor: false,
      gate_effectiveness: true,
      game_plan: false,
    },
  };
  assertEquals(shouldNotify(prefs, "trade_opened"), true);
  assertEquals(shouldNotify(prefs, "zone_setup_active"), false);
  assertEquals(shouldNotify(prefs, "zone_touched"), true);
  assertEquals(shouldNotify(prefs, "confirmed_entry"), false);
  assertEquals(shouldNotify(prefs, "trade_closed"), true);
  assertEquals(shouldNotify(prefs, "trade_management"), false);
  assertEquals(shouldNotify(prefs, "thesis_invalidated"), true);
  assertEquals(shouldNotify(prefs, "prop_firm_alert"), true);
  assertEquals(shouldNotify(prefs, "daily_review"), false);
  assertEquals(shouldNotify(prefs, "weekly_advisor"), false);
  assertEquals(shouldNotify(prefs, "gate_effectiveness"), true);
  assertEquals(shouldNotify(prefs, "game_plan"), false);
});

Deno.test("shouldNotify — unknown category defaults to true (forward-compatible)", () => {
  const prefs = { telegramNotifyCategories: { trade_opened: false } };
  // A future category that doesn't exist yet should default to true
  assertEquals(shouldNotify(prefs, "some_future_category"), true);
});

Deno.test("shouldNotify — null/undefined in telegramNotifyCategories treated as enabled", () => {
  const prefs = {
    telegramNotifyCategories: {
      trade_opened: null,
      zone_touched: undefined,
    } as any,
  };
  // null !== false → true; undefined !== false → true
  assertEquals(shouldNotify(prefs, "trade_opened"), true);
  assertEquals(shouldNotify(prefs, "zone_touched"), true);
});

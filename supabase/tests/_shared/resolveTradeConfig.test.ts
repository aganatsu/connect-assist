import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractGlobalExitConfig,
  parseTradeOverrides,
  resolveTradeConfig,
  type ResolvedTradeConfig,
} from "./resolveTradeConfig.ts";

// ─── extractGlobalExitConfig ────────────────────────────────────────

Deno.test("extractGlobalExitConfig — extracts from nested exit object", () => {
  const configJson = {
    exit: {
      breakEvenEnabled: true,
      breakEvenPips: 25,
      breakEvenOffsetPips: 2,
      trailingStopEnabled: true,
      trailingStopPips: 12,
      trailingStopActivation: "after_0.5r",
      partialTPEnabled: true,
      partialTPPercent: 60,
      partialTPLevel: 1.5,
      maxHoldEnabled: true,
      maxHoldHours: 72,
    },
  };
  const result = extractGlobalExitConfig(configJson);
  assertEquals(result.breakEvenEnabled, true);
  assertEquals(result.breakEvenPips, 25);
  assertEquals(result.breakEvenOffsetPips, 2);
  assertEquals(result.trailingStopEnabled, true);
  assertEquals(result.trailingStopPips, 12);
  assertEquals(result.trailingStopActivation, "after_0.5r");
  assertEquals(result.partialTPEnabled, true);
  assertEquals(result.partialTPPercent, 60);
  assertEquals(result.partialTPLevel, 1.5);
  assertEquals(result.maxHoldEnabled, true);
  assertEquals(result.maxHoldHours, 72);
});

Deno.test("extractGlobalExitConfig — falls back to top-level keys", () => {
  const configJson = {
    breakEvenEnabled: false,
    breakEvenPips: 30,
    trailingStopEnabled: true,
    trailingStopPips: 20,
    trailingStopActivation: "after_2r",
  };
  const result = extractGlobalExitConfig(configJson);
  assertEquals(result.breakEvenEnabled, false);
  assertEquals(result.breakEvenPips, 30);
  assertEquals(result.trailingStopEnabled, true);
  assertEquals(result.trailingStopPips, 20);
  assertEquals(result.trailingStopActivation, "after_2r");
});

Deno.test("extractGlobalExitConfig — uses defaults for empty config", () => {
  const result = extractGlobalExitConfig({});
  assertEquals(result.breakEvenEnabled, true); // default is true
  assertEquals(result.breakEvenPips, 20);
  assertEquals(result.breakEvenOffsetPips, 3);
  assertEquals(result.trailingStopEnabled, false);
  assertEquals(result.trailingStopPips, 15);
  assertEquals(result.trailingStopActivation, "after_1r");
  assertEquals(result.partialTPEnabled, false);
  assertEquals(result.partialTPPercent, 50);
  assertEquals(result.partialTPLevel, 1.0);
  assertEquals(result.maxHoldEnabled, false);
  assertEquals(result.maxHoldHours, 0);
});

Deno.test("extractGlobalExitConfig — handles null/undefined input", () => {
  const result = extractGlobalExitConfig(null);
  assertEquals(result.breakEvenEnabled, true);
  assertEquals(result.breakEvenPips, 20);
});

// ─── parseTradeOverrides ────────────────────────────────────────────

Deno.test("parseTradeOverrides — returns null for null/undefined/empty", () => {
  assertEquals(parseTradeOverrides(null), null);
  assertEquals(parseTradeOverrides(undefined), null);
  assertEquals(parseTradeOverrides(""), null);
  assertEquals(parseTradeOverrides("{}"), null);
  assertEquals(parseTradeOverrides({}), null);
});

Deno.test("parseTradeOverrides — parses JSON string", () => {
  const raw = JSON.stringify({ breakEvenEnabled: false, trailingStopPips: 10 });
  const result = parseTradeOverrides(raw);
  assertEquals(result?.breakEvenEnabled, false);
  assertEquals(result?.trailingStopPips, 10);
});

Deno.test("parseTradeOverrides — handles object directly", () => {
  const raw = { partialTPEnabled: true, partialTPPercent: 75 };
  const result = parseTradeOverrides(raw);
  assertEquals(result?.partialTPEnabled, true);
  assertEquals(result?.partialTPPercent, 75);
});

Deno.test("parseTradeOverrides — returns null for invalid JSON", () => {
  assertEquals(parseTradeOverrides("not json"), null);
  assertEquals(parseTradeOverrides("{broken"), null);
});

// ─── resolveTradeConfig ─────────────────────────────────────────────

Deno.test("resolveTradeConfig — returns global config when no overrides", () => {
  const global: ResolvedTradeConfig = {
    breakEvenEnabled: true,
    breakEvenPips: 20,
    breakEvenOffsetPips: 3,
    trailingStopEnabled: false,
    trailingStopPips: 15,
    trailingStopActivation: "after_1r",
    partialTPEnabled: false,
    partialTPPercent: 50,
    partialTPLevel: 1.0,
    maxHoldEnabled: false,
    maxHoldHours: 0,
  };
  const result = resolveTradeConfig(global, null);
  assertEquals(result, global);
});

Deno.test("resolveTradeConfig — overrides specific fields only", () => {
  const global: ResolvedTradeConfig = {
    breakEvenEnabled: true,
    breakEvenPips: 20,
    breakEvenOffsetPips: 3,
    trailingStopEnabled: false,
    trailingStopPips: 15,
    trailingStopActivation: "after_1r",
    partialTPEnabled: false,
    partialTPPercent: 50,
    partialTPLevel: 1.0,
    maxHoldEnabled: false,
    maxHoldHours: 0,
  };
  const overrides = { trailingStopEnabled: true, trailingStopPips: 10, trailingStopActivation: "after_0.5r" };
  const result = resolveTradeConfig(global, overrides);
  // Overridden fields
  assertEquals(result.trailingStopEnabled, true);
  assertEquals(result.trailingStopPips, 10);
  assertEquals(result.trailingStopActivation, "after_0.5r");
  // Non-overridden fields remain from global
  assertEquals(result.breakEvenEnabled, true);
  assertEquals(result.breakEvenPips, 20);
  assertEquals(result.partialTPEnabled, false);
  assertEquals(result.maxHoldEnabled, false);
});

Deno.test("resolveTradeConfig — override can disable a globally-enabled feature", () => {
  const global: ResolvedTradeConfig = {
    breakEvenEnabled: true,
    breakEvenPips: 20,
    breakEvenOffsetPips: 3,
    trailingStopEnabled: true,
    trailingStopPips: 15,
    trailingStopActivation: "after_1r",
    partialTPEnabled: true,
    partialTPPercent: 50,
    partialTPLevel: 1.5,
    maxHoldEnabled: true,
    maxHoldHours: 48,
  };
  const overrides = { breakEvenEnabled: false, maxHoldEnabled: false };
  const result = resolveTradeConfig(global, overrides);
  assertEquals(result.breakEvenEnabled, false);
  assertEquals(result.maxHoldEnabled, false);
  // Other fields untouched
  assertEquals(result.trailingStopEnabled, true);
  assertEquals(result.partialTPEnabled, true);
});

Deno.test("resolveTradeConfig — full override replaces all fields", () => {
  const global: ResolvedTradeConfig = {
    breakEvenEnabled: true,
    breakEvenPips: 20,
    breakEvenOffsetPips: 3,
    trailingStopEnabled: false,
    trailingStopPips: 15,
    trailingStopActivation: "after_1r",
    partialTPEnabled: false,
    partialTPPercent: 50,
    partialTPLevel: 1.0,
    maxHoldEnabled: false,
    maxHoldHours: 0,
  };
  const overrides = {
    breakEvenEnabled: false,
    breakEvenPips: 30,
    breakEvenOffsetPips: 5,
    trailingStopEnabled: true,
    trailingStopPips: 8,
    trailingStopActivation: "immediate",
    partialTPEnabled: true,
    partialTPPercent: 40,
    partialTPLevel: 2.0,
    maxHoldEnabled: true,
    maxHoldHours: 24,
  };
  const result = resolveTradeConfig(global, overrides);
  assertEquals(result.breakEvenEnabled, false);
  assertEquals(result.breakEvenPips, 30);
  assertEquals(result.breakEvenOffsetPips, 5);
  assertEquals(result.trailingStopEnabled, true);
  assertEquals(result.trailingStopPips, 8);
  assertEquals(result.trailingStopActivation, "immediate");
  assertEquals(result.partialTPEnabled, true);
  assertEquals(result.partialTPPercent, 40);
  assertEquals(result.partialTPLevel, 2.0);
  assertEquals(result.maxHoldEnabled, true);
  assertEquals(result.maxHoldHours, 24);
});

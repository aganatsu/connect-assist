/**
 * STEP 14 — explicit config: no hidden style / default / mapper overrides.
 *
 *  - switches: styleOverridesMode, marketEntriesEnabled (legacy defaults);
 *  - one risk-percent owner (0.5% under fill-time sizing);
 *  - the mapper passes through what the UI writes (Game Plan keys, timeframes,
 *    Gate 14 pause, structure invalidation) instead of dropping it;
 *  - the approved patch (docs/step14_config_patch.json) produces the frozen
 *    effective config with style overrides off — UI, stored and runtime agree;
 *  - wiring: the style writes nothing when off, the hunt confirms on the
 *    resolved timeframe, market entries are refused, every risk use reads the
 *    single owner, Gate 14's pause comes from config.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { effectiveRiskPercent, LEGACY_SWITCHES, resolveSimplification } from "../../functions/_shared/simplification.ts";
import { resolveConfirmationTimeframe, styleConfirmationTimeframe } from "../../functions/_shared/styleTimeframes.ts";
import { applyPairOverrides, mapNestedToFlat } from "../../functions/_shared/configMapper.ts";

const PATCH: Record<string, unknown> = JSON.parse(Deno.readTextFileSync(new URL("../../../docs/step14_config_patch.json", import.meta.url))).set;

function applyPatch(base: Record<string, any>, patch: Record<string, unknown>) {
  const out = JSON.parse(JSON.stringify(base));
  for (const [path, value] of Object.entries(patch)) {
    const parts = path.split(".");
    let cur = out;
    for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {});
    cur[parts.at(-1)!] = value;
  }
  return out;
}

// The live config's relevant shape before step 14 (2026-10-07, hash e3eb2e67).
const LIVE_BEFORE = {
  tradingStyle: { mode: "scalper" },
  gamePlanEnabled: false,
  strategy: { confluenceThreshold: 20, zoneEntryDepth: 0.55, ictFVGInvalidationGateMode: "off" },
  entry: { scanIntervalMinutes: 5, cooldownMinutes: 5, marketFillAtZone: false, closeOnReverse: false, limitOrderExpiryMinutes: 480 },
  exit: { tpRRRatio: 1.1, maxHoldEnabled: false, maxHoldHours: 0, breakEven: false, breakEvenEnabled: false, trailingStop: false, trailingStopEnabled: false, partialTP: false, partialTPEnabled: false, stopLossMethod: "structure", takeProfitMethod: "rr_ratio" },
  risk: { riskPerTrade: 1, maxConcurrentTrades: 7, maxOpenPositions: 3, maxPositionsPerSymbol: 3, minRR: 1, minRiskReward: 1.5, conflictBlockAt: 3, allowSameDirectionStacking: false, maxPortfolioHeat: 5 },
  protection: { maxConsecutiveLosses: 6, maxDailyLoss: 3000, circuitBreakerPct: 20 },
  instruments: { enabled: ["EUR/USD", "GBP/USD", "USD/JPY", "CHF/JPY", "NZD/CAD", "NZD/CHF"], correlationFilterEnabled: true, maxCorrelatedPositions: 2, maxCorrelation: 0.75, allowedInstruments: { "EUR/USD": true, "GBP/USD": false, "USD/JPY": false } },
  pairGateOverrides: { "AUD/USD": { zoneEntryDepth: 0.5 }, "EUR/USD": { zoneEntryDepth: 0.5 } },
  simplification: { sizingMode: "fill_time", riskPercent: 0.5, maxLotsPerTrade: 20, stopAnchor: "limit", secondPollerEnabled: false, capsMode: "unified", maxOpenPositions: 3, maxPerSymbol: 1, dryRunWhenLocked: true },
};
const AFTER = applyPatch(LIVE_BEFORE, PATCH);

// ─── switches and owners ────────────────────────────────────────────────────

Deno.test("step 14 switches default to legacy and resolve only exact values", () => {
  assertEquals([LEGACY_SWITCHES.styleOverridesMode, LEGACY_SWITCHES.marketEntriesEnabled], ["legacy", true]);
  assertEquals(resolveSimplification({ simplification: { styleOverridesMode: "OFF", marketEntriesEnabled: "no" } }).styleOverridesMode, "legacy");
  assertEquals(resolveSimplification({ simplification: { marketEntriesEnabled: "no" } }).marketEntriesEnabled, true);
  const s = resolveSimplification(AFTER);
  assertEquals([s.styleOverridesMode, s.marketEntriesEnabled], ["off", false]);
});

Deno.test("one risk-percent owner: 0.5% under fill-time sizing, legacy riskPerTrade otherwise", () => {
  assertEquals(effectiveRiskPercent(resolveSimplification(AFTER), 1), 0.5);
  assertEquals(effectiveRiskPercent(resolveSimplification(LIVE_BEFORE), 1), 0.5, "already fill_time: no 1% path even with riskPerTrade 1");
  assertEquals(effectiveRiskPercent(resolveSimplification({}), 1), 1, "legacy accounts unchanged");
});

Deno.test("confirmation timeframe: explicit only when overrides are off and the value is valid", () => {
  assertEquals(resolveConfirmationTimeframe("scalper", "15m", "legacy"), "5m");
  assertEquals(resolveConfirmationTimeframe("scalper", "15m", "off"), "15m");
  assertEquals(resolveConfirmationTimeframe("scalper", "7m", "off"), "5m");
  assertEquals(resolveConfirmationTimeframe("scalper", undefined, "off"), "5m");
  assertEquals(resolveConfirmationTimeframe("scalper", PATCH["strategy.confirmationTimeframe"], "off"), styleConfirmationTimeframe("scalper"));
});

// ─── mapper pass-through ────────────────────────────────────────────────────

Deno.test("mapper: the UI's top-level Game Plan keys reach the scanner (were dropped → always on)", () => {
  const off = mapNestedToFlat({ gamePlanEnabled: false, dolTPExtensionEnabled: false, ipdaRangesEnabled: false, gamePlanNotify: false, gamePlanRefreshHours: 6 }) as any;
  assertEquals([off.gamePlanEnabled, off.dolTPExtensionEnabled, off.ipdaRangesEnabled, off.gamePlanNotify, off.gamePlanRefreshHours], [false, false, false, false, 6]);
  const absent = mapNestedToFlat({}) as any;
  assertEquals([absent.gamePlanEnabled, absent.dolTPExtensionEnabled, absent.ipdaRangesEnabled], [true, true, true], "absent keeps today's runtime default");
});

Deno.test("mapper: the UI's instruments.* correlation settings reach the gate (were ignored → defaults on / 2 / 0.8)", () => {
  const f = mapNestedToFlat({ instruments: { correlationFilterEnabled: false, maxCorrelatedPositions: 1, maxCorrelation: 0.75 } }) as any;
  assertEquals([f.correlationFilterEnabled, f.maxCorrelatedPositions, f.maxCorrelation], [false, 1, 0.75]);
  const d = mapNestedToFlat({}) as any;
  assertEquals([d.correlationFilterEnabled, d.maxCorrelatedPositions, d.maxCorrelation], [true, 2, 0.8], "absent keeps today's runtime values");
  // today's stored config (0.75 shown) ran at 0.8; the patch stores 0.8 so nothing changes
  assertEquals((mapNestedToFlat(LIVE_BEFORE) as any).maxCorrelation, 0.75, "after this fix the stored 0.75 would apply…");
  assertEquals(PATCH["instruments.maxCorrelation"], 0.8, "…so the patch writes the runtime value 0.8");
});

Deno.test("mapper: timeframes, Gate 14 pause and structure invalidation are configurable", () => {
  const f = mapNestedToFlat({ strategy: { entryTimeframe: "5m", htfTimeframe: "1h", confirmationTimeframe: "5m" }, protection: { consecutiveLossPauseHours: 6 }, exit: { structureInvalidationEnabled: true } }) as any;
  assertEquals([f.entryTimeframe, f.htfTimeframe, f.confirmationTimeframe, f.consecutiveLossPauseHours, f.structureInvalidationEnabled], ["5m", "1h", "5m", 6, true]);
  const d = mapNestedToFlat({}) as any;
  assertEquals([d.confirmationTimeframe, d.consecutiveLossPauseHours, d.structureInvalidationEnabled], [null, 4, false]);
});

// ─── the approved patch → frozen effective config ───────────────────────────

Deno.test("patched config, style overrides off: every effective value is explicit and matches the frozen baseline", () => {
  const f = mapNestedToFlat(AFTER) as any;
  const eu = applyPairOverrides({ ...f }, "EUR/USD") as any;
  const gb = applyPairOverrides({ ...f }, "GBP/USD") as any;
  const expect: Record<string, unknown> = {
    // were style-forced; now stored, same values
    entryTimeframe: "5m", htfTimeframe: "1h", confirmationTimeframe: "5m", impulseSlCapMultiplier: 1.5, slBufferPips: 1, scanIntervalMinutes: 5,
    // frozen management: all off, explicitly
    maxHoldEnabled: false, maxHoldHours: 0, breakEvenEnabled: false, trailingStopEnabled: false, partialTPEnabled: false, structureInvalidationEnabled: false,
    // target / risk
    tpRatio: 1.1, riskPerTrade: 0.5, minRiskReward: 1,
    // routes and gates
    impulseZoneGateMode: "hard", ictRiskEnabled: false, marketFillAtZone: false,
    // Game Plan kept on explicitly; its TP extension off
    gamePlanEnabled: true, dolTPExtensionEnabled: false, ipdaRangesEnabled: true,
    // decision D: explicit rules
    correlationFilterEnabled: true, maxCorrelatedPositions: 2, maxCorrelation: 0.8, // runtime was 0.8 (key never mapped); kept, now explicit
    maxConsecutiveLosses: 6, consecutiveLossPauseHours: 4, cooldownMinutes: 5, conflictBlockAt: 3,
    // UI caps fields agree with the unified caps
    maxOpenPositions: 3, maxPerSymbol: 1,
  };
  for (const [k, v] of Object.entries(expect)) assertEquals(f[k], v, k);
  assertEquals(eu.zoneEntryDepth, 0.5, "decision C: EUR/USD keeps 0.50, explicitly");
  assertEquals(gb.zoneEntryDepth, 0.55);
  assertEquals(f.instruments, ["EUR/USD", "GBP/USD", "USD/JPY", "CHF/JPY", "NZD/CAD", "NZD/CHF"]);
});

Deno.test("backtests read the same six FX pairs as live", () => {
  const allowed = Object.entries(AFTER.instruments.allowedInstruments).filter(([, on]) => on).map(([s]) => s).sort();
  assertEquals(allowed, [...AFTER.instruments.enabled].sort());
});

Deno.test("the explicit timeframes equal the scalper profile the style still declares", () => {
  const src = Deno.readTextFileSync(new URL("../../functions/bot-scanner/index.ts", import.meta.url));
  const i = src.indexOf("  scalper: {", src.indexOf("const STYLE_OVERRIDES"));
  const block = src.slice(i, src.indexOf("\n  },", i));
  assert(block.includes('entryTimeframe: "5m"') && block.includes('htfTimeframe: "1h"'), "scalper profile is 5m / 1h");
  assertEquals([PATCH["strategy.entryTimeframe"], PATCH["strategy.htfTimeframe"]], ["5m", "1h"]);
  // what the style used to force is now stored with the same value
  assert(block.includes("impulseSlCapMultiplier: 1.5") && block.includes("slBufferPips: 1,"));
  assertEquals([PATCH["strategy.impulseSlCapMultiplier"], PATCH["entry.slBufferPips"]], [1.5, 1]);
});

// ─── wiring (source) ────────────────────────────────────────────────────────

const scanner = Deno.readTextFileSync(new URL("../../functions/bot-scanner/index.ts", import.meta.url));

Deno.test("style overrides off: the style loop is skipped and the interval comes from config", () => {
  assert(scanner.includes('const styleOverridesMode = resolveSimplification((config as any).__rawConfigJson).styleOverridesMode;'));
  assert(/const intervalMinutes = styleOverridesMode === "off"\n\s+\? \(config\.scanIntervalMinutes \?\? 15\)/.test(scanner));
  const off = scanner.indexOf('if (styleOverridesMode === "off") {');
  const legacy = scanner.indexOf("} else if (STYLE_OVERRIDES[resolvedStyle]) {");
  const loop = scanner.indexOf("for (const [key, val] of Object.entries(styleDefaults)) {");
  assert(off > 0 && legacy > off && loop > legacy, "the writing loop is only in the legacy branch");
  assert(!/\(config as any\)\[key\] = val;/.test(scanner.slice(off, legacy)), "nothing is written when off");
});

Deno.test("the hunt confirms on the resolved timeframe (no direct style lookup left)", () => {
  assert(scanner.includes("const confirmationTF = resolveConfirmationTimeframe(resolvedStyle, (config as any).confirmationTimeframe, styleOverridesMode);"));
  assert(scanner.includes("confirmationMinObservationUntil(nowStr, confirmationTF)"));
  assert(scanner.includes("const confirmTF = confirmationTF;"));
  assert(!/styleConfirmationTimeframe\(resolvedStyle\)\)/.test(scanner.replace(/confirmationTF !== styleConfirmationTimeframe\(resolvedStyle\)/g, "")), "no other direct lookup");
});

Deno.test("market entries are refused before the dry-run guard and before any market insert", () => {
  const g = scanner.indexOf("if (!simp.marketEntriesEnabled && !(effectiveLimitEnabled && limitEntry)) {");
  const dry = scanner.indexOf("if (dryRunActive && !(effectiveLimitEnabled && limitEntry)) {");
  const insert = scanner.indexOf('await supabase.from("paper_positions").insert({');
  assert(g > 0 && dry > g && insert > dry);
  assert(/detail\.status = "market_entry_disabled";[\s\S]{0,300}continue;/.test(scanner.slice(g, g + 500)));
  // the only market insert in bot-scanner is after the guard
  assertEquals(scanner.split('from("paper_positions").insert(').length - 1, 1);
});

Deno.test("every risk-percent use reads the single owner", () => {
  assert(scanner.includes("const pairRiskPercent = effectiveRiskPercent(simp, pairConfig.riskPerTrade);"));
  assert(!/riskPercent: pairConfig\.riskPerTrade/.test(scanner), "no sizing/record reads riskPerTrade directly");
  assert(!/Math\.min\(pairConfig\.riskPerTrade/.test(scanner), "broker mirror uses the owner too");
  assert(scanner.includes("effectiveRiskPercent(resolveSimplification((config as any).__rawConfigJson), config.riskPerTrade) / 100"), "heat-gate fallback");
  assertEquals((scanner.match(/riskPercent: pairRiskPercent/g) ?? []).length, 5);
});

Deno.test("Gate 14 pause comes from config; ICT risk is still gated by its own flag", () => {
  assert(scanner.includes("const resetHours = Number((config as any).consecutiveLossPauseHours) > 0 ? Number((config as any).consecutiveLossPauseHours) : 4;"));
  assert(scanner.includes("if (pairConfig.ictRiskEnabled) {"));
  assertEquals(PATCH["strategy.ictRiskEnabled"], false);
});

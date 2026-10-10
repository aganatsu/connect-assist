/**
 * Runs the Candidate C placement hook — the EXACT source block from
 * bot-scanner/index.ts, sliced between its markers — against a controlled
 * scope. The scanner's pair loop only reaches the hook on a live Route 2
 * signal, which synthetic candles cannot produce, so this executes the hook's
 * own code directly. Every scope object is deep-frozen: any write to A's
 * state throws inside the hook (strict mode) and the intent is not produced.
 */
import * as shadow from "../../functions/_shared/shadowZoneMid.ts";
import { calculateATR, SPECS } from "../../functions/_shared/smcAnalysis.ts";
import { computePositionSize } from "../../functions/_shared/unifiedPositionSizing.ts";
import {
  buildRoute2OrderTelemetry, locatePoiFormation, pendingDistanceAtr, ROUTE2_TTL_MINUTES, route2ExpiresAt, zoneId as route2ZoneId,
} from "../../functions/_shared/route2Forward.ts";
import { buildFrozenDecision } from "../../functions/_shared/frozenDecision.ts";
import { buildAttribution } from "../../functions/_shared/attribution.ts";
import { resolvePositionCaps } from "../../functions/_shared/positionCaps.ts";
import { resolveSimplification } from "../../functions/_shared/simplification.ts";
import { mapNestedToFlat } from "../../functions/_shared/configMapper.ts";

const scanner = Deno.readTextFileSync(new URL("../../functions/bot-scanner/index.ts", import.meta.url));
const START = "if (effectiveLimitEnabled && limitEntry && shadowPlaces(shadowMode) && shadowEligibleSource(limitEntrySource) && izData?.bestZone) {";
const END = "if (effectiveLimitEnabled && limitEntry) {\n          // ── ROUTE 2 DISTANCE GUARD (research-registered, 1.5 H1 ATR)";

/** The hook's source with its handful of TypeScript-only annotations removed. */
export function hookSource(): string {
  const a = scanner.indexOf(START);
  const b = scanner.indexOf(END, a);
  if (a < 0 || b < 0) throw new Error("hook markers not found");
  return scanner.slice(a, b)
    .replace(/ as (?:any|"long" \| "short"|string \| null|string)(?![\w|])/g, "")
    .replace(/\(entry: number, stop: number\)/g, "(entry, stop)")
    .replace(/: Record<string, unknown> =/g, " =")
    .replace(/catch \(e: any\)/g, "catch (e)");
}

export function deepFreeze<T>(o: T, seen = new Set<unknown>()): T {
  if (o && typeof o === "object" && !seen.has(o)) {
    seen.add(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v, seen);
    Object.freeze(o);
  }
  return o;
}

const cfgFx = JSON.parse(Deno.readTextFileSync(new URL("./fixtures/baseline_a_config.json", import.meta.url)));

/** H1 candles with a known ATR (range 0.18 on CHF/JPY). */
function hourly(n = 30, mid = 190.15) {
  return Array.from({ length: n }, (_, i) => ({
    datetime: new Date(Date.UTC(2026, 9, 7, 0, 0) + i * 3600e3).toISOString(),
    open: mid, high: mid + 0.09, low: mid - 0.09, close: mid,
  }));
}

/** A realistic scope at the hook: a CHF/JPY long Impulse Zone setup A is about to place at refinedEntry. */
export function baseScope(over: Record<string, unknown> = {}): Record<string, unknown> {
  const config: any = mapNestedToFlat(cfgFx.config_json);
  config.__configVersion = cfgFx.config_version;
  config.__rawConfigJson = cfgFx.config_json;
  const bestZone = { type: "ob", low: 189.99417, high: 190.14972, refinedEntry: 190.142885, refinedSL: 189.95, ltfRefined: true, fibLevel: 0.786, totalScore: 3.5 };
  const izData = { hasZone: true, selectedTF: "1H", impulse: { high: 190.49909, low: 189.9432, direction: "bullish" }, bestZone };
  return {
    effectiveLimitEnabled: true, shadowMode: "on", limitEntrySource: "refinedEntry", izData, izGateMode: "hard", config, pairConfig: config,
    simp: resolveSimplification(cfgFx.config_json), hourlyCandles: hourly(), candles: hourly(), m15Candles: hourly(),
    analysis: { direction: "long", lastPrice: 190.2, score: 61.6, summary: "test", factors: [{ name: "Order Block", present: true, weight: 1, tier: 1 }], tieredScoring: { tier1Count: 2 } },
    sl: 189.93208, slFloorTrace: { slBeforeFloor: 189.95, floorPips: 25 }, impulseStopCandidate: { sl: 189.90, capPips: 66.71 },
    effectiveMinSlPips: 25, spec: SPECS["CHF/JPY"], pair: "CHF/JPY", rateMap: { "USD/JPY": 150 }, avgCommissionPerLot: 0,
    balance: 100000, pairRiskPercent: 0.5, atrForConsumers: 0, volCtx: undefined, propFirmCtx: undefined,
    detail: { pair: "CHF/JPY", status: "pending", signalSource: "impulse", impulseZone: izData, loggedOnlyGates: [], scoreGate: { mode: "log", wouldBlock: false }, gates: [] },
    candleSeries: null, priceIsAtValidatedZone: false, priceOnCorrectSide: true,
    cap: { id: "11111111-1111-4111-8111-111111111111", symbol: "CHF/JPY", signal_id: null }, scanCycleId: "22222222-2222-4222-8222-222222222222",
    limitEntry: { price: 190.142885, zoneType: "IZ-OB", zoneLow: 189.99417, zoneHigh: 190.14972 },
    userId: "57c79dee-db6b-4fae-b34a-4b64ce33ca34", sizingProvenance: { mode: "legacy" },
    setupClassification: { setupType: "continuation", confidence: 0.7 }, exitFlags: { trailingStop: false },
    isPromotedFromStaging: false, existingStaged: null,
    propFirmGateResult: { enabled: false, allowed: true, reason: "no profile", decision: null },
    gates: [{ passed: true, reason: "0/3 positions" }],
    ...over,
  };
}

const IMPORTS: Record<string, unknown> = {
  ...shadow, calculateATR, computePositionSize, buildRoute2OrderTelemetry, locatePoiFormation, pendingDistanceAtr,
  ROUTE2_TTL_MINUTES, route2ExpiresAt, route2ZoneId, buildFrozenDecision, buildAttribution, resolvePositionCaps, BOT_ID: "smc",
};

/**
 * Execute the hook. `freeze` deep-freezes every scope value (the intents
 * array excepted). Returns what it queued and anything it logged.
 */
export function runShadowHook(scope: Record<string, unknown>, opts: { freeze?: boolean; imports?: Record<string, unknown> } = {}) {
  const shadowIntents: any[] = [];
  const logs: string[] = [];
  const cons = { log: (...a: unknown[]) => logs.push(a.join(" ")), warn: (...a: unknown[]) => logs.push(a.join(" ")) };
  const env: Record<string, unknown> = { ...IMPORTS, ...(opts.imports ?? {}), ...scope, shadowIntents, console: cons };
  if (opts.freeze !== false) for (const [k, v] of Object.entries(env)) if (k !== "shadowIntents" && k !== "console") deepFreeze(v);
  const names = Object.keys(env);
  const fn = new Function(...names, `"use strict";\n${hookSource()}`);
  fn(...names.map((n) => env[n]));
  return { shadowIntents, logs };
}

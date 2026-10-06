/**
 * STEP 12 — one owner for the position caps (resolvePositionCaps).
 *
 *  - unified mode: every path gets the same global / per-symbol cap, pair
 *    maxPerSymbol overrides are ignored, invalid values fall back to 3/1;
 *  - unified mode absent: each path's legacy expression, reproduced exactly;
 *  - wiring: placement, hunt fill, scan-stop, the inactive second poller and
 *    the decision record all call the resolver, and no active path reads the
 *    legacy cap fields directly;
 *  - same-direction stacking is still its own rule.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type CapPath, resolvePositionCaps, UNIFIED_CAP_DEFAULTS } from "../../functions/_shared/positionCaps.ts";
import { applyPairOverrides, mapNestedToFlat } from "../../functions/_shared/configMapper.ts";

const PATHS: CapPath[] = ["placement", "hunt_fill", "scan_stop", "second_poller", "decision_record"];

// The live risk block (2026-10-06): maxConcurrentTrades 7 wins over the
// decorative maxOpenPositions 3; maxPositionsPerSymbol 3.
const LIVE_RISK = { maxConcurrentTrades: 7, maxOpenPositions: 3, maxPositionsPerSymbol: 3, allowSameDirectionStacking: false };
const UNIFIED = { capsMode: "unified", maxOpenPositions: 3, maxPerSymbol: 1 };

function pathConfigs(raw: Record<string, any>, pair = "EUR/USD") {
  const flat = mapNestedToFlat(raw) as any;
  flat.__rawConfigJson = raw;
  const pairConfig = { ...flat };
  applyPairOverrides(pairConfig, pair);
  return { flat, pairConfig };
}

/** What each path enforces, called exactly as the edge functions call it. */
function enforced(raw: Record<string, any>, pair = "EUR/USD") {
  const { flat, pairConfig } = pathConfigs(raw, pair);
  return {
    placement: resolvePositionCaps(pairConfig.__rawConfigJson, "placement", pairConfig),
    hunt_fill: resolvePositionCaps(flat.__rawConfigJson, "hunt_fill", flat),
    scan_stop: resolvePositionCaps(flat.__rawConfigJson, "scan_stop", flat),
    second_poller: resolvePositionCaps(raw, "second_poller"),
    decision_record: resolvePositionCaps(pairConfig.__rawConfigJson, "decision_record", pairConfig),
  };
}

Deno.test("unified mode: every path reads the same 3 global / 1 per symbol", () => {
  const e = enforced({ risk: LIVE_RISK, simplification: UNIFIED });
  for (const p of PATHS) {
    assertEquals(e[p].mode, "unified", p);
    assertEquals(e[p].maxOpenPositions, 3, `${p} global`);
    assertEquals(e[p].maxPerSymbol, 1, `${p} per symbol`);
  }
});

Deno.test("unified mode ignores per-pair maxPerSymbol overrides and the risk.* fields", () => {
  const raw = {
    risk: { ...LIVE_RISK, maxPerSymbol: 5 },
    pairGateOverrides: { "EUR/USD": { maxPerSymbol: 4 } },
    simplification: UNIFIED,
  };
  const { pairConfig } = pathConfigs(raw);
  assertEquals(pairConfig.maxPerSymbol, 4, "the override is still applied to the flat copy…");
  const e = enforced(raw);
  for (const p of PATHS) assertEquals([e[p].maxOpenPositions, e[p].maxPerSymbol], [3, 1], `…but ${p} ignores it`);
});

Deno.test("unified mode with invalid values falls back to 3/1, never to the legacy 7/3", () => {
  for (const bad of [
    { capsMode: "unified" },
    { capsMode: "unified", maxOpenPositions: 0, maxPerSymbol: 0 },
    { capsMode: "unified", maxOpenPositions: "3", maxPerSymbol: "1" },
    { capsMode: "unified", maxOpenPositions: 2.5, maxPerSymbol: -1 },
    { capsMode: "unified", maxOpenPositions: 51, maxPerSymbol: 11 },
  ]) {
    const e = enforced({ risk: LIVE_RISK, simplification: bad });
    for (const p of PATHS) {
      assertEquals([e[p].maxOpenPositions, e[p].maxPerSymbol], [UNIFIED_CAP_DEFAULTS.maxOpenPositions, UNIFIED_CAP_DEFAULTS.maxPerSymbol], `${JSON.stringify(bad)} ${p}`);
      assert(e[p].source.includes("default"));
    }
  }
  // other valid values are honoured
  const e = enforced({ risk: LIVE_RISK, simplification: { capsMode: "unified", maxOpenPositions: 5, maxPerSymbol: 2 } });
  for (const p of PATHS) assertEquals([e[p].maxOpenPositions, e[p].maxPerSymbol], [5, 2]);
});

Deno.test("unified values without capsMode change nothing", () => {
  const e = enforced({ risk: LIVE_RISK, simplification: { maxOpenPositions: 3, maxPerSymbol: 1 } });
  assertEquals(e.placement.mode, "legacy");
  assertEquals(e.placement.maxOpenPositions, 7);
});

Deno.test("legacy (capsMode absent): the live config keeps today's per-path values", () => {
  const e = enforced({ risk: LIVE_RISK });
  for (const p of PATHS) assertEquals(e[p].mode, "legacy");
  assertEquals([e.placement.maxOpenPositions, e.placement.maxPerSymbol], [7, 3]);
  assertEquals([e.hunt_fill.maxOpenPositions, e.hunt_fill.maxPerSymbol], [7, 3]);
  assertEquals(e.scan_stop.maxOpenPositions, 7);
  // the second poller read the decorative maxOpenPositions and a key that does not exist
  assertEquals([e.second_poller.maxOpenPositions, e.second_poller.maxPerSymbol], [3, 2]);
  // the decision record now carries the per-symbol cap placement used (was null)
  assertEquals([e.decision_record.maxOpenPositions, e.decision_record.maxPerSymbol], [7, 3]);
});

Deno.test("legacy: placement still honours a per-pair override; the hunt still does not", () => {
  const e = enforced({ risk: LIVE_RISK, pairGateOverrides: { "EUR/USD": { maxPerSymbol: 1 } } });
  assertEquals(e.placement.maxPerSymbol, 1);
  assertEquals(e.hunt_fill.maxPerSymbol, 3);
});

Deno.test("legacy: each path's old expression is reproduced exactly, including fallbacks", () => {
  const cases: Array<{ maxOpenPositions?: unknown; maxPerSymbol?: unknown }> = [
    { maxOpenPositions: 7, maxPerSymbol: 3 }, { maxOpenPositions: "4", maxPerSymbol: "2" },
    { maxOpenPositions: 0, maxPerSymbol: 0 }, {}, { maxOpenPositions: null, maxPerSymbol: null },
  ];
  const ge = (n: number, cap: unknown) => n >= (cap as number); // the old comparisons
  for (const c of cases) {
    for (const n of [0, 1, 2, 3, 4, 7, 8]) {
      const pl = resolvePositionCaps({}, "placement", c);
      assertEquals(n >= pl.maxOpenPositions, ge(n, c.maxOpenPositions), `placement global ${JSON.stringify(c)} n=${n}`);
      assertEquals(n >= pl.maxPerSymbol, ge(n, c.maxPerSymbol), `placement per-symbol ${JSON.stringify(c)} n=${n}`);
      const h = resolvePositionCaps({}, "hunt_fill", c);
      assertEquals(n >= h.maxOpenPositions, n >= (parseInt(String(c.maxOpenPositions), 10) || 3), `hunt global ${JSON.stringify(c)}`);
      assertEquals(n >= h.maxPerSymbol, n >= ((c.maxPerSymbol as number) || 2), `hunt per-symbol ${JSON.stringify(c)}`);
      const s = resolvePositionCaps({}, "scan_stop", c);
      assertEquals(n >= s.maxOpenPositions, n >= (parseInt(String(c.maxOpenPositions), 10) || 3), `scan-stop ${JSON.stringify(c)}`);
    }
  }
  for (const raw of [{}, { risk: { maxOpenPositions: 4, maxPerSymbol: 1 } }, { maxOpenPositions: 6, maxPerSymbol: 3 }, { risk: { maxOpenPositions: "5" } }] as any[]) {
    const z = resolvePositionCaps(raw, "second_poller");
    assertEquals(z.maxOpenPositions, parseInt(String(raw.risk?.maxOpenPositions || raw.maxOpenPositions || 3), 10));
    assertEquals(z.maxPerSymbol, raw.risk?.maxPerSymbol || raw.maxPerSymbol || 2);
  }
  assertEquals(resolvePositionCaps(null, "hunt_fill", null).maxOpenPositions, 3);
});

// ─── wiring (source) ────────────────────────────────────────────────────────

const scanner = Deno.readTextFileSync(new URL("../../functions/bot-scanner/index.ts", import.meta.url));
const zcs = Deno.readTextFileSync(new URL("../../functions/zone-confirmation-scanner/index.ts", import.meta.url));

/** bot-scanner without the DEFAULTS object and the dead legacy mapper (neither enforces). */
function activeScanner(): string {
  const d0 = scanner.indexOf("const DEFAULTS");
  const d1 = scanner.indexOf("\n};", d0);
  const l0 = scanner.indexOf("function _legacyLoadConfigMapping(");
  const l1 = scanner.indexOf("\nexport async function runSafetyGates(");
  assert(d0 > 0 && d1 > d0 && l0 > d1 && l1 > l0, "markers found");
  const legacy = scanner.slice(l0, l1);
  assert(!/resolvePositionCaps|gates\.push/.test(legacy), "the removed block is only the dead mapper");
  return scanner.slice(0, d0) + scanner.slice(d1, l0) + scanner.slice(l1);
}

Deno.test("no active path reads the legacy cap fields directly", () => {
  const active = activeScanner();
  for (const re of [/\bconfig\.maxOpenPositions\b/, /\bconfig\.maxPerSymbol\b/, /\.maxPositionsPerSymbol\b/, /risk\??\.maxOpenPositions/, /risk\??\.maxPerSymbol/, /maxConcurrentTrades/]) {
    assert(!re.test(active), `bot-scanner reads ${re}`);
    assert(!re.test(zcs), `zone-confirmation-scanner reads ${re}`);
  }
  assert(!/maxPerSymbol\s*\|\|/.test(active) && !/maxPerSymbol\s*\|\|/.test(zcs), "no local per-symbol fallback");
});

Deno.test("every enforcement path calls the single owner with its own path label", () => {
  const ss = scanner.indexOf("export async function runSafetyGates(");
  const gate = scanner.indexOf('const caps = resolvePositionCaps((config as any).__rawConfigJson, "placement", config);');
  assert(gate > ss && gate - ss < 20_000, "placement: inside runSafetyGates");
  assert(/openPositions\.length >= caps\.maxOpenPositions/.test(scanner));
  assert(/symbolPositions >= caps\.maxPerSymbol/.test(scanner));

  const hunt = scanner.indexOf('const huntCaps = resolvePositionCaps((config as any).__rawConfigJson, "hunt_fill", config);');
  const dry = scanner.indexOf("if ((pending as any).dry_run === true) {");
  assert(hunt > 0 && hunt < dry, "hunt: before the fill");
  assert(/currentOpenCount >= huntCaps\.maxOpenPositions/.test(scanner) && /currentSymbolCount >= huntCaps\.maxPerSymbol/.test(scanner));

  assert(scanner.includes('const scanStopCaps = resolvePositionCaps((config as any).__rawConfigJson, "scan_stop", config);'));
  assert(scanner.includes("const maxOpen = scanStopCaps.maxOpenPositions;"));

  assert(scanner.includes('resolvePositionCaps((pairConfig as any).__rawConfigJson, "decision_record", pairConfig)'));
  assert(/maxPositionsPerSymbol: c\.maxPerSymbol, capsMode: c\.mode/.test(scanner), "decision record carries the real per-symbol cap");

  assert(zcs.includes('const { maxOpenPositions, maxPerSymbol } = resolvePositionCaps(config, "second_poller");'));
  assert(zcs.indexOf('resolvePositionCaps(config, "second_poller")') < zcs.indexOf("claimRoute2Fill(supabase, {"));
});

Deno.test("same-direction stacking stays a separate rule on both paths", () => {
  const gate = scanner.indexOf("if (sameDirectionExists && !config.allowSameDirectionStacking) {");
  assert(gate > 0 && gate < scanner.indexOf("} else if (symbolPositions >= caps.maxPerSymbol) {"), "placement: stacking checked first, by its own flag");
  const huntCap = scanner.indexOf("if (currentSymbolCount >= huntCaps.maxPerSymbol) {");
  const huntStack = scanner.indexOf("if (sameDirOpen && !config.allowSameDirectionStacking) {");
  assert(huntCap > 0 && huntStack > huntCap, "hunt: stacking checked after the numeric caps, by its own flag");
  assert(!/resolvePositionCaps[^\n]*allowSameDirectionStacking/.test(scanner));
  const owner = Deno.readTextFileSync(new URL("../../functions/_shared/positionCaps.ts", import.meta.url));
  assert(!/allowSameDirectionStacking/.test(owner.replace(/\/\*\*[\s\S]*?\*\//g, "")), "the owner does not decide stacking");
});

/**
 * STEP 16-E — the 26 live code-default-only controls stored explicitly: equivalence proof.
 *
 * Input: the EXACT production bot_configs.config_json text (re-verified
 * 2026-10-08 03:34 UTC, hash 3d5b8fb0…), docs/step16/step16e_config_before.json.
 * Patch (approved set A+B): docs/step16/step16e_patch_AB_26.json —
 *   the 13 live default-only controls + atrDerivedFloorsEnabled, and 12
 *   default-only selectors / gate modes whose non-default value would change
 *   admission, entry, stop, direction or cancellation.
 * On all six live FX pairs the full effective runtime config (mapNestedToFlat
 * + applyPairOverrides), resolveSimplification and resolvePositionCaps (every
 * stage) must be byte-identical before and after. The production SQL file
 * (docs/step16/STEP16E_PATCH_AB_26.sql) is executed in real Postgres and must
 * yield exactly the proven hash; the reporting equivalence registry must
 * carry old and new hash in one class.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PGlite } from "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist/index.js";
import { applyPairOverrides, mapNestedToFlat, RUNTIME_DEFAULTS } from "../../functions/_shared/configMapper.ts";
import { resolveSimplification } from "../../functions/_shared/simplification.ts";
import { resolvePositionCaps } from "../../functions/_shared/positionCaps.ts";
import { configClassOf, CONFIG_EQUIVALENCE_CLASSES } from "../../functions/_shared/hypotheticalCapBook.ts";

const read = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url));
const BEFORE_TEXT = read("../../../docs/step16/step16e_config_before.json");
const BEFORE = JSON.parse(BEFORE_TEXT);
const PATCH = JSON.parse(read("../../../docs/step16/step16e_patch_AB_26.json"));
const PATCH_SQL = read("../../../docs/step16/STEP16E_PATCH_AB_26.sql");
const OLD_HASH: string = "3d5b8fb0d756b3596ed46d133e873a88";
const NEW_HASH: string = "1037e6170289f865e4d6618dcf28b94d";
const ROW_ID = "327912ae-4e5b-4677-ad04-7c5d566f7990";
const PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY", "CHF/JPY", "NZD/CAD", "NZD/CHF"];
const STAGES = ["placement", "hunt_fill", "scan_stop", "decision_record"] as const;

/** The 13 live controls + atrDerivedFloorsEnabled (audit set A) and the 12 load-bearing selectors (set B). */
const SET_A = ["impulseZoneEnabled", "legStopBufferPct", "legStopCapMultiple", "useSimpleDirection", "useConfirmedTrend",
  "confirmedTrendFibFactor", "confirmedTrendSwingLookback", "simpleDirectionH1BosLookback", "simpleDirectionH4ChochLookback",
  "zoneChaseMaxZoneWidths", "thesisValidationEnabled", "thesisCheckDirectionFlip", "ictHTFEnabled", "atrDerivedFloorsEnabled"];
const SET_B = ["gamePlanGateMode", "zoneAnchoredStop", "requireUnifiedZone", "priceAwareStructureBlocks", "thesisDirectionStyleAware",
  "htfBiasHardVeto", "ictHTFGateMode", "ictKillZoneGateMode", "ictJudasSwingGateMode", "ictDisplacementMSSGateMode",
  "killZoneOnly", "limitOrderEnabled"];

const merge = (base: any, p: any) => {
  const out = JSON.parse(JSON.stringify(base));
  for (const [sec, kv] of Object.entries(p)) out[sec] = { ...(out[sec] ?? {}), ...(kv as object) };
  return out;
};
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) =>
  x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x);
const runtime = (raw: any, pair: string) => applyPairOverrides(mapNestedToFlat(raw), pair) as Record<string, unknown>;
const patchKeys = Object.values(PATCH).flatMap((kv) => Object.keys(kv as object));
const AFTER = merge(BEFORE, PATCH);

const PGLITE_DIST = "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.2.17/dist";
/** As in paperSettlementLedger.test.ts: explicit assets, and Deno's `process` hidden while PGlite boots. */
// deno-lint-ignore no-explicit-any
async function newPglite(): Promise<any> {
  const a = {
    wasmModule: await WebAssembly.compile(await (await fetch(`${PGLITE_DIST}/postgres.wasm`)).arrayBuffer()),
    fsBundle: await (await fetch(`${PGLITE_DIST}/postgres.data`)).blob(),
  };
  const g = globalThis as Record<string, unknown>;
  const desc = Object.getOwnPropertyDescriptor(g, "process");
  Object.defineProperty(g, "process", { value: undefined, configurable: true, writable: true });
  try {
    const db = new PGlite(a);
    await db.waitReady;
    return db;
  } finally {
    if (desc) Object.defineProperty(g, "process", desc); else delete g.process;
  }
}

Deno.test("patch: exactly the 26 approved keys (set A 14 incl. atrDerivedFloorsEnabled + set B 12), none stored today", () => {
  assertEquals(patchKeys.length, 26);
  assertEquals([...patchKeys].sort(), [...SET_A, ...SET_B].sort());
  assert(patchKeys.includes("atrDerivedFloorsEnabled"));
  assertEquals(Object.keys(PATCH).sort(), ["entry", "sessions", "strategy"]);
  assertEquals([PATCH.sessions, PATCH.entry], [{ killZoneOnly: false }, { limitOrderEnabled: false }]);
  for (const [sec, kv] of Object.entries(PATCH)) for (const k of Object.keys(kv as object)) {
    assert(!(k in (BEFORE[sec] ?? {})), `${sec}.${k} must be default-only today`);
  }
});

Deno.test("every value is exactly the current code default (RUNTIME_DEFAULTS); the booleans are read from code", () => {
  for (const kv of Object.values(PATCH)) for (const [k, v] of Object.entries(kv as object)) {
    assertEquals(v, (RUNTIME_DEFAULTS as any)[k], k);
  }
  const d = RUNTIME_DEFAULTS as any;
  assertEquals([d.impulseZoneEnabled, d.useSimpleDirection, d.useConfirmedTrend, d.thesisValidationEnabled, d.thesisCheckDirectionFlip,
    d.ictHTFEnabled, d.atrDerivedFloorsEnabled], [true, true, true, true, true, true, false]);
});

Deno.test("no existing stored value changes: after minus the 26 keys equals before", () => {
  const stripped = JSON.parse(JSON.stringify(AFTER));
  for (const [sec, kv] of Object.entries(PATCH)) for (const k of Object.keys(kv as object)) delete stripped[sec][k];
  assertEquals(canon(stripped), canon(BEFORE));
});

Deno.test("all six pairs: the full effective runtime config is byte-identical before and after", () => {
  for (const pair of PAIRS) {
    const b = runtime(BEFORE, pair), a = runtime(AFTER, pair);
    assertEquals(canon(a), canon(b), pair);
    assertEquals(Object.keys(a).length, Object.keys(b).length);
  }
  assertEquals(runtime(AFTER, "EUR/USD").zoneEntryDepth, 0.5, "the EUR/USD pair override still applies");
  assertEquals(runtime(AFTER, "GBP/USD").zoneEntryDepth, 0.55);
});

Deno.test("raw-config readers identical: resolveSimplification and resolvePositionCaps at every stage, all six pairs", () => {
  assertEquals(canon(resolveSimplification(AFTER)), canon(resolveSimplification(BEFORE)));
  for (const pair of PAIRS) for (const stage of STAGES) {
    assertEquals(canon(resolvePositionCaps(AFTER, stage, runtime(AFTER, pair))), canon(resolvePositionCaps(BEFORE, stage, runtime(BEFORE, pair))), `${pair} ${stage}`);
  }
});

const CATEGORIES: Record<string, string[]> = {
  admission: ["impulseZoneEnabled", "impulseZoneGateMode", "requireUnifiedZone", "killZoneOnly", "gamePlanEnabled", "gamePlanGateMode", "htfBiasHardVeto", "htfBiasRequired", "minZoneScore", "tier1GateEnabled", "instruments", "newsFilterEnabled", "marketFillAtZone", "limitOrderEnabled", "cooldownMinutes", "conflictBlockAt"],
  orderGeometry: ["tpRatio", "zoneEntryDepth", "zoneChaseMaxZoneWidths", "limitOrderExpiryMinutes", "fibMaxRetracement"],
  sizing: ["riskPerTrade", "positionSizingMethod", "fixedLotSize"],
  stop: ["slBufferPips", "impulseSlCapMultiplier", "legStopCapMultiple", "legStopBufferPct", "atrDerivedFloorsEnabled", "zoneAnchoredStop", "slMethod", "minStopPips"],
  management: ["breakEvenEnabled", "trailingStopEnabled", "partialTPEnabled", "maxHoldEnabled", "maxHoldHours", "structureInvalidationEnabled", "dolTPExtensionEnabled", "regimeAdaptiveTPEnabled"],
  caps: ["maxOpenPositions", "maxPerSymbol", "allowSameDirectionStacking", "portfolioHeat", "correlationFilterEnabled", "maxCorrelatedPositions", "maxCorrelation", "maxConsecutiveLosses", "consecutiveLossPauseHours", "protectionMaxDailyLossDollar"],
  directionEngine: ["useSimpleDirection", "useConfirmedTrend", "confirmedTrendFibFactor", "confirmedTrendSwingLookback", "simpleDirectionH1BosLookback", "simpleDirectionH4ChochLookback", "priceAwareStructureBlocks", "useTrendDirection", "regimeScoringEnabled"],
  thesis: ["thesisValidationEnabled", "thesisCheckDirectionFlip", "thesisCheckFotsiVeto", "thesisCheckGpBiasReversal", "thesisDirectionStyleAware", "zoneExitDirectionAware"],
  ictHTF: ["ictHTFEnabled", "ictHTFGateMode", "ictKillZoneGateMode", "ictJudasSwingGateMode", "ictDisplacementMSSGateMode", "ictFVGInvalidationGateMode"],
  legCap: ["legStopCapMultiple", "legStopBufferPct", "impulseSlCapMultiplier"],
};

Deno.test("per category (admission, geometry, sizing, stop, management, caps, direction engine, thesis, ICT HTF, leg cap): identical on all six pairs", () => {
  for (const pair of PAIRS) {
    const b = runtime(BEFORE, pair), a = runtime(AFTER, pair);
    for (const [cat, keys] of Object.entries(CATEGORIES)) for (const k of keys) {
      assertEquals(canon(a[k]), canon(b[k]), `${pair} ${cat}.${k}`);
    }
  }
  for (const k of patchKeys) assert(Object.values(CATEGORIES).flat().includes(k), `${k} is covered by a category check`);
  const sb = resolveSimplification(BEFORE), sa = resolveSimplification(AFTER);
  for (const k of ["riskPercent", "sizingMode", "stopAnchor", "rrGateMode", "orderRRMin", "capsMode", "maxOpenPositions", "maxPerSymbol", "scoreGateMode", "newsGateMode", "reactionGateMode", "marketEntriesEnabled", "unifiedModifiersEnabled", "styleOverridesMode", "secondPollerEnabled", "dryRunWhenLocked", "maxLotsPerTrade"]) {
    assertEquals((sa as any)[k], (sb as any)[k], `simplification.${k}`);
  }
});

Deno.test("the production SQL file, executed in real Postgres: 3d5b8fb0 → exactly 1037e617…; re-run is a no-op; a changed row aborts", async () => {
  const setup = `create table public.bot_configs (id uuid primary key, config_json jsonb,
      config_version text generated always as (md5(config_json::text)) stored, updated_at timestamptz default now());
    create table public.bot_config_change_log (config_id uuid, previous_hash text, next_hash text, changed_at timestamptz default now());`;
  const db = await newPglite();
  await db.exec(setup);
  await db.query(`insert into public.bot_configs (id, config_json) values ($1, $2::jsonb)`, [ROW_ID, BEFORE_TEXT]);
  const v = async () => (await db.query(`select config_version v from public.bot_configs`)).rows[0].v as string;
  assertEquals(await v(), OLD_HASH, "the fixture is production's exact text (generated md5 = 3d5b8fb0)");
  const res = await db.exec(PATCH_SQL);
  assertEquals((res[res.length - 1].rows[0] as any).config_version, NEW_HASH);
  assertEquals(await v(), NEW_HASH);
  const stored = (await db.query(`select config_json j from public.bot_configs`)).rows[0].j as unknown;
  assertEquals(canon(stored), canon(AFTER), "the SQL writes exactly the object the equivalence proof used");
  await db.exec(PATCH_SQL);
  assertEquals(await v(), NEW_HASH, "re-run: the guard matches no row; no-op");
  await db.close();

  const db2 = await newPglite();
  await db2.exec(setup);
  await db2.query(`insert into public.bot_configs (id, config_json) values ($1, '{"strategy": {}}'::jsonb)`, [ROW_ID]);
  let msg = "";
  try { await db2.exec(PATCH_SQL); } catch (e) { msg = String((e as Error).message); }
  assert(msg.includes("STEP16E_PATCH_ABORTED"), "a row that is not 3d5b8fb0 aborts the transaction");
  await db2.close();
});

Deno.test("reporting: old and new hash are registered as one behaviour-equivalence class (equivalent, not identical)", () => {
  assert(OLD_HASH !== NEW_HASH);
  assertEquals(configClassOf(NEW_HASH), configClassOf(OLD_HASH));
  assertEquals(configClassOf(OLD_HASH), "frozen_impulse_route2_v1");
  assertEquals(CONFIG_EQUIVALENCE_CLASSES["frozen_impulse_route2_v1"], [OLD_HASH, NEW_HASH]);
});

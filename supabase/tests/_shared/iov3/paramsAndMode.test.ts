import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveShadowParams, staticFloorPips } from "../../../functions/_shared/iov3/params.ts";
import { checkTransition, evaluateUnlock, summarize, UNLOCK_DAYS, UNLOCK_RIGHT } from "../../../functions/_shared/iov3/modeControl.ts";
import { MIN_SL_PIPS } from "../../../functions/_shared/smcAnalysis.ts";

/** Shadow parameters come from the live config exactly as bot-scanner resolves them; the switch rules (owner decisions 2026-10-26). */

const SNAP = JSON.parse(Deno.readTextFileSync(new URL("../../../../docs/step16/step16e_config_before.json", import.meta.url)));
const raw = () => { const r = structuredClone(SNAP.config_json ?? SNAP); r.exit.tpRRRatio = 1.5; return r; }; // Baseline A ended 10-22: TP 1.1 → 1.5
const RESEARCH_MIN_SL: Record<string, number> = { "EUR/USD": 20, "GBP/USD": 25, "USD/JPY": 25, "CHF/JPY": 25, "NZD/CAD": 20, "NZD/CHF": 20 };

Deno.test("params: the live config snapshot resolves to exactly the research replay's constants (so SHADOW = the researched rules)", () => {
  for (const pair of Object.keys(RESEARCH_MIN_SL)) {
    const r = resolveShadowParams(raw(), pair);
    assert(r.ok, JSON.stringify(r));
    const p = r.params;
    assertEquals([p.minSlPips, p.slBufferPips, p.legBufferPct, p.legCapMultiple, p.capMultiplier, p.tpRatio, p.distanceAtrMult, p.ttlMs, p.fibMaxRetracement],
      [RESEARCH_MIN_SL[pair], 1, 0.02, 1.2, 1.5, 1.5, 1.5, 8 * 3_600_000, 1], pair);
    assertEquals(p.enabledDays, [1, 2, 3, 4, 5]);
    assertEquals([...p.enabledSessions!].sort(), ["asian", "london", "newyork", "offhours"]);
    assert(p.voidOnGap);
  }
});

Deno.test("params: refused where the scanner would resolve differently; per-pair floor override honoured; unknown pair refused", () => {
  const swing = raw(); swing.tradingStyle = { mode: "swing_trader" };
  assertEquals(resolveShadowParams(swing, "EUR/USD").ok, false);
  const legacy = raw(); legacy.simplification.styleOverridesMode = "legacy";
  assertEquals(resolveShadowParams(legacy, "EUR/USD").ok, false);
  const over = raw(); over.pairGateOverrides = { ...over.pairGateOverrides, "GBP/USD": { ...(over.pairGateOverrides?.["GBP/USD"] ?? {}), minStopPips: 31 } };
  const r = resolveShadowParams(over, "GBP/USD");
  assert(r.ok && r.params.minSlPips === 31);
  assertEquals(resolveShadowParams(raw(), "XAU/USD").ok, false);
  assertEquals(staticFloorPips({}, "EUR/USD"), MIN_SL_PIPS["EUR/USD"]);
});

Deno.test("params: the two scanner-local rules restated in params.ts are still exactly the scanner's (source pinned)", () => {
  const src = Deno.readTextFileSync(new URL("../../../functions/bot-scanner/index.ts", import.meta.url));
  assert(src.includes(`function resolveStaticFloorPips(cfg: any, pair: string): number {
  const override = cfg?.minStopPips;
  if (typeof override === "number" && Number.isFinite(override) && override > 0) return override;
  return MIN_SL_PIPS[pair] ?? 15;
}`), "resolveStaticFloorPips changed: update params.ts staticFloorPips");
  for (const line of [
    `? Math.max(0, Math.min(0.2, (pairConfig as any).legStopBufferPct))`,
    `? Math.max(1.0, Math.min(3.0, (pairConfig as any).legStopCapMultiple))`,
    `const slBuffer = Math.max(pipBuffer, impulseRange * legBufferPct);`,
    `const floorCapPips = staticMinSlPips * (pairConfig.impulseSlCapMultiplier ?? 4);`,
    `const maxImpulseSlPips = Math.max(floorCapPips, legCapPips);`,
    `: pairConfig.slBufferPips * pairAssetProfileInner.slBufferMultiplier;`,
  ]) assert(src.includes(line), `scanner zone-route stop rule changed: ${line}`);
});

const base = { setAtMs: 0, v3AuditSince: 0, shadowAuditSince: 0 };
Deno.test("switch: OFF↔SHADOW always; ON only when available AND (≥ 7 days or ≥ 5 ✓) AND clean plumbing; leaving ON always", () => {
  const day = 86_400_000;
  const off = evaluateUnlock({ ...base, mode: "OFF", nowMs: 10 * day, rightCount: 9, onAvailable: true });
  assertEquals(off.met, false);
  assertEquals(checkTransition("OFF", "SHADOW", off), { ok: true });
  assertEquals(checkTransition("SHADOW", "OFF", off), { ok: true });
  assertEquals(checkTransition("OFF", "ON", off).ok, false);
  const early = evaluateUnlock({ ...base, mode: "SHADOW", nowMs: 2 * day, rightCount: UNLOCK_RIGHT - 1, onAvailable: true });
  assertEquals(early.met, false);
  assert(early.reason.includes(`${UNLOCK_DAYS} days`));
  assertEquals(evaluateUnlock({ ...base, mode: "SHADOW", nowMs: 2 * day, rightCount: UNLOCK_RIGHT, onAvailable: true }).met, true, "5 ✓ setups unlock early");
  assertEquals(evaluateUnlock({ ...base, mode: "SHADOW", nowMs: UNLOCK_DAYS * day, rightCount: 0, onAvailable: true }).met, true, "a week unlocks");
  const dirty = evaluateUnlock({ ...base, mode: "SHADOW", nowMs: 9 * day, rightCount: 9, v3AuditSince: 1, onAvailable: true });
  assertEquals(dirty.met, false);
  assert(dirty.reason.includes("plumbing"));
  const ok = evaluateUnlock({ ...base, mode: "SHADOW", nowMs: 9 * day, rightCount: 9, onAvailable: true });
  assertEquals(checkTransition("SHADOW", "ON", ok), { ok: true });
  assertEquals(checkTransition("ON", "SHADOW", ok), { ok: true });
  assertEquals(checkTransition("SHADOW", "SHADOW", ok).ok, false);
});

Deno.test("switch: in step 3 ON is unavailable whatever the evidence (step 4 builds it)", () => {
  const u = evaluateUnlock({ ...base, mode: "SHADOW", nowMs: 30 * 86_400_000, rightCount: 50 });
  assertEquals(u.onAvailable, false);
  assertEquals(checkTransition("SHADOW", "ON", u), { ok: false, reason: "ON is being built (step 4)" });
});

Deno.test("summary: counts placed / filled / wins / losses / open / voided and sums net R", () => {
  const s = summarize([
    { order_id: "a", type: "placed", payload: {} }, { order_id: "a", type: "filled", payload: {} }, { order_id: "a", type: "closed", payload: { result: "TP", net: 1.42 } },
    { order_id: "b", type: "placed", payload: {} }, { order_id: "b", type: "filled", payload: {} }, { order_id: "b", type: "closed", payload: { result: "SL", net: -1.08 } },
    { order_id: "c", type: "placed", payload: {} }, { order_id: "c", type: "filled", payload: {} },
    { order_id: "d", type: "placed", payload: {} }, { order_id: "d", type: "cancelled", payload: {} },
    { order_id: "e", type: "placed", payload: {} }, { order_id: "e", type: "filled", payload: {} }, { order_id: "e", type: "voided", payload: {} },
  ]);
  assertEquals(s, { placed: 5, filled: 4, wins: 1, losses: 1, open: 1, voided: 1, cancelled: 1, netR: 0.34 });
});

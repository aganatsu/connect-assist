// Impulse-on-V3 shadow parameters, resolved from the account's LIVE bot config the same way bot-scanner resolves them for its
// Route 2 zone orders (owner default 2026-10-26: "the shadow copies your live settings at the moment you flip"). PURE.
//
// Uses the shared mapper (mapNestedToFlat + applyPairOverrides, the scanner's single source of truth) and the shared Route 2
// constants. Two scanner-local rules are restated here and pinned by source-hash tests so they cannot drift silently:
//   resolveStaticFloorPips (per-pair stop floor) and the impulse-stop buffer / cap clamps of the zone route (legStopBufferPct
//   clamped to [0, 0.2], default 0.02; legStopCapMultiple clamped to [1, 3], default 1.2; per-instrument slBufferPips override,
//   else slBufferPips × asset-profile multiplier).
// The shadow refuses (returns a reason) where the scanner would resolve values this module does not mirror: a style other than
// scalper, or styleOverridesMode other than "off" (the style table would then rewrite stop parameters).
import { applyPairOverrides, mapNestedToFlat } from "../configMapper.ts";
import { getAssetProfile, MIN_SL_PIPS } from "../smcAnalysis.ts";
import { resolveSimplification } from "../simplification.ts";
import { ROUTE2_MAX_PENDING_DISTANCE_ATR, ROUTE2_TTL_MINUTES } from "../route2Forward.ts";
import { COST_PIPS, IOV3_PAIRS, PIP, type ShadowParams } from "./shadowEngine.ts";

export type ResolvedParams = { ok: true; params: ShadowParams } | { ok: false; reason: string };

/** Mirrors bot-scanner resolveStaticFloorPips (source pinned by test). */
export function staticFloorPips(cfg: { minStopPips?: unknown }, pair: string): number {
  const override = cfg?.minStopPips;
  if (typeof override === "number" && Number.isFinite(override) && override > 0) return override;
  return MIN_SL_PIPS[pair] ?? 15;
}

// deno-lint-ignore no-explicit-any
export function resolveShadowParams(raw: any, pair: string): ResolvedParams {
  if (!IOV3_PAIRS.includes(pair as typeof IOV3_PAIRS[number])) return { ok: false, reason: `pair ${pair} has no V3 structure state` };
  const style = raw?.tradingStyle?.mode ?? "scalper";
  if (style !== "scalper") return { ok: false, reason: `style ${style}: V3 shadow is built for scalper only` };
  const sw = resolveSimplification(raw);
  if (sw.styleOverridesMode !== "off") return { ok: false, reason: `styleOverridesMode ${sw.styleOverridesMode}: style stop overrides are not mirrored` };
  // deno-lint-ignore no-explicit-any
  const pc: any = applyPairOverrides(mapNestedToFlat(raw), pair);
  const bufOverride = pc.instrumentBuffers?.[pair]?.slBufferPips;
  const slBufferPips = bufOverride != null ? Number(bufOverride) : pc.slBufferPips * getAssetProfile(pair).slBufferMultiplier;
  const legBufferPct = typeof pc.legStopBufferPct === "number" ? Math.max(0, Math.min(0.2, pc.legStopBufferPct)) : 0.02;
  const legCapMultiple = typeof pc.legStopCapMultiple === "number" ? Math.max(1.0, Math.min(3.0, pc.legStopCapMultiple)) : 1.2;
  return { ok: true, params: {
    pair, pip: PIP[pair], costPips: COST_PIPS[pair],
    minSlPips: staticFloorPips(pc, pair), slBufferPips, legBufferPct, legCapMultiple, capMultiplier: pc.impulseSlCapMultiplier ?? 4,
    tpRatio: pc.tpRatio, distanceAtrMult: ROUTE2_MAX_PENDING_DISTANCE_ATR, ttlMs: ROUTE2_TTL_MINUTES * 60_000,
    fibMaxRetracement: pc.fibMaxRetracement, enabledSessions: [...pc.enabledSessions], enabledDays: [...pc.enabledDays], voidOnGap: true,
  } };
}

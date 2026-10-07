/**
 * STEP 15 — builds the trade_attribution row (sections A–D) at Route 2
 * placement. PURE: no database, no clock, no randomness (the caller passes
 * signal_id and decision_id).
 *
 * The row is immutable once written (DB guard), so everything here describes
 * the decision as judged at placement. Lifecycle (E), fill (F) and close (G)
 * are written later by database triggers and the settlement functions.
 *
 * Primary engine is decided by RULE from what actually admitted the order and
 * supplied its entry — never inferred later from what was "present":
 *   Impulse hard gate + entry from the Impulse zone (refinedEntry / zoneMid) → impulse_zone
 *   Unified supplied the entry AND Unified modifiers are on                  → unified
 *   legacy OB/FVG entry (computeLimitEntryPrice)                             → ob_fvg
 * With modifiers off, Unified can only appear as a contributor, detected_only.
 * The SMC score is evidence (log-only gate), never the primary engine.
 */
import type { Route2EntrySource } from "./route2Forward.ts";

export const ATTRIBUTION_VERSION = "trade-attribution.v1";
export const PRIMARY_ENGINE_RULE = "primary-engine.v1";

export type PrimaryEngine = "impulse_zone" | "unified" | "ob_fvg";

export function primaryEngine(i: { entrySource: Route2EntrySource; izGateMode: string; unifiedModifiersEnabled: boolean }): PrimaryEngine {
  if (i.entrySource === "unified" && i.unifiedModifiersEnabled) return "unified";
  if ((i.entrySource === "refinedEntry" || i.entrySource === "zoneMid") && i.izGateMode === "hard") return "impulse_zone";
  if (i.entrySource === "unified") return i.izGateMode === "hard" ? "impulse_zone" : "ob_fvg"; // modifiers off: never "unified"
  return "ob_fvg";
}

export interface GateLike { gateId?: string; passed: boolean; reason: string; loggedOnly?: boolean; wouldBlock?: boolean }
export interface GateVerdict { gate_id: string; mode: "gate" | "log"; passed: boolean; would_block: boolean; reason: string }

// Untagged safety gates, identified by the reason text runSafetyGates writes.
const GATE_PATTERNS: [RegExp, string][] = [
  [/^Direction (OK|BLOCKED)/, "direction"],
  [/^P\/D zone/, "premium_discount"],
  [/^Structural Conviction/, "structural_conviction"],
  [/ not in enabled instruments$| enabled$/, "instrument"],
  [/^Max positions|^\d+\/\d+ positions$/, "caps_global"],
  [/^Already (long|short) on /, "stacking"],
  [/^Max \d+ positions for |^\d+\/\d+ for /, "caps_per_symbol"],
  [/^Portfolio heat/, "portfolio_heat"],
  [/^Daily loss/, "daily_loss"],
  [/^Drawdown/, "drawdown"],
  [/[Cc]ooldown/, "cooldown"],
  [/consecutive loss/i, "consecutive_losses"],
  [/^Daily net P&L/, "daily_dollar_loss"],
  [/FOTSI/, "fotsi"],
  [/[Hh]edge conflict|correlat/i, "correlation"],
  [/^Tier 1/, "tier1"],
  [/^Regime/, "regime"],
  [/^\[Info\] Spread|^Spread/, "spread"],
  [/SMT/, "smt"],
  [/[Ss]ession/, "session"],
];

export function classifyGate(g: GateLike): GateVerdict {
  const id = g.gateId ?? GATE_PATTERNS.find(([re]) => re.test(g.reason))?.[1] ?? "unclassified";
  return {
    gate_id: id,
    mode: g.loggedOnly ? "log" : "gate",
    passed: !!g.passed,
    would_block: g.wouldBlock ?? !g.passed,
    reason: String(g.reason ?? "").slice(0, 300),
  };
}

export type GpAlignment = "aligned" | "opposed" | "below_threshold" | "neutral" | "none" | "disabled";

export function gamePlanAlignment(ctx: { bias?: string | null; biasConfidence?: number | null; confidence?: number | null } | null | undefined,
  direction: "long" | "short", enabled: boolean, minConfidence = 50): GpAlignment {
  if (!enabled) return "disabled";
  if (!ctx || !ctx.bias) return "none";
  if (ctx.bias === "neutral") return "neutral";
  const conf = Number(ctx.biasConfidence ?? ctx.confidence ?? 0);
  if (conf < minConfidence) return "below_threshold";
  const want = direction === "long" ? "bullish" : "bearish";
  return ctx.bias === want ? "aligned" : "opposed";
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export interface AttributionInput {
  signalId: string;
  decisionId: string;
  scanCycleId: string;
  userId: string;
  botId: string;
  symbol: string;
  direction: "long" | "short";
  dryRun: boolean;
  decisionAt: string;
  strategyBarTime?: string | null;
  configVersion: string;            // md5(config_json::text), 32 hex
  strategyVersion: string;
  switches: { sizingMode: string; riskPercent: number; maxLotsPerTrade: number; stopAnchor: string; unifiedModifiersEnabled: boolean };
  legacyRiskPercent: number;
  management: { breakEvenEnabled?: boolean; trailingStopEnabled?: boolean; partialTPEnabled?: boolean; maxHoldEnabled?: boolean; maxHoldHours?: number };
  caps: { mode: string; maxOpenPositions: number; maxPerSymbol: number };
  impulseSlCapMultiplier?: number | null;
  riskProfileVersion?: string | null;
  promotedFromWatchlist?: { stagedSetupId: string | null; initialScore: number | null; cycles: number | null } | null;
  entrySource: Route2EntrySource;
  izGateMode: string;
  gamePlanEnabled: boolean;
  gamePlanContext?: Record<string, any> | null;
  directionVerdict?: Record<string, any> | null;
  impulse: { hasZone?: boolean; selectedTF?: string | null; impulse?: Record<string, any> | null; bestZone?: Record<string, any> | null } | null;
  obFvgZone?: Record<string, any> | null;
  unifiedDetected?: unknown;
  unifiedComparison?: unknown;
  gateScore: number | null;
  decisionScoreGate?: { mode?: string; score?: number; threshold?: number; wouldBlock?: boolean } | null;
  factors?: { name: string; present: boolean; weight: number; tier?: number; group?: string }[] | null;
  tieredScoring?: Record<string, any> | null;
  gates: GateLike[];
  ictFvgGate?: Record<string, any> | null;
  orderRR?: { rawRR?: number; effectiveRR?: number; costInPrice?: number; wouldBlock?: boolean; min?: number; mode?: string } | null;
  loggedOnlyWouldBlock: { gateId: string; reason: string }[];
  riskGate?: Record<string, any> | null;
  zoneId?: string | null;
  entryDepth?: number | null;
  limitPrice: number;
  stopPrice: number;
  targetPrice: number;
  pipSize: number;
  route2Stop?: { anchor?: string; floorPips?: number; capPips?: number; limit?: { source?: string; riskPips?: number }; market?: Record<string, any> } | null;
  plannedSizing?: { lots?: number; uncappedLots?: number; riskPercentTarget?: number; riskUsdTarget?: number } | null;
  balance: number;
  expiresAt?: string | null;
}

/** The trade_attribution insert payload for route2_place_order. */
export function buildAttribution(i: AttributionInput): Record<string, unknown> {
  const pe = primaryEngine({ entrySource: i.entrySource, izGateMode: i.izGateMode, unifiedModifiersEnabled: i.switches.unifiedModifiersEnabled });
  const gpAlign = gamePlanAlignment(i.gamePlanContext ?? null, i.direction, i.gamePlanEnabled);
  const gates = i.gates.map(classifyGate);
  if (i.ictFvgGate) gates.push({ gate_id: "ict_fvg", mode: i.ictFvgGate.mode === "hard" ? "gate" : "log", passed: !i.ictFvgGate.wouldBlock, would_block: !!i.ictFvgGate.wouldBlock, reason: `ICT FVG (${i.ictFvgGate.mode})` });
  if (i.orderRR) gates.push({ gate_id: "rr_order", mode: i.orderRR.mode === "order_geometry" ? "gate" : "log", passed: !i.orderRR.wouldBlock, would_block: !!i.orderRR.wouldBlock, reason: `effective R:R ${num(i.orderRR.effectiveRR)?.toFixed(3)} vs min ${i.orderRR.min}` });
  if (i.riskGate) gates.push({ gate_id: "risk_profile", mode: "gate", passed: i.riskGate.enabled ? !!i.riskGate.allowed : true, would_block: i.riskGate.enabled ? !i.riskGate.allowed : false, reason: String(i.riskGate.reason ?? (i.riskGate.enabled ? "" : "no active risk profile")).slice(0, 300) });
  const scoreGateBlocks = !!i.decisionScoreGate?.wouldBlock;
  const ictBlocks = !!i.ictFvgGate?.wouldBlock;
  const legacyWouldAdmit = i.loggedOnlyWouldBlock.length === 0 && !scoreGateBlocks && !ictBlocks;

  const mgmtOff = !i.management.breakEvenEnabled && !i.management.trailingStopEnabled && !i.management.partialTPEnabled && !i.management.maxHoldEnabled;
  const stopSource = i.route2Stop?.anchor === "limit" && i.route2Stop.limit?.source ? i.route2Stop.limit.source : "market_chain";
  const stopPips = Math.abs(i.limitPrice - i.stopPrice) / i.pipSize;
  const intendedPct = num(i.plannedSizing?.riskPercentTarget) ?? (i.switches.sizingMode === "fill_time" ? i.switches.riskPercent : i.legacyRiskPercent);

  const contributors: { engine: string; role: string; value: unknown }[] = [
    { engine: "smc_score", role: "scoring", value: { gate_score: i.gateScore, decision_gate: i.decisionScoreGate ?? null } },
    { engine: "direction_verdict", role: "gate", value: i.directionVerdict ? { verdict: i.directionVerdict.verdict, confidence: i.directionVerdict.confidence, agreement: i.directionVerdict.agreement } : null },
    { engine: "game_plan", role: "context", value: { alignment: gpAlign, bias: i.gamePlanContext?.bias ?? null } },
    { engine: "unified", role: "detected_only", value: i.unifiedDetected ?? null },
    { engine: "stop", role: "stop_source", value: stopSource },
  ];
  if (pe !== "impulse_zone" && i.impulse?.hasZone) contributors.push({ engine: "impulse_zone", role: "gate", value: { selectedTF: i.impulse.selectedTF ?? null } });
  if (i.promotedFromWatchlist) contributors.push({ engine: "watchlist", role: "origin", value: i.promotedFromWatchlist });

  return {
    signal_id: i.signalId,
    attribution_version: ATTRIBUTION_VERSION,
    user_id: i.userId,
    bot_id: i.botId,
    // A
    symbol: i.symbol,
    direction: i.direction,
    dry_run: i.dryRun,
    scan_cycle_id: i.scanCycleId,
    decision_id: i.decisionId,
    decision_at: i.decisionAt,
    strategy_bar_time: i.strategyBarTime ?? null,
    config_version: i.configVersion,
    strategy_version: i.strategyVersion,
    sizing_version: i.switches.sizingMode === "fill_time"
      ? `fill_time_v1;risk=${i.switches.riskPercent};maxLots=${i.switches.maxLotsPerTrade}`
      : `legacy_placement;risk=${i.legacyRiskPercent}`,
    stop_version: i.switches.stopAnchor === "limit"
      ? `route2_limit_anchor_v1;floor=${num(i.route2Stop?.floorPips)};capMult=${num(i.impulseSlCapMultiplier)}`
      : "market_chain_v1",
    management_version: mgmtOff ? "none_v1"
      : `mgmt_v1;be=${!!i.management.breakEvenEnabled};trail=${!!i.management.trailingStopEnabled};partial=${!!i.management.partialTPEnabled};maxHold=${i.management.maxHoldEnabled ? i.management.maxHoldHours ?? 0 : "off"}`,
    risk_profile_version: i.riskProfileVersion ?? null,
    caps_version: `${i.caps.mode}_${i.caps.maxOpenPositions}_${i.caps.maxPerSymbol}`,
    route: i.promotedFromWatchlist ? "watchlist_promotion" : "route2_pending_confirmation",
    // B
    primary_engine: pe,
    primary_engine_rule: PRIMARY_ENGINE_RULE,
    contributors,
    // C
    game_plan: {
      enabled: i.gamePlanEnabled, alignment: gpAlign,
      bias: i.gamePlanContext?.bias ?? null,
      confidence: num(i.gamePlanContext?.biasConfidence ?? i.gamePlanContext?.confidence),
      focus_pair: i.gamePlanContext?.isFocusPair ?? null,
      dol: i.gamePlanContext?.dol ?? null,
    },
    impulse: {
      detected: !!i.impulse?.hasZone,
      selected_tf: i.impulse?.selectedTF ?? null,
      leg: i.impulse?.impulse ?? null,
      zone: i.impulse?.bestZone ? {
        type: i.impulse.bestZone.type ?? null, low: num(i.impulse.bestZone.low), high: num(i.impulse.bestZone.high),
        fib: num(i.impulse.bestZone.fibLevel), refined_entry: num(i.impulse.bestZone.refinedEntry),
        score: num(i.impulse.bestZone.totalScore), ltf_refined: i.impulse.bestZone.ltfRefined ?? null,
        sr_confirmed: i.impulse.bestZone.srConfirmed ?? null,
      } : null,
    },
    ob_fvg_zone: i.obFvgZone ?? null,
    unified: { detected: i.unifiedDetected ?? null, comparison: i.unifiedComparison ?? null, modifiers_applied: i.switches.unifiedModifiersEnabled && i.entrySource === "unified" },
    score: {
      gate_score: i.gateScore,
      decision_gate: i.decisionScoreGate ?? null,
      components: (i.factors ?? []).filter((f) => f.present).map((f) => ({ name: f.name, weight: f.weight, tier: f.tier ?? null, group: f.group ?? null })),
      tiers: i.tieredScoring ? { tier1: i.tieredScoring.tier1Count ?? null, tier2: i.tieredScoring.tier2Count ?? null, tier3: i.tieredScoring.tier3Count ?? null, tiered_score: i.tieredScoring.tieredScore ?? null } : null,
    },
    gates,
    risk_gate: i.riskGate ?? null,
    legacy_would_admit: legacyWouldAdmit,
    logged_only_would_block: i.loggedOnlyWouldBlock.map((w) => w.gateId),
    // D
    zone_id: i.zoneId ?? null,
    entry_source: i.entrySource,
    entry_depth: num(i.entryDepth),
    limit_price: i.limitPrice,
    stop_price: i.stopPrice,
    stop_source: stopSource,
    stop_distance_pips: Number(stopPips.toFixed(4)),
    stop_floor_pips: num(i.route2Stop?.floorPips),
    stop_cap_pips: num(i.route2Stop?.capPips),
    market_anchored_stop: i.route2Stop?.market ?? null,
    target_price: i.targetPrice,
    raw_rr: num(i.orderRR?.rawRR) ?? Math.abs(i.targetPrice - i.limitPrice) / Math.abs(i.limitPrice - i.stopPrice),
    effective_rr: num(i.orderRR?.effectiveRR) ?? Math.abs(i.targetPrice - i.limitPrice) / Math.abs(i.limitPrice - i.stopPrice),
    cost_in_price: num(i.orderRR?.costInPrice),
    intended_risk_pct: intendedPct,
    intended_risk_usd: num(i.plannedSizing?.riskUsdTarget) ?? Number((i.balance * intendedPct / 100).toFixed(2)),
    planned_uncapped_lots: num(i.plannedSizing?.uncappedLots),
    planned_lots: num(i.plannedSizing?.lots),
    expires_at: i.expiresAt ?? null,
  };
}

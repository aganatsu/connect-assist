import React, { useState } from "react";
import { Target, SlidersHorizontal, Zap, Shield, Timer, RotateCcw, Trash2, ChevronDown, ChevronUp } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { INSTRUMENTS, INSTRUMENT_TYPES, INSTRUMENT_TYPE_LABELS } from "@/lib/marketData";
import { toast } from "sonner";
import { CollapsibleSection, SectionHeader, FieldGroup, ToggleField, ConfigTabProps } from "./ConfigShared";

// ─── Factor Weight Definitions (with tierPts for scoring) ─────────────────────
const FACTOR_WEIGHT_DEFS: { key: string; name: string; defaultWeight: number; tier: 1 | 2 | 3; tierPts: number; description: string }[] = [
  // Tier 1 — Core Setup (×2 pts)
  { key: "marketStructure", name: "Market Structure", defaultWeight: 2.5, tier: 1, tierPts: 2, description: "BOS/CHoCH + entry TF trend alignment (merged)" },
  { key: "orderBlock", name: "Order Block", defaultWeight: 2.0, tier: 1, tierPts: 2, description: "Institutional order blocks" },
  { key: "fairValueGap", name: "Fair Value Gap", defaultWeight: 2.0, tier: 1, tierPts: 2, description: "FVG imbalances" },
  { key: "premiumDiscountFib", name: "Premium/Discount & Fib", defaultWeight: 2.0, tier: 1, tierPts: 2, description: "Fibonacci OTE zones" },
  // Tier 2 — Confirmation (×1 pt)
  { key: "pdPwLevels", name: "PD/PW Levels", defaultWeight: 1.0, tier: 2, tierPts: 1, description: "Previous day/week levels" },
  { key: "liquiditySweep", name: "Liquidity Sweep", defaultWeight: 1.5, tier: 2, tierPts: 1, description: "Liquidity pool sweeps with rejection confirmation" },
  { key: "displacement", name: "Displacement", defaultWeight: 1.0, tier: 2, tierPts: 1, description: "Strong institutional candles" },
  { key: "reversalCandle", name: "Reversal Candle", defaultWeight: 1.5, tier: 2, tierPts: 1, description: "Reversal at key levels — primary entry trigger" },
  { key: "sessionQuality", name: "Session Quality", defaultWeight: 1.5, tier: 2, tierPts: 1, description: "Combined Kill Zone + Silver Bullet + Macro timing (7-tier scoring)" },
  { key: "htfPoiAlignment", name: "HTF POI Alignment", defaultWeight: 2.0, tier: 2, tierPts: 1, description: "Price inside higher-timeframe OB/FVG/Breaker zone" },
  { key: "htfFibPdLiquidity", name: "HTF Fib + PD + Liquidity", defaultWeight: 2.5, tier: 2, tierPts: 1, description: "HTF Fibonacci + Premium/Discount + Liquidity alignment" },
  { key: "confluenceStack", name: "Confluence Stack", defaultWeight: 1.5, tier: 2, tierPts: 1, description: "Multiple POIs overlapping at same price level" },
  // Tier 3 — Bonus (×0.5 pts)
  { key: "currencyStrength", name: "Currency Strength", defaultWeight: 1.5, tier: 3, tierPts: 0.5, description: "FOTSI alignment" },
  { key: "smtDivergence", name: "SMT Divergence", defaultWeight: 1.0, tier: 3, tierPts: 0.5, description: "Correlated pair divergence" },
  { key: "dailyBias", name: "Daily Bias", defaultWeight: 1.0, tier: 3, tierPts: 0.5, description: "HTF daily trend alignment" },
  { key: "breakerBlock", name: "Breaker Block", defaultWeight: 1.0, tier: 3, tierPts: 0.5, description: "Failed OB flip zones" },
  { key: "unicornModel", name: "Unicorn Model", defaultWeight: 1.5, tier: 3, tierPts: 0.5, description: "Breaker + FVG overlap" },
  { key: "volumeProfile", name: "Volume Profile", defaultWeight: 0.75, tier: 3, tierPts: 0.5, description: "TPO-based POC/HVN/LVN (reduced: synthetic data)" },
  { key: "amdPhase", name: "AMD Phase", defaultWeight: 1.0, tier: 3, tierPts: 0.5, description: "Accumulation→Manipulation→Distribution" },
  { key: "judasSwing", name: "Judas Swing", defaultWeight: 0.75, tier: 3, tierPts: 0.5, description: "NY midnight-anchored fake breakout + liquidity sweep" },
  { key: "pullbackHealth", name: "Pullback Health", defaultWeight: 0.5, tier: 3, tierPts: 0.5, description: "Pullback decay analysis — healthy retracement vs exhaustion" },
  { key: "gamePlanKeyLevel", name: "GP Key Level", defaultWeight: 1.0, tier: 2, tierPts: 1, description: "Boosts score when entry is near a game plan key level (OBs, FVGs, PD levels, liquidity). Requires Game Plan enabled." },
];

const TIER_META: { tier: 1 | 2 | 3; label: string; subtitle: string; pts: string; color: string; borderColor: string }[] = [
  { tier: 1, label: "TIER 1 — CORE SETUP", subtitle: "Must-have setup components. At least 2 required for any trade.", pts: "×2 pts", color: "text-amber-500", borderColor: "border-amber-500/40" },
  { tier: 2, label: "TIER 2 — CONFIRMATION", subtitle: "Adds confidence to the setup.", pts: "×1 pt", color: "text-blue-500", borderColor: "border-blue-500/40" },
  { tier: 3, label: "TIER 3 — BONUS", subtitle: "Nice-to-have extras that boost score.", pts: "×0.5 pts", color: "text-emerald-500", borderColor: "border-emerald-500/40" },
];

// ─── Per-Pair Override Definitions ────────────────────────────────────────────
const RECOMMENDED_OVERRIDES: Record<string, Record<string, any>> = {
  'EURJPY': { minTier1Factors: 1, allowSameDirectionStacking: true, maxPerSymbol: 2, minRiskReward: 0.8 },
  'GBPUSD': { protectionMaxDailyLossDollar: 5000, maxConsecutiveLosses: 8 },
  'USDCAD': { minTier1Factors: 2 },
  'USDCHF': { minRiskReward: 0.8 },
  'NZDCHF': { minRiskReward: 0.8 },
  'XAUUSD': { minConfluence: 35 },
  'BTCUSD': { minTier1Factors: 4, allowSameDirectionStacking: false, maxPerSymbol: 1 },
};

const OVERRIDE_FIELDS = [
  { key: 'minRiskReward', label: 'Min R:R', type: 'number', min: 0.1, max: 5, step: 0.1, description: 'Effective R:R threshold (after spread/commission)' },
  { key: 'minTier1Factors', label: 'Min Tier 1', type: 'number', min: 1, max: 5, step: 1, description: 'Minimum core factors (MS, OB, FVG, P/D, HTF)' },
  { key: 'minConfluence', label: 'Min Confluence %', type: 'number', min: 10, max: 80, step: 5, description: 'Score threshold for this pair' },
  { key: 'maxPerSymbol', label: 'Max Per Symbol', type: 'number', min: 1, max: 5, step: 1, description: 'Max concurrent positions for this pair' },
  { key: 'allowSameDirectionStacking', label: 'Allow Stacking', type: 'toggle', description: 'Allow same-direction stacking' },
  { key: 'protectionMaxDailyLossDollar', label: 'Max Daily Loss ($)', type: 'number', min: 50, max: 10000, step: 50, description: 'Pair-specific daily P&L limit' },
  { key: 'maxConsecutiveLosses', label: 'Max Consec Losses', type: 'number', min: 1, max: 15, step: 1, description: 'Pair-specific consecutive loss cooldown' },
] as const;

// ─── Component ────────────────────────────────────────────────────────────────
export function EnterTab({ config, setConfig, updateField }: ConfigTabProps) {
  const weights: Record<string, number> = config.factorWeights || {};
  const hasWeightOverrides = Object.keys(weights).length > 0;
  const [expandedPair, setExpandedPair] = useState<string | null>(null);
  const overrides: Record<string, Record<string, any>> = config.pairGateOverrides || {};

  // Factor weight helpers
  const updateWeight = (key: string, value: number) => {
    setConfig((prev: any) => ({
      ...prev,
      factorWeights: { ...(prev.factorWeights || {}), [key]: Math.round(value * 100) / 100 },
    }));
  };
  const resetAllWeights = () => {
    setConfig((prev: any) => ({ ...prev, factorWeights: {} }));
    toast.info("All factor weights reset to defaults");
  };
  const resetSingleWeight = (key: string) => {
    setConfig((prev: any) => {
      const next = { ...(prev.factorWeights || {}) };
      delete next[key];
      return { ...prev, factorWeights: next };
    });
  };

  // Pair override helpers
  const updateOverride = (symbol: string, field: string, value: any) => {
    setConfig((prev: any) => {
      const current = { ...(prev.pairGateOverrides || {}) };
      const pairCfg = { ...(current[symbol] || {}) };
      if (value === undefined || value === '' || value === null) {
        delete pairCfg[field];
      } else {
        pairCfg[field] = value;
      }
      if (Object.keys(pairCfg).length === 0) {
        delete current[symbol];
      } else {
        current[symbol] = pairCfg;
      }
      return { ...prev, pairGateOverrides: current };
    });
  };
  const clearPairOverrides = (symbol: string) => {
    setConfig((prev: any) => {
      const current = { ...(prev.pairGateOverrides || {}) };
      delete current[symbol];
      return { ...prev, pairGateOverrides: current };
    });
  };
  const applyRecommendations = () => {
    setConfig((prev: any) => ({
      ...prev,
      pairGateOverrides: { ...(prev.pairGateOverrides || {}), ...RECOMMENDED_OVERRIDES },
    }));
    toast.success('Applied data-driven recommendations for 7 pairs');
  };
  const hasOverride = (symbol: string) => {
    const o = overrides[symbol];
    return o && Object.keys(o).length > 0;
  };
  const enabledInstruments = config.instruments?.enabledPairs || INSTRUMENTS.map((i: any) => i.symbol);

  return (
    <div className="space-y-3">
      {/* ── Scoring Engine ── */}
      <CollapsibleSection
        id="scoring"
        title="Scoring Engine"
        subtitle="Confluence threshold, tier gates, normalization"
        icon={<Target className="h-4 w-4" />}
        defaultOpen={true}
      >
        <FieldGroup label="Confluence Threshold (%)" description="Minimum score percentage to take a trade">
          <div className="flex items-center gap-4">
            <Slider value={[config.strategy?.confluenceThreshold ?? 55]} onValueChange={v => updateField('strategy', 'confluenceThreshold', v[0])} min={20} max={90} step={5} className="flex-1" />
            <span className="text-sm font-mono font-bold text-primary w-12 text-right">{config.strategy?.confluenceThreshold ?? 55}%</span>
          </div>
        </FieldGroup>
        <FieldGroup label="Min Zone Score" description="Minimum impulse zone quality score (0-9)">
          <div className="flex items-center gap-4">
            <Slider value={[config.strategy?.minZoneScore ?? 4]} onValueChange={v => updateField('strategy', 'minZoneScore', v[0])} min={0} max={9} step={0.5} className="flex-1" />
            <span className="text-sm font-mono font-bold text-primary w-12 text-right">{config.strategy?.minZoneScore ?? 4}</span>
          </div>
        </FieldGroup>
        <ToggleField label="Tier 1 Gate" description="Require minimum core factors to pass" checked={config.strategy?.tier1GateEnabled ?? true} onChange={v => updateField('strategy', 'tier1GateEnabled', v)} />
        {(config.strategy?.tier1GateEnabled ?? true) && (
          <FieldGroup label="Min Tier 1 Factors" description="How many core factors must fire">
            <div className="flex items-center gap-4">
              <Slider value={[config.strategy?.minTier1Factors ?? 3]} onValueChange={v => updateField('strategy', 'minTier1Factors', v[0])} min={1} max={5} step={1} className="flex-1" />
              <span className="text-sm font-mono font-bold w-8 text-right">{config.strategy?.minTier1Factors ?? 3}</span>
            </div>
          </FieldGroup>
        )}
        <div className="border-t border-border pt-3 space-y-3">
          <ToggleField label="Score Normalization" description="Normalize raw score to 0-100 scale" checked={config.strategy?.normalizationEnabled ?? true} onChange={v => updateField('strategy', 'normalizationEnabled', v)} />
          <ToggleField label="Thesis Conviction" description="Bonus/penalty based on thesis alignment" checked={config.strategy?.thesisConvictionEnabled ?? false} onChange={v => updateField('strategy', 'thesisConvictionEnabled', v)} />
        </div>
      </CollapsibleSection>

      {/* ── Factor Weights (Full) ── */}
      <CollapsibleSection
        id="factorWeights"
        title="Factor Weights"
        subtitle="Fine-tune how much each confluence factor contributes to the overall score"
        icon={<SlidersHorizontal className="h-4 w-4" />}
        defaultOpen={false}
      >
        <div className="flex items-center justify-between">
          <SectionHeader title="Factor Weights" description="AI Advisor recommendations can auto-apply here." />
          {hasWeightOverrides && (
            <Button variant="ghost" size="sm" className="text-xs text-muted-foreground gap-1" onClick={resetAllWeights}>
              <RotateCcw className="h-3 w-3" /> Reset All
            </Button>
          )}
        </div>
        {/* How scoring works */}
        <div className="rounded border border-border bg-muted/20 p-3 space-y-1.5">
          <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-wider">How Tiered Scoring Works</p>
          <p className="text-[10px] text-muted-foreground">
            Each factor has a <span className="font-bold text-foreground">tier base value</span> (T1 = 2pts, T2 = 1pt, T3 = 0.5pts) that determines its importance.
            Your <span className="font-bold text-foreground">custom weight</span> multiplies this base value.
            For example, Market Structure at weight 2.5 scores <span className="font-mono">2.5 × 2pts = 5pts</span> when present.
          </p>
          <p className="text-[10px] text-muted-foreground">
            The final score is the sum of all present factors' weighted points, expressed as a percentage of the maximum possible.
            No group caps — your weights work directly.
          </p>
        </div>
        {/* Tier sections */}
        {TIER_META.map(tm => {
          const tierFactors = FACTOR_WEIGHT_DEFS.filter(f => f.tier === tm.tier);
          return (
            <div key={tm.tier} className={`border ${tm.borderColor} p-4 space-y-3`}>
              <div className="flex items-center justify-between">
                <div>
                  <p className={`text-[10px] uppercase tracking-wider font-bold ${tm.color}`}>{tm.label}</p>
                  <p className="text-[10px] text-muted-foreground">{tm.subtitle}</p>
                </div>
                <Badge variant="outline" className={`text-[9px] font-mono font-bold ${tm.color} border-current`}>{tm.pts}</Badge>
              </div>
              {tierFactors.map(factor => {
                const currentValue = weights[factor.key] ?? factor.defaultWeight;
                const isOverridden = weights[factor.key] !== undefined;
                const maxSlider = Math.max(factor.defaultWeight * 2, 3);
                const effectivePoints = (currentValue * factor.tierPts).toFixed(1);
                return (
                  <div key={factor.key} className={`space-y-1 p-2 -mx-2 transition-colors ${isOverridden ? "bg-primary/5 border border-primary/20 rounded" : ""}`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium">{factor.name}</span>
                        {isOverridden && (
                          <Badge variant="secondary" className="h-4 px-1.5 text-[9px] font-mono">custom</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[9px] text-muted-foreground font-mono">{currentValue.toFixed(2)} × {factor.tierPts}pts =</span>
                        <span className="text-sm font-mono font-bold text-primary w-14 text-right">{effectivePoints}pts</span>
                        {isOverridden && (
                          <button
                            onClick={() => resetSingleWeight(factor.key)}
                            className="text-muted-foreground hover:text-foreground"
                            title={`Reset to default (${factor.defaultWeight})`}
                          >
                            <RotateCcw className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    </div>
                    <p className="text-[10px] text-muted-foreground">{factor.description} (default: {factor.defaultWeight})</p>
                    <Slider
                      value={[currentValue]}
                      onValueChange={v => updateWeight(factor.key, v[0])}
                      min={0}
                      max={maxSlider}
                      step={0.25}
                      className="mt-1"
                    />
                    <div className="flex justify-between text-[9px] text-muted-foreground">
                      <span>0 (disabled)</span>
                      <span>{factor.defaultWeight} (default)</span>
                      <span>{maxSlider} (max)</span>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
        {/* Gates (not weight-adjustable) */}
        <div className="border border-border p-4 space-y-3">
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">GATES (Pass/Fail)</p>
            <p className="text-[10px] text-muted-foreground">These are binary checks — not scored. A failed gate rejects the trade regardless of score.</p>
          </div>
          <div className="space-y-1 p-2 -mx-2 opacity-70">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium">Tier 1 Minimum</span>
              <Badge variant="outline" className="h-4 px-1.5 text-[9px] font-mono">gate</Badge>
            </div>
            <p className="text-[10px] text-muted-foreground">At least 2 Tier 1 (Core) factors must be present for any trade to pass. Not adjustable.</p>
          </div>
          <div className="space-y-1 p-2 -mx-2 opacity-70">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium">Regime Alignment</span>
              <Badge variant="outline" className="h-4 px-1.5 text-[9px] font-mono">gate</Badge>
            </div>
            <p className="text-[10px] text-muted-foreground">Market regime must align with trade direction (e.g., trending market for trend trades). Fails if regime conflicts.</p>
          </div>
        </div>
        {/* Spread Quality (info-only) */}
        <div className="border border-border/50 p-4 space-y-2 opacity-60">
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">INFO ONLY</p>
          </div>
          <div className="space-y-1 p-2 -mx-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium">Spread Quality</span>
              <Badge variant="outline" className="h-4 px-1.5 text-[9px] font-mono text-muted-foreground">info</Badge>
            </div>
            <p className="text-[10px] text-muted-foreground">Shows indicative spread-to-ATR ratio from market data. Does not block trades — your actual broker spread (ECN/raw) is checked at execution time. Displayed for awareness only.</p>
          </div>
        </div>
      </CollapsibleSection>

      {/* ── Zone Engine ── */}
      <CollapsibleSection
        id="zoneEngine"
        title="Zone Engine"
        subtitle="Impulse zone gate, fib retracement, zone quality"
        icon={<Zap className="h-4 w-4" />}
        defaultOpen={false}
      >
        <FieldGroup label="Impulse Zone Gate Mode" description="How strictly the zone requirement is enforced">
          <Select value={config.strategy?.impulseZoneGateMode ?? 'hard'} onValueChange={(v: string) => updateField('strategy', 'impulseZoneGateMode', v)}>
            <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="hard">Hard — no zone = skip pair</SelectItem>
              <SelectItem value="soft">Soft — score penalty only</SelectItem>
              <SelectItem value="off">Off — zones informational</SelectItem>
            </SelectContent>
          </Select>
        </FieldGroup>
        <FieldGroup label="Max Fib Retracement" description="How deep a zone can sit inside the impulse">
          <Select value={String(config.strategy?.fibMaxRetracement ?? 0.786)} onValueChange={(v: string) => updateField('strategy', 'fibMaxRetracement', parseFloat(v))}>
            <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="0.786">78.6% — Standard (OTE)</SelectItem>
              <SelectItem value="0.886">88.6% — Deep (more zones)</SelectItem>
              <SelectItem value="1">100% — To impulse origin</SelectItem>
            </SelectContent>
          </Select>
        </FieldGroup>
        <ToggleField label="Require Liquidity Sweep" description="Block entry until entry-trigger liquidity pool is swept" checked={config.strategy?.requireLiquiditySweep ?? false} onChange={v => updateField('strategy', 'requireLiquiditySweep', v)} />
        <div className="border-t border-border pt-3 space-y-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Zone Quality</p>
          <div className="grid grid-cols-2 gap-3">
            <FieldGroup label="Quality Threshold (0-100)">
              <div className="flex items-center gap-3">
                <Slider value={[config.strategy?.zoneQualityThreshold ?? 40]} onValueChange={v => updateField('strategy', 'zoneQualityThreshold', v[0])} min={0} max={100} step={5} className="flex-1" />
                <span className="text-[11px] font-mono w-8 text-right">{config.strategy?.zoneQualityThreshold ?? 40}</span>
              </div>
            </FieldGroup>
            <FieldGroup label="Max Age (bars)">
              <Input type="number" value={config.strategy?.zoneMaxAgeBars ?? 200} onChange={e => updateField('strategy', 'zoneMaxAgeBars', parseInt(e.target.value) || 0)} min={0} max={1000} step={50} className="h-9 text-sm" />
            </FieldGroup>
            <FieldGroup label="Min Body Ratio">
              <div className="flex items-center gap-3">
                <Slider value={[config.strategy?.zoneMinBodyRatio ?? 0.5]} onValueChange={v => updateField('strategy', 'zoneMinBodyRatio', v[0])} min={0.1} max={0.9} step={0.05} className="flex-1" />
                <span className="text-[11px] font-mono w-8 text-right">{(config.strategy?.zoneMinBodyRatio ?? 0.5).toFixed(2)}</span>
              </div>
            </FieldGroup>
            <FieldGroup label="Min Displacement (ATR)">
              <div className="flex items-center gap-3">
                <Slider value={[config.strategy?.zoneMinDisplacementATR ?? 1.5]} onValueChange={v => updateField('strategy', 'zoneMinDisplacementATR', v[0])} min={0.5} max={5.0} step={0.25} className="flex-1" />
                <span className="text-[11px] font-mono w-8 text-right">{config.strategy?.zoneMinDisplacementATR ?? 1.5}×</span>
              </div>
            </FieldGroup>
          </div>
        </div>
      </CollapsibleSection>

      {/* ── Entry Timing ── */}
      <CollapsibleSection
        id="entryTiming"
        title="Entry Timing"
        subtitle="Pending orders, zone proximity, confirmation method"
        icon={<Timer className="h-4 w-4" />}
        defaultOpen={false}
      >
        <ToggleField label="Pending Zone Orders" description="Place limit orders at zone instead of waiting for market fill" checked={config.entry?.pendingZoneOrders ?? false} onChange={v => updateField('entry', 'pendingZoneOrders', v)} />
        <ToggleField label="Market Fill at Zone" description="Enter at market when price touches zone" checked={config.entry?.marketFillAtZone ?? true} onChange={v => updateField('entry', 'marketFillAtZone', v)} />
        <FieldGroup label="Zone Proximity (ATR)" description="How close price must be to zone for entry">
          <div className="flex items-center gap-4">
            <Slider value={[config.entry?.zoneProximityATR ?? 0.30]} onValueChange={v => updateField('entry', 'zoneProximityATR', v[0])} min={0.05} max={1.0} step={0.05} className="flex-1" />
            <span className="text-sm font-mono font-bold w-12 text-right">{(config.entry?.zoneProximityATR ?? 0.30).toFixed(2)}×</span>
          </div>
        </FieldGroup>
        <FieldGroup label="Zone Watch Expiry (hours)" description="How long to watch a zone before giving up">
          <Input type="number" value={config.entry?.zoneWatchExpiry ?? 4} onChange={e => updateField('entry', 'zoneWatchExpiry', parseInt(e.target.value) || 4)} min={1} max={48} step={1} className="h-9 text-sm" />
        </FieldGroup>
        <FieldGroup label="Cooldown (minutes)" description="Minimum time between trades on same pair">
          <Input type="number" value={config.entry?.cooldownMinutes ?? 60} onChange={e => updateField('entry', 'cooldownMinutes', parseInt(e.target.value) || 0)} min={0} max={480} step={15} className="h-9 text-sm" />
        </FieldGroup>
        <div className="border-t border-border pt-3 space-y-3">
          <FieldGroup label="Confirmation Method" description="How entry is confirmed once price reaches zone">
            <Select value={config.entry?.confirmationMethod ?? "choch"} onValueChange={v => updateField('entry', 'confirmationMethod', v)}>
              <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="choch">CHoCH / BOS (Default)</SelectItem>
                <SelectItem value="indicators">Indicator Consensus</SelectItem>
                <SelectItem value="choch_and_indicators">CHoCH + Indicators (Both)</SelectItem>
              </SelectContent>
            </Select>
          </FieldGroup>
        </div>
      </CollapsibleSection>

      {/* ── Per-Pair Gate Overrides (Full) ── */}
      <CollapsibleSection
        id="pairOverrides"
        title="Per-Pair Gate Overrides"
        subtitle="Set symbol-specific gate thresholds. Empty fields use the global setting."
        icon={<Shield className="h-4 w-4" />}
        badge={Object.keys(overrides).length > 0 ? <Badge variant="outline" className="text-[9px] text-primary border-primary/40">{Object.keys(overrides).length} pairs</Badge> : undefined}
        defaultOpen={false}
      >
        {/* Quick Apply Recommendations */}
        <div className="border border-dashed border-primary/40 rounded p-3 bg-primary/5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-primary">Data-Driven Recommendations</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Apply optimized overrides based on rejected setups analysis (EUR/JPY, GBP/USD, USD/CAD, USD/CHF, NZD/CHF, XAU/USD, BTC/USD)
              </p>
            </div>
            <Button variant="outline" size="sm" className="text-[10px] h-7 shrink-0 border-primary/40 text-primary hover:bg-primary/10" onClick={applyRecommendations}>
              Apply All
            </Button>
          </div>
        </div>
        {/* Pair list grouped by type */}
        {INSTRUMENT_TYPES.map(type => {
          const typeInstruments = INSTRUMENTS.filter((i: any) => i.type === type && enabledInstruments.includes(i.symbol));
          if (typeInstruments.length === 0) return null;
          return (
            <div key={type} className="space-y-1">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">{INSTRUMENT_TYPE_LABELS[type]}</p>
              <div className="space-y-1">
                {typeInstruments.map((inst: any) => {
                  const isExpanded = expandedPair === inst.symbol;
                  const pairOverride = overrides[inst.symbol] || {};
                  const hasOvr = hasOverride(inst.symbol);
                  return (
                    <div key={inst.symbol} className={`border transition-colors ${hasOvr ? 'border-primary/40 bg-primary/5' : 'border-border'}`}>
                      <button
                        className="w-full flex items-center justify-between px-3 py-2 hover:bg-secondary/30 transition-colors"
                        onClick={() => setExpandedPair(isExpanded ? null : inst.symbol)}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium w-20">{inst.symbol}</span>
                          {hasOvr && (
                            <Badge variant="secondary" className="text-[9px] h-4 px-1.5">
                              {Object.keys(pairOverride).length} override{Object.keys(pairOverride).length > 1 ? 's' : ''}
                            </Badge>
                          )}
                        </div>
                        {isExpanded ? <ChevronUp className="h-3 w-3 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 text-muted-foreground" />}
                      </button>
                      {isExpanded && (
                        <div className="px-3 pb-3 pt-1 border-t border-border/50 space-y-3">
                          <div className="grid grid-cols-2 gap-3">
                            {OVERRIDE_FIELDS.map(field => {
                              if (field.type === 'toggle') {
                                const val = pairOverride[field.key];
                                return (
                                  <div key={field.key} className="col-span-2">
                                    <div className="flex items-center justify-between gap-3 p-2 border border-border rounded">
                                      <div>
                                        <p className="text-[11px] font-medium">{field.label}</p>
                                        <p className="text-[9px] text-muted-foreground">{field.description}</p>
                                      </div>
                                      <div className="flex items-center gap-2">
                                        {val !== undefined && (
                                          <button className="text-[9px] text-muted-foreground hover:text-destructive" onClick={() => updateOverride(inst.symbol, field.key, undefined)}>✕</button>
                                        )}
                                        <Switch
                                          checked={val ?? config.risk?.allowSameDirectionStacking ?? false}
                                          onCheckedChange={v => updateOverride(inst.symbol, field.key, v)}
                                          className="shrink-0"
                                        />
                                      </div>
                                    </div>
                                  </div>
                                );
                              }
                              const val = pairOverride[field.key];
                              return (
                                <div key={field.key} className="space-y-1">
                                  <Label className="text-[10px] font-medium">{field.label}</Label>
                                  <Input
                                    type="number"
                                    placeholder="Global"
                                    value={val ?? ''}
                                    onChange={e => {
                                      const v = e.target.value === '' ? undefined : parseFloat(e.target.value);
                                      updateOverride(inst.symbol, field.key, v);
                                    }}
                                    step={field.step}
                                    min={field.min}
                                    max={field.max}
                                    className="h-7 text-[11px]"
                                  />
                                  <p className="text-[9px] text-muted-foreground">{field.description}</p>
                                </div>
                              );
                            })}
                          </div>
                          {hasOvr && (
                            <div className="flex justify-end">
                              <Button variant="ghost" size="sm" className="text-[10px] h-6 text-destructive hover:text-destructive" onClick={() => clearPairOverrides(inst.symbol)}>
                                <Trash2 className="h-3 w-3 mr-1" /> Clear All Overrides
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        {/* Summary of active overrides */}
        {Object.keys(overrides).length > 0 && (
          <div className="border border-border rounded p-3 bg-secondary/30">
            <p className="text-[11px] text-muted-foreground">
              <strong className="text-foreground">Active overrides:</strong>{' '}
              {Object.entries(overrides).map(([sym, o]) => (
                <span key={sym} className="inline-block mr-2">
                  <Badge variant="outline" className="text-[9px] h-4">{sym}: {Object.keys(o).length} field{Object.keys(o).length > 1 ? 's' : ''}</Badge>
                </span>
              ))}
            </p>
          </div>
        )}
      </CollapsibleSection>
    </div>
  );
}

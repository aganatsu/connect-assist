import React from "react";
import { Target, SlidersHorizontal, Zap, Shield, Timer } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { CollapsibleSection, FieldGroup, ToggleField, ConfigTabProps } from "./ConfigShared";

// ─── Factor Weight Definitions ────────────────────────────────────────────────
const FACTOR_WEIGHT_DEFS: { key: string; name: string; defaultWeight: number; tier: 1 | 2 | 3; description: string }[] = [
  { key: "marketStructure", name: "Market Structure", defaultWeight: 2.5, tier: 1, description: "BOS/CHoCH + entry TF trend alignment" },
  { key: "orderBlock", name: "Order Block", defaultWeight: 2.0, tier: 1, description: "Institutional order blocks" },
  { key: "fairValueGap", name: "Fair Value Gap", defaultWeight: 2.0, tier: 1, description: "FVG imbalances" },
  { key: "premiumDiscountFib", name: "Premium/Discount & Fib", defaultWeight: 2.0, tier: 1, description: "Fibonacci OTE zones" },
  { key: "pdPwLevels", name: "PD/PW Levels", defaultWeight: 1.0, tier: 2, description: "Previous day/week levels" },
  { key: "liquiditySweep", name: "Liquidity Sweep", defaultWeight: 1.5, tier: 2, description: "Liquidity pool sweeps" },
  { key: "displacement", name: "Displacement", defaultWeight: 1.0, tier: 2, description: "Strong institutional candles" },
  { key: "reversalCandle", name: "Reversal Candle", defaultWeight: 1.5, tier: 2, description: "Reversal at key levels" },
  { key: "sessionQuality", name: "Session Quality", defaultWeight: 1.5, tier: 2, description: "Kill Zone + Silver Bullet + Macro timing" },
  { key: "htfPoiAlignment", name: "HTF POI Alignment", defaultWeight: 2.0, tier: 2, description: "Price inside HTF OB/FVG/Breaker" },
  { key: "htfFibPdLiquidity", name: "HTF Fib + PD + Liquidity", defaultWeight: 2.5, tier: 2, description: "HTF Fibonacci + Premium/Discount + Liquidity" },
  { key: "confluenceStack", name: "Confluence Stack", defaultWeight: 1.5, tier: 2, description: "Multiple POIs overlapping" },
  { key: "currencyStrength", name: "Currency Strength", defaultWeight: 1.5, tier: 3, description: "FOTSI alignment" },
  { key: "smtDivergence", name: "SMT Divergence", defaultWeight: 1.0, tier: 3, description: "Correlated pair divergence" },
  { key: "dailyBias", name: "Daily Bias", defaultWeight: 1.0, tier: 3, description: "HTF daily trend alignment" },
  { key: "breakerBlock", name: "Breaker Block", defaultWeight: 1.0, tier: 3, description: "Failed OB flip zones" },
  { key: "unicornModel", name: "Unicorn Model", defaultWeight: 1.5, tier: 3, description: "Breaker + FVG overlap" },
  { key: "volumeProfile", name: "Volume Profile", defaultWeight: 0.75, tier: 3, description: "TPO-based POC/HVN/LVN" },
  { key: "amdPhase", name: "AMD Phase", defaultWeight: 1.0, tier: 3, description: "Accumulation→Manipulation→Distribution" },
  { key: "judasSwing", name: "Judas Swing", defaultWeight: 0.75, tier: 3, description: "NY midnight fake breakout" },
  { key: "pullbackHealth", name: "Pullback Health", defaultWeight: 0.5, tier: 3, description: "Pullback decay analysis" },
  { key: "gamePlanKeyLevel", name: "GP Key Level", defaultWeight: 1.0, tier: 2, description: "Entry near game plan key level" },
];

const TIER_COLORS = { 1: "border-amber-500/40 bg-amber-500/5", 2: "border-blue-500/40 bg-blue-500/5", 3: "border-emerald-500/40 bg-emerald-500/5" };
const TIER_LABELS = { 1: "CORE", 2: "CONFIRM", 3: "BONUS" };

export function EnterTab({ config, setConfig, updateField }: ConfigTabProps) {
  const weights = config.factorWeights || {};

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

      {/* ── Factor Weights ── */}
      <CollapsibleSection
        id="factorWeights"
        title="Factor Weights"
        subtitle="How much each confluence factor contributes to score"
        icon={<SlidersHorizontal className="h-4 w-4" />}
        defaultOpen={false}
      >
        {([1, 2, 3] as const).map(tier => (
          <div key={tier} className={`border rounded-md p-3 space-y-2 ${TIER_COLORS[tier]}`}>
            <p className="text-[10px] font-bold uppercase tracking-wider">
              {TIER_LABELS[tier]} — Tier {tier}
            </p>
            <div className="space-y-2">
              {FACTOR_WEIGHT_DEFS.filter(f => f.tier === tier).map(factor => (
                <div key={factor.key} className="flex items-center gap-3">
                  <span className="text-[11px] font-medium w-32 shrink-0 truncate" title={factor.description}>{factor.name}</span>
                  <Slider
                    value={[weights[factor.key] ?? factor.defaultWeight]}
                    onValueChange={v => setConfig((prev: any) => ({ ...prev, factorWeights: { ...prev.factorWeights, [factor.key]: v[0] } }))}
                    min={0} max={5} step={0.25} className="flex-1"
                  />
                  <span className="text-[11px] font-mono w-8 text-right">{(weights[factor.key] ?? factor.defaultWeight).toFixed(1)}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
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
                <Slider value={[config.strategy?.zoneQualityThreshold ?? 40]} onValueChange={v => updateField('strategy', 'zoneQualityThreshold', v[0])} min={10} max={90} step={5} className="flex-1" />
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

      {/* ── Per-Pair Gate Overrides ── */}
      <CollapsibleSection
        id="pairOverrides"
        title="Per-Pair Gate Overrides"
        subtitle="Override gate settings for specific instruments"
        icon={<Shield className="h-4 w-4" />}
        defaultOpen={false}
      >
        <p className="text-[10px] text-muted-foreground">
          Per-pair overrides allow you to disable specific gates or adjust thresholds for individual instruments.
          This section uses the full Per-Pair Gates editor from the original config.
        </p>
        <p className="text-[10px] text-muted-foreground italic">
          Use the search bar to find specific pair settings, or expand this section in the full editor.
        </p>
      </CollapsibleSection>
    </div>
  );
}

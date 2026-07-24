import React from "react";
import { Globe, Clock, TrendingUp, BarChart3, Crosshair, Sparkles, Layers } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { CollapsibleSection, FieldGroup, ToggleField, StatusBadge, ConfigTabProps } from "./ConfigShared";

// ─── Instruments Data ─────────────────────────────────────────────────────────
const FOREX_PAIRS = ["EURUSD","GBPUSD","USDJPY","AUDUSD","USDCAD","NZDUSD","USDCHF","EURGBP","EURJPY","GBPJPY","AUDJPY","CADJPY","EURAUD","EURNZD","GBPAUD","GBPNZD","GBPCAD","AUDNZD","AUDCAD","NZDCAD","NZDJPY","CHFJPY","EURCAD","EURCHF","GBPCHF","AUDCHF","CADCHF","NZDCHF"];
const CRYPTO_PAIRS = ["BTCUSD","ETHUSD","SOLUSD","XRPUSD"];
const COMMODITY_PAIRS = ["XAUUSD","XAGUSD","USOIL","UKOIL"];
const INDEX_PAIRS = ["US30","US500","US100","GER40","UK100","JPN225"];

const INSTRUMENT_GROUPS = [
  { label: "Forex Majors & Crosses", key: "forex", pairs: FOREX_PAIRS },
  { label: "Crypto", key: "crypto", pairs: CRYPTO_PAIRS },
  { label: "Commodities", key: "commodity", pairs: COMMODITY_PAIRS },
  { label: "Indices", key: "index", pairs: INDEX_PAIRS },
];

export function ScanTab({ config, setConfig, updateField }: ConfigTabProps) {
  // Count active instruments
  const enabledPairs = config.instruments?.enabledPairs || [];
  const totalPairs = FOREX_PAIRS.length + CRYPTO_PAIRS.length + COMMODITY_PAIRS.length + INDEX_PAIRS.length;
  const activePairCount = enabledPairs.length || totalPairs;

  // Count active sessions
  const sessions = config.sessions || {};
  const activeSessionCount = [sessions.asian !== false, sessions.london !== false, sessions.newYork !== false, sessions.offHours === true].filter(Boolean).length;

  // Count active analysis modules
  const strat = config.strategy || {};
  const analysisModules = [
    strat.enableOB !== false, strat.enableFVG !== false, strat.enableLiquidity !== false,
    strat.enableStructure !== false, strat.enableDisplacement !== false, strat.enableBreaker ?? false,
    strat.enableUnicorn ?? false, strat.enableSession !== false, strat.enableSMT ?? false,
    strat.enableVolumeProfile ?? false, strat.enableTrendDirection !== false, strat.enableDailyBias !== false,
    strat.enableAMD !== false, strat.enableFOTSI ?? false,
  ];
  const activeModuleCount = analysisModules.filter(Boolean).length;

  return (
    <div className="space-y-3">
      {/* ── Instruments ── */}
      <CollapsibleSection
        id="instruments"
        title="Instruments"
        subtitle="Which pairs the bot scans"
        icon={<Globe className="h-4 w-4" />}
        badge={<StatusBadge count={activePairCount} total={totalPairs} label="pairs" />}
        defaultOpen={false}
      >
        {INSTRUMENT_GROUPS.map(group => (
          <div key={group.key} className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">{group.label}</p>
              <button
                className="text-[9px] text-primary hover:underline"
                onClick={() => {
                  const allEnabled = group.pairs.every(p => enabledPairs.includes(p) || enabledPairs.length === 0);
                  if (allEnabled && enabledPairs.length > 0) {
                    setConfig((prev: any) => ({
                      ...prev,
                      instruments: {
                        ...prev.instruments,
                        enabledPairs: (prev.instruments?.enabledPairs || []).filter((p: string) => !group.pairs.includes(p)),
                      },
                    }));
                  } else {
                    const current = new Set(enabledPairs.length > 0 ? enabledPairs : [...FOREX_PAIRS, ...CRYPTO_PAIRS, ...COMMODITY_PAIRS, ...INDEX_PAIRS]);
                    group.pairs.forEach(p => current.add(p));
                    setConfig((prev: any) => ({
                      ...prev,
                      instruments: { ...prev.instruments, enabledPairs: Array.from(current) },
                    }));
                  }
                }}
              >
                Toggle All
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {group.pairs.map(pair => {
                const isEnabled = enabledPairs.length === 0 || enabledPairs.includes(pair);
                return (
                  <button
                    key={pair}
                    onClick={() => {
                      const current = new Set(enabledPairs.length > 0 ? enabledPairs : [...FOREX_PAIRS, ...CRYPTO_PAIRS, ...COMMODITY_PAIRS, ...INDEX_PAIRS]);
                      if (current.has(pair)) current.delete(pair);
                      else current.add(pair);
                      setConfig((prev: any) => ({
                        ...prev,
                        instruments: { ...prev.instruments, enabledPairs: Array.from(current) },
                      }));
                    }}
                    className={`px-2 py-1 text-[10px] font-mono rounded border transition-colors ${
                      isEnabled
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : "border-border bg-muted/30 text-muted-foreground"
                    }`}
                  >
                    {pair}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {/* Filters */}
        <div className="border-t border-border pt-4 space-y-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Filters</p>
          <ToggleField label="Spread Filter" description="Skip pairs with spread above threshold" checked={config.instruments?.spreadFilterEnabled ?? true} onChange={v => updateField('instruments', 'spreadFilterEnabled', v)} />
          {(config.instruments?.spreadFilterEnabled ?? true) && (
            <FieldGroup label="Max Spread (pips)">
              <Input type="number" value={config.instruments?.maxSpreadPips ?? 3} onChange={e => updateField('instruments', 'maxSpreadPips', parseFloat(e.target.value) || 0)} step={0.5} min={0.5} className="h-9 text-sm" />
            </FieldGroup>
          )}
          <ToggleField label="ATR Filter" description="Skip pairs outside ATR range" checked={config.instruments?.atrFilterEnabled ?? false} onChange={v => updateField('instruments', 'atrFilterEnabled', v)} />
          {config.instruments?.atrFilterEnabled && (
            <div className="grid grid-cols-2 gap-3">
              <FieldGroup label="ATR Min (pips)">
                <Input type="number" value={config.instruments?.atrFilterMinPips ?? 5} onChange={e => updateField('instruments', 'atrFilterMinPips', parseFloat(e.target.value) || 0)} step={1} min={0} className="h-9 text-sm" />
              </FieldGroup>
              <FieldGroup label="ATR Max (pips)">
                <Input type="number" value={config.instruments?.atrFilterMaxPips ?? 50} onChange={e => updateField('instruments', 'atrFilterMaxPips', parseFloat(e.target.value) || 0)} step={1} min={0} className="h-9 text-sm" />
              </FieldGroup>
            </div>
          )}
          <ToggleField label="Correlation Filter" description="Avoid correlated pairs" checked={config.instruments?.correlationFilterEnabled ?? false} onChange={v => updateField('instruments', 'correlationFilterEnabled', v)} />
        </div>
      </CollapsibleSection>

      {/* ── Sessions & Timing ── */}
      <CollapsibleSection
        id="sessions"
        title="Sessions & Timing"
        subtitle="When the bot is allowed to trade"
        icon={<Clock className="h-4 w-4" />}
        badge={<StatusBadge count={activeSessionCount} total={4} label="sessions" />}
        defaultOpen={false}
      >
        <div className="grid grid-cols-2 gap-3">
          <ToggleField label="Asian Session" checked={config.sessions?.asian !== false} onChange={v => updateField('sessions', 'asian', v)} />
          <ToggleField label="London Session" checked={config.sessions?.london !== false} onChange={v => updateField('sessions', 'london', v)} />
          <ToggleField label="New York Session" checked={config.sessions?.newYork !== false} onChange={v => updateField('sessions', 'newYork', v)} />
          <ToggleField label="Off-Hours" description="Trade outside main sessions" checked={config.sessions?.offHours ?? false} onChange={v => updateField('sessions', 'offHours', v)} />
        </div>
        <div className="border-t border-border pt-3 space-y-3">
          <ToggleField label="News Event Filter" description="Pause trading around high-impact news" checked={config.sessions?.newsFilterEnabled ?? true} onChange={v => updateField('sessions', 'newsFilterEnabled', v)} />
          {(config.sessions?.newsFilterEnabled ?? true) && (
            <FieldGroup label="News Buffer (minutes)" description="Minutes before/after news to avoid">
              <Input type="number" value={config.sessions?.newsBufferMinutes ?? 30} onChange={e => updateField('sessions', 'newsBufferMinutes', parseInt(e.target.value) || 0)} min={5} max={120} step={5} className="h-9 text-sm" />
            </FieldGroup>
          )}
        </div>
        <div className="border-t border-border pt-3">
          <FieldGroup label="Scan Interval (minutes)" description="How often the bot scans for new setups">
            <Input type="number" value={config.entry?.scanIntervalMinutes ?? 5} onChange={e => updateField('entry', 'scanIntervalMinutes', Number(e.target.value))} min={1} max={60} step={1} className="h-9 text-sm" />
          </FieldGroup>
        </div>
      </CollapsibleSection>

      {/* ── Direction & Bias ── */}
      <CollapsibleSection
        id="direction"
        title="Direction & Bias"
        subtitle="HTF bias, premium/discount, regime scoring"
        icon={<TrendingUp className="h-4 w-4" />}
        defaultOpen={false}
      >
        <ToggleField label="Require HTF Bias Alignment" description="Only trade in the direction of higher timeframe structure" checked={config.strategy?.requireHTFBias ?? true} onChange={v => updateField('strategy', 'requireHTFBias', v)} />
        {(config.strategy?.requireHTFBias ?? true) && (
          <ToggleField label="HTF Bias Hard Veto" description="Block trade entirely (not just penalize) when opposing HTF" checked={config.strategy?.htfBiasHardVeto ?? false} onChange={v => updateField('strategy', 'htfBiasHardVeto', v)} />
        )}
        <div className="border-t border-border pt-3 space-y-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Premium / Discount</p>
          <div className="grid grid-cols-2 gap-4">
            <ToggleField label="Only Buy in Discount" checked={config.strategy?.onlyBuyInDiscount ?? true} onChange={v => updateField('strategy', 'onlyBuyInDiscount', v)} />
            <ToggleField label="Only Sell in Premium" checked={config.strategy?.onlySellInPremium ?? true} onChange={v => updateField('strategy', 'onlySellInPremium', v)} />
          </div>
        </div>
        <div className="border-t border-border pt-3 space-y-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Regime Scoring</p>
          <ToggleField label="Enable Regime Scoring" description="Adjust score based on market regime alignment" checked={config.strategy?.regimeScoringEnabled ?? true} onChange={v => updateField('strategy', 'regimeScoringEnabled', v)} />
          {(config.strategy?.regimeScoringEnabled ?? true) && (
            <FieldGroup label="Regime Strength" description="Scales bonus/penalty. 1.0 = default">
              <div className="flex items-center gap-4">
                <Slider value={[config.strategy?.regimeScoringStrength ?? 1.0]} onValueChange={v => updateField('strategy', 'regimeScoringStrength', v[0])} min={0.25} max={2.0} step={0.25} className="flex-1" />
                <span className="text-sm font-mono font-bold w-12 text-right">{(config.strategy?.regimeScoringStrength ?? 1.0).toFixed(2)}×</span>
              </div>
            </FieldGroup>
          )}
        </div>
        <div className="border-t border-border pt-3 space-y-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Structural Conviction</p>
          <ToggleField label="Structural Conviction Gate" description="Block trades lacking structural evidence" checked={config.strategy?.structuralConvictionGate ?? false} onChange={v => updateField('strategy', 'structuralConvictionGate', v)} />
        </div>
      </CollapsibleSection>

      {/* ── Analysis Modules ── */}
      <CollapsibleSection
        id="analysisModules"
        title="Analysis Modules"
        subtitle="Which SMC/ICT analysis engines are active"
        icon={<Sparkles className="h-4 w-4" />}
        badge={<StatusBadge count={activeModuleCount} total={14} label="active" />}
        defaultOpen={false}
      >
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <ToggleField label="Order Blocks" checked={strat.enableOB !== false} onChange={v => updateField('strategy', 'enableOB', v)} />
          <ToggleField label="Fair Value Gaps" checked={strat.enableFVG !== false} onChange={v => updateField('strategy', 'enableFVG', v)} />
          <ToggleField label="Liquidity Pools" checked={strat.enableLiquidity !== false} onChange={v => updateField('strategy', 'enableLiquidity', v)} />
          <ToggleField label="Market Structure" checked={strat.enableStructure !== false} onChange={v => updateField('strategy', 'enableStructure', v)} />
          <ToggleField label="Displacement" checked={strat.enableDisplacement !== false} onChange={v => updateField('strategy', 'enableDisplacement', v)} />
          <ToggleField label="Breaker Blocks" checked={strat.enableBreaker ?? false} onChange={v => updateField('strategy', 'enableBreaker', v)} />
          <ToggleField label="Unicorn Model" checked={strat.enableUnicorn ?? false} onChange={v => updateField('strategy', 'enableUnicorn', v)} />
          <ToggleField label="Session Analysis" checked={strat.enableSession !== false} onChange={v => updateField('strategy', 'enableSession', v)} />
          <ToggleField label="SMT Divergence" checked={strat.enableSMT ?? false} onChange={v => updateField('strategy', 'enableSMT', v)} />
          <ToggleField label="Volume Profile" checked={strat.enableVolumeProfile ?? false} onChange={v => updateField('strategy', 'enableVolumeProfile', v)} />
          <ToggleField label="Trend Direction" checked={strat.enableTrendDirection !== false} onChange={v => updateField('strategy', 'enableTrendDirection', v)} />
          <ToggleField label="Daily Bias" checked={strat.enableDailyBias !== false} onChange={v => updateField('strategy', 'enableDailyBias', v)} />
          <ToggleField label="AMD Phase" checked={strat.enableAMD !== false} onChange={v => updateField('strategy', 'enableAMD', v)} />
          <ToggleField label="FOTSI" checked={strat.enableFOTSI ?? false} onChange={v => updateField('strategy', 'enableFOTSI', v)} />
        </div>
      </CollapsibleSection>

      {/* ── Game Plan ── */}
      <CollapsibleSection
        id="gamePlan"
        title="Game Plan"
        subtitle="Pre-session bias, DOL targets, IPDA ranges"
        icon={<Crosshair className="h-4 w-4" />}
        badge={config.gamePlanEnabled !== false ? <Badge variant="outline" className="text-[9px] text-success border-success/40">ON</Badge> : <Badge variant="outline" className="text-[9px] text-muted-foreground">OFF</Badge>}
        defaultOpen={false}
      >
        <ToggleField label="Enable Game Plan" description="Generate session bias, DOL targets, and IPDA ranges before each session" checked={config.gamePlanEnabled !== false} onChange={v => setConfig((prev: any) => ({ ...prev, gamePlanEnabled: v }))} />
        {config.gamePlanEnabled !== false && (
          <>
            <ToggleField label="Telegram Notifications" description="Send game plan summary to Telegram" checked={config.gamePlanNotify !== false} onChange={v => setConfig((prev: any) => ({ ...prev, gamePlanNotify: v }))} />
            <FieldGroup label="Refresh Interval (hours)" description="How often to regenerate within same session">
              <Input type="number" value={config.gamePlanRefreshHours ?? 4} onChange={e => setConfig((prev: any) => ({ ...prev, gamePlanRefreshHours: Math.max(1, Math.min(12, parseInt(e.target.value) || 4)) }))} min={1} max={12} step={1} className="h-9 text-sm" />
            </FieldGroup>
            <div className="grid grid-cols-2 gap-3">
              <ToggleField label="DOL TP Extension" description="Extend TP to Draw on Liquidity targets" checked={config.dolTPExtensionEnabled !== false} onChange={v => setConfig((prev: any) => ({ ...prev, dolTPExtensionEnabled: v }))} />
              <ToggleField label="IPDA Ranges" description="20/40/60-day institutional data ranges" checked={config.ipdaRangesEnabled !== false} onChange={v => setConfig((prev: any) => ({ ...prev, ipdaRangesEnabled: v }))} />
            </div>
          </>
        )}
      </CollapsibleSection>

      {/* ── Opening Range ── */}
      <CollapsibleSection
        id="openingRange"
        title="Opening Range"
        subtitle="Session opening range breakout analysis"
        icon={<BarChart3 className="h-4 w-4" />}
        badge={config.openingRange?.enabled ? <Badge variant="outline" className="text-[9px] text-success border-success/40">ON</Badge> : <Badge variant="outline" className="text-[9px] text-muted-foreground">OFF</Badge>}
        defaultOpen={false}
      >
        <ToggleField label="Enable Opening Range" description="Calculate opening range for bias and key levels" checked={config.openingRange?.enabled ?? false} onChange={v => updateField('openingRange', 'enabled', v)} />
        {config.openingRange?.enabled && (
          <>
            <FieldGroup label="Candle Count" description="Number of candles to form the opening range">
              <Input type="number" value={config.openingRange?.candleCount ?? 3} onChange={e => updateField('openingRange', 'candleCount', parseInt(e.target.value) || 3)} min={1} max={12} step={1} className="h-9 text-sm" />
            </FieldGroup>
            <div className="grid grid-cols-2 gap-3">
              <ToggleField label="OR Bias" description="Use OR for directional bias" checked={config.openingRange?.useBias ?? true} onChange={v => updateField('openingRange', 'useBias', v)} />
              <ToggleField label="Judas Swing" description="Detect fake breakouts of OR" checked={config.openingRange?.judasSwing ?? true} onChange={v => updateField('openingRange', 'judasSwing', v)} />
              <ToggleField label="Key Levels" description="Use OR high/low as key levels" checked={config.openingRange?.keyLevels ?? true} onChange={v => updateField('openingRange', 'keyLevels', v)} />
              <ToggleField label="Premium/Discount from OR" description="Use OR range for P/D zones" checked={config.openingRange?.usePremiumDiscount ?? false} onChange={v => updateField('openingRange', 'usePremiumDiscount', v)} />
            </div>
            <ToggleField label="Wait for OR Completion" description="Don't trade until OR is fully formed" checked={config.openingRange?.waitForCompletion ?? true} onChange={v => updateField('openingRange', 'waitForCompletion', v)} />
          </>
        )}
      </CollapsibleSection>

      {/* ── SMC Enhancements ── */}
      <CollapsibleSection
        id="smcEnhancements"
        title="SMC Enhancements"
        subtitle="Phase detection, zone lifecycle v2, breaker blocks, trendline liquidity, monthly containment"
        icon={<Layers className="h-4 w-4" />}
        badge={config.smcEnhancements?.enablePhaseDetection || config.smcEnhancements?.enableZoneLifecycleV2 || config.smcEnhancements?.enableBreakerBlocks || config.smcEnhancements?.enableTrendlineLiquidity || config.smcEnhancements?.enableMonthlyContainment
          ? <Badge variant="outline" className="text-[9px] text-success border-success/40">ACTIVE</Badge>
          : <Badge variant="outline" className="text-[9px] text-muted-foreground">OFF</Badge>
        }
        defaultOpen={false}
      >
        <ToggleField label="Phase Detection" description="Block zones formed during consolidation" checked={config.smcEnhancements?.enablePhaseDetection ?? false} onChange={v => setConfig((prev: any) => ({ ...prev, smcEnhancements: { ...prev.smcEnhancements, enablePhaseDetection: v } }))} />
        <ToggleField label="Zone Lifecycle v2" description="Close-based invalidation, multi-retest support" checked={config.smcEnhancements?.enableZoneLifecycleV2 ?? false} onChange={v => setConfig((prev: any) => ({ ...prev, smcEnhancements: { ...prev.smcEnhancements, enableZoneLifecycleV2: v } }))} />
        <ToggleField label="Breaker Blocks" description="Detect failed OBs that flip role for B&R entries" checked={config.smcEnhancements?.enableBreakerBlocks ?? false} onChange={v => setConfig((prev: any) => ({ ...prev, smcEnhancements: { ...prev.smcEnhancements, enableBreakerBlocks: v } }))} />
        <ToggleField label="Trendline Liquidity" description="Multi-touch trendlines, 4th-touch trap detection" checked={config.smcEnhancements?.enableTrendlineLiquidity ?? false} onChange={v => setConfig((prev: any) => ({ ...prev, smcEnhancements: { ...prev.smcEnhancements, enableTrendlineLiquidity: v } }))} />
        <ToggleField label="Monthly Containment" description="Monthly structural containment check" checked={config.smcEnhancements?.enableMonthlyContainment ?? false} onChange={v => setConfig((prev: any) => ({ ...prev, smcEnhancements: { ...prev.smcEnhancements, enableMonthlyContainment: v } }))} />
      </CollapsibleSection>
    </div>
  );
}

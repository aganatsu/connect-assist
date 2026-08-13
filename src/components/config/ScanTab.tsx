import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Globe, Clock, TrendingUp, BarChart3, Crosshair, Sparkles, Layers, BookOpen } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { INSTRUMENTS, INSTRUMENT_TYPES, INSTRUMENT_TYPE_LABELS } from "@/lib/marketData";
import { CollapsibleSection, SectionHeader, FieldGroup, ToggleField, StatusBadge, FeatureStateBadge, ConfigTabProps } from "./ConfigShared";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

// ─── Instruments Data (derived from canonical marketData.ts) ─────────────────
const INSTRUMENT_GROUPS = INSTRUMENT_TYPES.map(type => ({
  label: INSTRUMENT_TYPE_LABELS[type] || type,
  key: type,
  pairs: INSTRUMENTS.filter(i => i.type === type).map(i => i.symbol),
}));

// ─── Precision Filter Modules ────────────────────────────────────────────────
const ICT2022_MODULES: {
  key: string;
  label: string;
  description: string;
  enabledField: string;
  gateField: string;
  hasGate: boolean;
}[] = [
  {
    key: "htf",
    label: "HTF Framework",
    description: "Weekly Bias + Daily Impulse + Containment (is your LTF zone inside the Daily OB?). The top-level directional engine from the 2022 Mentorship.",
    enabledField: "ictHTFEnabled",
    gateField: "ictHTFGateMode",
    hasGate: true,
  },
  {
    key: "mss",
    label: "Displacement-Validated MSS",
    description: "A Market Structure Shift is only valid if the break candle shows displacement (body/range ≥ 0.6, range ≥ 1.2× ATR). Sluggish breaks are rejected.",
    enabledField: "ictDisplacementMSSEnabled",
    gateField: "ictDisplacementMSSGateMode",
    hasGate: true,
  },
  {
    key: "judas",
    label: "Judas Swing / Liquidity Sweep",
    description: "Requires a liquidity sweep on the opposite side BEFORE the MSS (the false move that takes stops, then real move begins).",
    enabledField: "ictJudasSwingEnabled",
    gateField: "ictJudasSwingGateMode",
    hasGate: true,
  },
  {
    key: "fvg",
    label: "FVG Invalidation Rules",
    description: "Body-close invalidation (wicks don't count), Consequent Encroachment at 50%, Rule of 2 (FVG exhausted after 2 touches without follow-through).",
    enabledField: "ictFVGInvalidationEnabled",
    gateField: "ictFVGInvalidationGateMode",
    hasGate: true,
  },
  {
    key: "kz",
    label: "Kill Zones & Silver Bullet",
    description: "London KZ, NY KZ, Silver Bullet 1/2/3 windows. Penalises lunch & Asian dead zones. Boosts setups inside prime windows.",
    enabledField: "ictKillZoneEnabled",
    gateField: "ictKillZoneGateMode",
    hasGate: true,
  },
  {
    key: "risk",
    label: "Risk Management",
    description: "Drawdown halving after losses, 1%/day & 2.5%/week loss caps, FVG Rule-of-2 exit, position sizing. Enable as advisory — no built-in gate mode.",
    enabledField: "ictRiskEnabled",
    gateField: "",
    hasGate: false,
  },
];

// ─── SMC Enhancement Modules ──────────────────────────────────────────────────
const SMC_ENHANCEMENT_MODULES: {
  key: string;
  label: string;
  description: string;
  configField: string;
  hasGate: boolean;
  gateField?: string;
  hasParams?: boolean;
}[] = [
  {
    key: "phase",
    label: "Phase Detection",
    description: "Classifies market as consolidation/expansion/trend using price action. Blocks trades from zones formed during consolidation.",
    configField: "enablePhaseDetection",
    hasGate: false,
    hasParams: true,
  },
  {
    key: "zoneLifecycle",
    label: "Zone Lifecycle v2",
    description: "Close-based zone invalidation replaces the 50% penetration model. Zones survive wicks, support 2-3 retests with decreasing confidence.",
    configField: "enableZoneLifecycleV2",
    hasGate: false,
    hasParams: true,
  },
  {
    key: "breaker",
    label: "Breaker Blocks",
    description: "Detects failed OBs that flip role after sweep → displacement → retest. Creates its own trade signal at half size.",
    configField: "enableBreakerBlocks",
    hasGate: false,
    hasParams: true,
  },
  {
    key: "fib3pt",
    label: "Fib 3-Point TP",
    description: "Measures fib extensions from your ENTRY point (Point C). Adds -27.2%, -61.8%, -100% extension levels for take profit.",
    configField: "enableFibExtension3Point",
    hasGate: false,
    hasParams: true,
  },
  {
    key: "trendline",
    label: "Trendline Liquidity",
    description: "Detects multi-touch trendlines. Warns when zones are at trap-prone 4th touches (liquidity grab).",
    configField: "enableTrendlineLiquidity",
    hasGate: false,
    hasParams: true,
  },
  {
    key: "monthly",
    label: "Monthly Containment",
    description: "Adds monthly timeframe structural analysis. Checks if your LTF zone is contained within a monthly OB or key level.",
    configField: "enableMonthlyContainment",
    hasGate: false,
    hasParams: false,
  },
];

// ─── Component ────────────────────────────────────────────────────────────────
export function ScanTab({ config, setConfig, updateField }: ConfigTabProps) {
  const { user } = useAuth();
  const { data: lifecycleCertificate } = useQuery({
    queryKey: ["impulse-lifecycle-enforcement-certificate", user?.id],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("impulse_lifecycle_enforcement_certificates").select("*")
        .eq("user_id", user!.id).eq("bot_id", "smc").eq("is_current", true).maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!user?.id, retry: false,
  });
  const lifecycleEnforceUnlocked = lifecycleCertificate?.status === "eligible" &&
    lifecycleCertificate?.reviewed === true && lifecycleCertificate?.minimum_sample_ready === true;
  // Count active instruments
  const ALL_INSTRUMENTS = INSTRUMENTS.map(i => i.symbol);
  const totalPairs = ALL_INSTRUMENTS.length;
  const enabledPairs: string[] = config.instruments?.enabled || ALL_INSTRUMENTS;
  const activePairCount = enabledPairs.length;

  // Count active sessions — uses filter array format: ["asian", "london", "newyork", "offhours"]
  const sessionFilter: string[] = Array.isArray(config.sessions?.filter) ? config.sessions.filter : ["london", "newyork"];
  const activeSessionCount = sessionFilter.length;

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

  // ICT2022 helpers
  const getICTEnabled = (field: string, fallback = true) =>
    strat[field] !== undefined ? !!strat[field] : fallback;
  const getICTGate = (field: string): "off" | "soft" | "hard" =>
    (strat[field] as "off" | "soft" | "hard") || "off";
  const updateStrategy = (key: string, value: any) => {
    setConfig((prev: any) => ({
      ...prev,
      strategy: { ...(prev.strategy || {}), [key]: value },
    }));
  };
  const ictEnabledCount = ICT2022_MODULES.filter(m => getICTEnabled(m.enabledField)).length;
  const ictActiveGates = ICT2022_MODULES.filter(m => m.hasGate && getICTGate(m.gateField) !== "off").length;

  // SMC Enhancement helpers
  const enhancements = config.smcEnhancements || {};
  const updateEnhancement = (key: string, value: any) => {
    setConfig((prev: any) => ({
      ...prev,
      smcEnhancements: { ...(prev.smcEnhancements || {}), [key]: value },
    }));
  };
  const getSMCEnabled = (field: string) =>
    field === "enableFibExtension3Point"
      ? !!(enhancements.enableFibExtension3Point ?? enhancements.enableFib3PointTP)
      : !!enhancements[field];
  const getSMCGate = (field: string): "off" | "soft" | "hard" =>
    (enhancements[field] as "off" | "soft" | "hard") || "off";
  const smcEnabledCount = SMC_ENHANCEMENT_MODULES.filter(m => getSMCEnabled(m.configField)).length;
  const smcActiveGates = SMC_ENHANCEMENT_MODULES.filter(m => m.hasGate && getSMCGate(m.gateField!) !== "off").length;

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
                  const allEnabled = group.pairs.every(p => enabledPairs.includes(p));
                  setConfig((prev: any) => {
                    const current = prev.instruments?.enabled || ALL_INSTRUMENTS;
                    if (allEnabled) {
                      return { ...prev, instruments: { ...prev.instruments, enabled: current.filter((p: string) => !group.pairs.includes(p)) } };
                    } else {
                      const merged = [...new Set([...current, ...group.pairs])];
                      return { ...prev, instruments: { ...prev.instruments, enabled: merged } };
                    }
                  });
                }}
              >
                {group.pairs.every(p => enabledPairs.includes(p)) ? "Deselect all" : "Select all"}
              </button>
            </div>
            <div className="flex flex-wrap gap-1">
              {group.pairs.map(pair => {
                const isEnabled = enabledPairs.includes(pair);
                return (
                  <button
                    key={pair}
                    onClick={() => {
                      setConfig((prev: any) => {
                        const current = prev.instruments?.enabled || ALL_INSTRUMENTS;
                        const next = current.includes(pair) ? current.filter((p: string) => p !== pair) : [...current, pair];
                        return { ...prev, instruments: { ...prev.instruments, enabled: next } };
                      });
                    }}
                    className={`px-2 py-1 text-[10px] font-mono rounded border transition-colors ${
                      isEnabled
                        ? "border-primary bg-primary/20 text-primary font-bold ring-1 ring-primary/40"
                        : "border-border/40 bg-transparent text-muted-foreground/50 hover:text-muted-foreground hover:border-border"
                    }`}
                  >
                    {pair}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <div className="border-t border-border pt-4 space-y-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Impulse Zone Rotation</p>
          <ToggleField
            label="Rotate Pair Universe"
            description="Use all slots to discover new Impulse Zones. Existing Watchlist and Zone Setup records move to a separate lifecycle monitor."
            checked={config.instruments?.rotatingImpulseScanEnabled ?? true}
            onChange={v => updateField("instruments", "rotatingImpulseScanEnabled", v)}
          />
          {(config.instruments?.rotatingImpulseScanEnabled ?? true) && (
            <FieldGroup label="Active Scan Slots" description="Pairs receiving full Gameplan, Impulse Zone, liquidity, and confirmation analysis each cycle.">
              <Input
                type="number"
                value={config.instruments?.rotatingImpulseSlotCount ?? 8}
                onChange={e => updateField("instruments", "rotatingImpulseSlotCount", Math.max(1, Math.min(12, parseInt(e.target.value, 10) || 8)))}
                min={1}
                max={12}
                step={1}
                className="h-9 text-sm"
              />
            </FieldGroup>
          )}
        </div>
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
          <ToggleField label="Asian Session" checked={sessionFilter.includes('asian')} onChange={v => {
            setConfig((prev: any) => {
              const current: string[] = Array.isArray(prev.sessions?.filter) ? [...prev.sessions.filter] : ['london', 'newyork'];
              const updated = v ? [...new Set([...current, 'asian'])] : current.filter(s => s !== 'asian');
              return { ...prev, sessions: { ...prev.sessions, filter: updated } };
            });
          }} />
          <ToggleField label="London Session" checked={sessionFilter.includes('london')} onChange={v => {
            setConfig((prev: any) => {
              const current: string[] = Array.isArray(prev.sessions?.filter) ? [...prev.sessions.filter] : ['london', 'newyork'];
              const updated = v ? [...new Set([...current, 'london'])] : current.filter(s => s !== 'london');
              return { ...prev, sessions: { ...prev.sessions, filter: updated } };
            });
          }} />
          <ToggleField label="New York Session" checked={sessionFilter.includes('newyork')} onChange={v => {
            setConfig((prev: any) => {
              const current: string[] = Array.isArray(prev.sessions?.filter) ? [...prev.sessions.filter] : ['london', 'newyork'];
              const updated = v ? [...new Set([...current, 'newyork'])] : current.filter(s => s !== 'newyork');
              return { ...prev, sessions: { ...prev.sessions, filter: updated } };
            });
          }} />
          <ToggleField label="Off-Hours" description="Trade outside main sessions" checked={sessionFilter.includes('offhours')} onChange={v => {
            setConfig((prev: any) => {
              const current: string[] = Array.isArray(prev.sessions?.filter) ? [...prev.sessions.filter] : ['london', 'newyork'];
              const updated = v ? [...new Set([...current, 'offhours'])] : current.filter(s => s !== 'offhours');
              return { ...prev, sessions: { ...prev.sessions, filter: updated } };
            });
          }} />
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
        <FieldGroup label="HTF Bias Timeframe" description="Controlled by the selected Trading Style runtime profile" status="unavailable">
          <Select value={config.strategy?.htfBiasTimeframe ?? "4h"} onValueChange={v => updateField('strategy', 'htfBiasTimeframe', v)} disabled>
            <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1week">Weekly</SelectItem>
              <SelectItem value="1day">Daily</SelectItem>
              <SelectItem value="4h">4H (Default)</SelectItem>
              <SelectItem value="1h">1H</SelectItem>
            </SelectContent>
          </Select>
        </FieldGroup>
        <ToggleField label="HTF Bias Required" description="Only trade in direction of HTF bias" checked={config.strategy?.htfBiasRequired ?? true} onChange={v => updateField('strategy', 'htfBiasRequired', v)} />
        {(config.strategy?.htfBiasRequired ?? true) && (
          <ToggleField label="HTF Bias Hard Veto" description="Block trade entirely (not just penalize) when opposing HTF" checked={config.strategy?.htfBiasHardVeto ?? false} onChange={v => updateField('strategy', 'htfBiasHardVeto', v)} />
        )}
        <div className="border-t border-border pt-3 space-y-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Premium / Discount</p>
          <FieldGroup label="Premium/Discount Entry Rule" description="Uses the frozen HTF impulse high and low to determine premium or discount">
            <Select value={config.strategy?.dealingRangeMode ?? "avoid_wrong_side"} onValueChange={v => updateField("strategy", "dealingRangeMode", v)}>
              <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Off</SelectItem>
                <SelectItem value="avoid_wrong_side">Block Wrong-Side Entries</SelectItem>
                <SelectItem value="strict_value">Require Discount Buys / Premium Sells</SelectItem>
              </SelectContent>
            </Select>
          </FieldGroup>
          <FieldGroup label="Impulse & Entry Zone Lifecycle" description="Observe how a failed entry zone advances to a deeper zone inside the same frozen impulse">
            <Select value={config.strategy?.impulseEntryLifecycleMode ?? "observe"} onValueChange={v => updateField("strategy", "impulseEntryLifecycleMode", v)}>
              <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Off</SelectItem>
                <SelectItem value="observe">Observe</SelectItem>
                <SelectItem value="enforce" disabled={!lifecycleEnforceUnlocked}>
                  {lifecycleEnforceUnlocked ? "Enforce" : "Enforce (locked until evidence review)"}
                </SelectItem>
              </SelectContent>
            </Select>
          </FieldGroup>
          <FieldGroup label="Trade Decision Mode" description="Observe or enforce the ICT setup workflow on the selected account">
            <Select
              value={config.strategy?.singleOwnershipMode === "enforce" || config.strategy?.singleOwnershipMode === "enforce_live" || config.strategy?.streamlinedDecisionMode === "enforce" ? "enforce" : "observe"}
              onValueChange={v => setConfig((previous: any) => ({
                ...previous,
                strategy: {
                  ...(previous.strategy || {}),
                  singleOwnershipMode: v,
                  streamlinedDecisionMode: "observe",
                },
              }))}
            >
              <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="observe">Observe</SelectItem>
                <SelectItem value="enforce">Enforce</SelectItem>
              </SelectContent>
            </Select>
          </FieldGroup>
          <FieldGroup label="ICT Scanner Workflow" description="Observe the unified scanner stages, or enforce them after Trade Decision Mode is enforcing">
            <Select
              value={config.strategy?.canonicalScannerMode ?? "observe"}
              onValueChange={v => updateField("strategy", "canonicalScannerMode", v)}
            >
              <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="observe">Observe</SelectItem>
                <SelectItem value="enforce" disabled={config.strategy?.singleOwnershipMode !== "enforce" && config.strategy?.singleOwnershipMode !== "enforce_live"}>Enforce</SelectItem>
              </SelectContent>
            </Select>
          </FieldGroup>
          <FieldGroup label="Market Structure Authority" description="Use frozen swings, sweeps, BOS, CHoCH and MSS as one decision sequence">
            <Select value={config.strategy?.canonicalStructureMode ?? "observe"} onValueChange={v => updateField("strategy", "canonicalStructureMode", v)}>
              <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="observe">Observe</SelectItem>
                <SelectItem value="enforce" disabled={config.strategy?.singleOwnershipMode !== "enforce" && config.strategy?.singleOwnershipMode !== "enforce_live"}>Enforce</SelectItem>
              </SelectContent>
            </Select>
          </FieldGroup>
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
          <ToggleField label="Structural Conviction Gate" description="Block trades lacking structural evidence" checked={config.strategy?.structuralConvictionEnabled ?? config.strategy?.structuralConvictionGate ?? true} onChange={v => updateField('strategy', 'structuralConvictionEnabled', v)} status={(config.strategy?.structuralConvictionEnabled ?? config.strategy?.structuralConvictionGate ?? true) ? "active" : "disabled"} />
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
          <ToggleField label="BSL/SSL Liquidity Levels" checked={strat.enableLiquidity !== false} onChange={v => updateField('strategy', 'enableLiquidity', v)} />
          <ToggleField label="Market Structure" checked={strat.enableStructure !== false} onChange={v => updateField('strategy', 'enableStructure', v)} />
          <ToggleField label="Displacement" checked={strat.enableDisplacement !== false} onChange={v => updateField('strategy', 'enableDisplacement', v)} />
          <ToggleField label="Breaker Blocks" checked={strat.enableBreaker ?? false} onChange={v => updateField('strategy', 'enableBreaker', v)} />
          <ToggleField label="Unicorn Model" checked={strat.enableUnicorn ?? false} onChange={v => updateField('strategy', 'enableUnicorn', v)} />
          <ToggleField label="Session Analysis" description="Always active in the scoring engine; it is not independently configurable yet" checked={true} onChange={() => {}} disabled status="unavailable" />
          <ToggleField label="SMT Divergence" checked={strat.enableSMT ?? false} onChange={v => updateField('strategy', 'enableSMT', v)} />
          <ToggleField label="Volume Profile" checked={strat.enableVolumeProfile ?? false} onChange={v => updateField('strategy', 'enableVolumeProfile', v)} />
          <ToggleField label="Trend Direction" description="Reserved for a later canonical direction-control pass" checked={strat.enableTrendDirection !== false} onChange={() => {}} disabled status="unavailable" />
          <ToggleField label="Daily Bias" checked={strat.enableDailyBias !== false} onChange={v => updateField('strategy', 'enableDailyBias', v)} />
          <ToggleField label="AMD Phase" checked={strat.enableAMD !== false} onChange={v => updateField('strategy', 'enableAMD', v)} />
          <ToggleField label="FOTSI" checked={strat.enableFOTSI ?? false} onChange={v => updateField('strategy', 'enableFOTSI', v)} />
        </div>
      </CollapsibleSection>

      {/* ── Game Plan ── */}
      <CollapsibleSection
        id="gamePlan"
        title="Game Plan"
        subtitle="Pre-session planning: key levels, bias, ICT concepts"
        icon={<Crosshair className="h-4 w-4" />}
        badge={config.gamePlan?.enabled ? <Badge variant="outline" className="text-[9px] text-success border-success/40">ON</Badge> : <Badge variant="outline" className="text-[9px] text-muted-foreground">OFF</Badge>}
        searchLabels={["Bias Enforcement", "Game Plan Enforcement", "Minimum Plan Confidence"]}
        defaultOpen={false}
      >
        <ToggleField
          label="Enable Game Plan"
          description="Generate pre-session game plan with key levels and bias"
          checked={config.gamePlan?.enabled ?? false}
          onChange={v => updateField('gamePlan', 'enabled', v)}
          status={config.gamePlan?.enabled ? "active" : "inactive"}
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <FieldGroup
            label="HTF Bias"
            description="The higher-timeframe directional bias used before POI and entry confirmation."
            status="active"
          >
            <p className="text-[10px] text-muted-foreground">
              Can permit or block a direction before the zone and entry paths continue.
            </p>
          </FieldGroup>
          <FieldGroup
            label="Gameplan Hierarchy Audit"
            description="Compares the proposed hierarchy decision with the current system for later evaluation."
            status="shadow"
          >
            <p className="text-[10px] text-muted-foreground">
              Recorded as evidence only; it does not change scoring, risk, sizing, or execution.
            </p>
          </FieldGroup>
        </div>
        {config.gamePlan?.enabled && (
          <>
            <div className="border border-border/60 rounded-md p-3 space-y-3">
              <div>
                <p className="text-xs font-semibold">Bias Enforcement</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Controls what happens when a setup opposes the active Game Plan bias.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground shrink-0">Game Plan Enforcement</Label>
                <Select
                  value={config.gamePlan?.enforcementMode ?? "hard"}
                  onValueChange={(v: "off" | "soft" | "hard") => updateField("gamePlan", "enforcementMode", v)}
                >
                  <SelectTrigger className="h-8 text-xs w-44"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off" className="text-xs">Off — log only</SelectItem>
                    <SelectItem value="soft" className="text-xs">Soft — score impact</SelectItem>
                    <SelectItem value="hard" className="text-xs">Hard — block trade</SelectItem>
                  </SelectContent>
                </Select>
                <Badge
                  variant="outline"
                  className={`text-[9px] font-mono ${
                    (config.gamePlan?.enforcementMode ?? "hard") === "hard"
                      ? "text-red-500 border-red-500/40"
                      : (config.gamePlan?.enforcementMode ?? "hard") === "soft"
                        ? "text-amber-500 border-amber-500/40"
                        : "text-muted-foreground"
                  }`}
                >
                  {(config.gamePlan?.enforcementMode ?? "hard") === "hard"
                    ? "BLOCKING"
                    : (config.gamePlan?.enforcementMode ?? "hard") === "soft"
                      ? "SCORING"
                      : "LOG ONLY"}
                </Badge>
              </div>
              {(config.gamePlan?.enforcementMode ?? "hard") === "hard" && (
                <div className="pt-2 border-t border-border/40 space-y-2">
                  <div className="flex items-center gap-4">
                    <Label className="text-[10px] text-muted-foreground shrink-0 w-40">Minimum Plan Confidence</Label>
                    <Slider
                      value={[config.gamePlan?.hardBlockThreshold ?? 75]}
                      onValueChange={v => updateField("gamePlan", "hardBlockThreshold", v[0])}
                      min={50}
                      max={100}
                      step={1}
                      className="flex-1"
                    />
                    <span className="text-[10px] font-mono font-bold w-10 text-right">
                      {config.gamePlan?.hardBlockThreshold ?? 75}%
                    </span>
                  </div>
                  <p className="text-[9px] text-muted-foreground">
                    Hard mode requires the Game Plan and HTF Bias to agree, and the plan must meet this confidence before an automatic trade is authorized. Recommended: 75%.
                  </p>
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <ToggleField label="Auto Key Levels" description="Always included by the current Gameplan generator; individual control arrives in Phase 3" checked={true} onChange={() => {}} disabled status="unavailable" />
              <ToggleField label="Session Bias" description="Always calculated by the current Gameplan generator; individual control arrives in Phase 3" checked={true} onChange={() => {}} disabled status="unavailable" />
              <ToggleField label="PD Levels" description="Always included by the current Gameplan generator; individual control arrives in Phase 3" checked={true} onChange={() => {}} disabled status="unavailable" />
              <ToggleField label="IPDA Ranges" description="20/40/60-day institutional data ranges" checked={config.ipdaRangesEnabled !== false} onChange={v => setConfig((prev: any) => ({ ...prev, ipdaRangesEnabled: v }))} status={config.ipdaRangesEnabled !== false ? "active" : "disabled"} />
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
              <ToggleField label="Judas Swing" description="Detect fake breakouts of OR" checked={config.openingRange?.useJudasSwing ?? config.openingRange?.judasSwing ?? true} onChange={v => updateField('openingRange', 'useJudasSwing', v)} />
              <ToggleField label="Key Levels" description="Use OR high/low as key levels" checked={config.openingRange?.useKeyLevels ?? config.openingRange?.keyLevels ?? true} onChange={v => updateField('openingRange', 'useKeyLevels', v)} />
              <ToggleField label="Premium/Discount from OR" description="Use OR range for P/D zones" checked={config.openingRange?.usePremiumDiscount ?? false} onChange={v => updateField('openingRange', 'usePremiumDiscount', v)} />
            </div>
            <ToggleField label="Wait for OR Completion" description="Don't trade until OR is fully formed" checked={config.openingRange?.waitForCompletion ?? true} onChange={v => updateField('openingRange', 'waitForCompletion', v)} />
          </>
        )}
      </CollapsibleSection>

      {/* ── Precision Filters ── */}
      <CollapsibleSection
        id="ict2022"
        title="Precision Filters"
        subtitle="Multi-timeframe validation gates"
        icon={<BookOpen className="h-4 w-4" />}
        badge={
          <div className="flex items-center gap-1">
            <Badge variant="outline" className="text-[9px] font-mono">{ictEnabledCount}/{ICT2022_MODULES.length}</Badge>
            {ictActiveGates > 0 && <Badge variant="outline" className="text-[9px] font-mono">{ictActiveGates} gate{ictActiveGates === 1 ? "" : "s"}</Badge>}
          </div>
        }
        searchLabels={[
          ...ICT2022_MODULES.map(module => module.label),
          "Gate Mode",
          "Min Bias Strength",
          "Min Displacement Ratio",
          "Min Sweep (pips)",
          "Min Body Ratio",
          "KZ Buffer (min)",
        ]}
        defaultOpen={false}
      >
        {/* Info banner */}
        <div className="rounded border border-emerald-500/40 bg-emerald-500/5 p-3 space-y-1.5">
          <p className="text-[10px] text-emerald-500 font-bold uppercase tracking-wider">How gate modes work</p>
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            <span className="font-mono font-bold text-foreground">Off</span> — module logs its verdict but has zero impact on trades.{" "}
            <span className="font-mono font-bold text-foreground">Soft</span> — module adds a score bonus when satisfied / penalty when violated.{" "}
            <span className="font-mono font-bold text-foreground">Hard</span> — module blocks the trade entirely when its rule is violated.
          </p>
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Recommended rollout: leave on <span className="font-mono">Off</span> for a few sessions, watch the logs, then move one module at a time to <span className="font-mono">Soft</span>.
          </p>
        </div>
        {/* Module cards */}
        <div className="space-y-3">
          {ICT2022_MODULES.map(m => {
            const enabled = getICTEnabled(m.enabledField);
            const gate = m.hasGate ? getICTGate(m.gateField) : null;
            return (
              <div
                key={m.key}
                className={`border p-3 space-y-3 transition-colors ${
                  enabled ? "border-border" : "border-border/40 opacity-70"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold">{m.label}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">{m.description}</p>
                  </div>
                  <Switch
                    checked={enabled}
                    onCheckedChange={v => updateStrategy(m.enabledField, v)}
                    className="shrink-0 mt-0.5"
                  />
                </div>
                {/* Gate mode selector */}
                {m.hasGate && enabled && (
                  <div className="flex items-center gap-3 pt-1 border-t border-border/40">
                    <Label className="text-[10px] uppercase tracking-wider text-muted-foreground shrink-0">Gate Mode</Label>
                    <Select
                      value={gate || "off"}
                      onValueChange={(v: string) => updateStrategy(m.gateField, v)}
                    >
                      <SelectTrigger className="h-8 text-xs w-32"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="off" className="text-xs">Off — log only</SelectItem>
                        <SelectItem value="soft" className="text-xs">Soft — score impact</SelectItem>
                        <SelectItem value="hard" className="text-xs">Hard — block trade</SelectItem>
                      </SelectContent>
                    </Select>
                    {gate && gate !== "off" && (
                      <Badge variant="outline" className={`text-[9px] font-mono ${gate === "hard" ? "text-red-500 border-red-500/40" : "text-amber-500 border-amber-500/40"}`}>
                        {gate === "hard" ? "BLOCKING" : "SCORING"}
                      </Badge>
                    )}
                  </div>
                )}
                {/* Per-module fine-tuning */}
                {enabled && m.key === "htf" && (
                  <div className="pt-2 border-t border-border/30 space-y-2">
                    <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Fine-Tuning</p>
                    <div className="flex items-center gap-4">
                      <Label className="text-[10px] text-muted-foreground shrink-0 w-32">Min Bias Strength <FeatureStateBadge state="unavailable" reason="The current HTF authority uses the resolved Trading Style policy; this saved threshold is not read by the runtime." /></Label>
                      <Slider value={[strat.ictHTFMinBias ?? 0.6]} onValueChange={() => {}} min={0.3} max={1.0} step={0.05} className="flex-1" disabled />
                      <span className="text-[10px] font-mono font-bold w-10 text-right">{(strat.ictHTFMinBias ?? 0.6).toFixed(2)}</span>
                    </div>
                    <p className="text-[9px] text-muted-foreground">Minimum weekly/daily bias confidence (0-1) required to confirm HTF direction. Lower = more permissive.</p>
                  </div>
                )}
                {enabled && m.key === "mss" && (
                  <div className="pt-2 border-t border-border/30 space-y-2">
                    <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Fine-Tuning</p>
                    <div className="flex items-center gap-4">
                      <Label className="text-[10px] text-muted-foreground shrink-0 w-32">Min Displacement Ratio</Label>
                      <Slider value={[strat.ictDisplacementMSSMinBodyRatio ?? strat.ictDisplacementMinRatio ?? 0.6]} onValueChange={v => updateStrategy('ictDisplacementMSSMinBodyRatio', v[0])} min={0.3} max={0.9} step={0.05} className="flex-1" />
                      <span className="text-[10px] font-mono font-bold w-10 text-right">{(strat.ictDisplacementMSSMinBodyRatio ?? strat.ictDisplacementMinRatio ?? 0.6).toFixed(2)}</span>
                    </div>
                    <p className="text-[9px] text-muted-foreground">Body/range ratio threshold for displacement candle. Higher = stricter (only strong impulsive breaks count).</p>
                  </div>
                )}
                {enabled && m.key === "judas" && (
                  <div className="pt-2 border-t border-border/30 space-y-2">
                    <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Fine-Tuning</p>
                    <div className="flex items-center gap-4">
                      <Label className="text-[10px] text-muted-foreground shrink-0 w-32">Min Sweep (pips) <FeatureStateBadge state="unavailable" reason="The Judas detector currently uses its compiled qualification policy; this saved threshold is not read by the runtime." /></Label>
                      <Input type="number" value={strat.ictJudasMinSweepPips ?? 5} onChange={() => {}} step={1} min={1} max={30} className="h-7 text-xs w-20" disabled />
                    </div>
                    <p className="text-[9px] text-muted-foreground">Minimum pip distance the Judas sweep must travel past the liquidity level to count as a valid sweep.</p>
                  </div>
                )}
                {enabled && m.key === "fvg" && (
                  <div className="pt-2 border-t border-border/30 space-y-2">
                    <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Fine-Tuning</p>
                    <div className="flex items-center gap-4">
                      <Label className="text-[10px] text-muted-foreground shrink-0 w-32">Min Body Ratio <FeatureStateBadge state="unavailable" reason="The FVG authority currently owns candle qualification; this legacy fine-tuning value is not read by the runtime." /></Label>
                      <Slider value={[strat.ictFVGMinBodyRatio ?? 0.5]} onValueChange={() => {}} min={0.2} max={0.9} step={0.05} className="flex-1" disabled />
                      <span className="text-[10px] font-mono font-bold w-10 text-right">{(strat.ictFVGMinBodyRatio ?? 0.5).toFixed(2)}</span>
                    </div>
                    <p className="text-[9px] text-muted-foreground">FVG-creating candle must have body/range at least this ratio. Filters doji-created FVGs.</p>
                  </div>
                )}
                {enabled && m.key === "kz" && (
                  <div className="pt-2 border-t border-border/30 space-y-2">
                    <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Fine-Tuning</p>
                    <div className="flex items-center gap-4">
                      <Label className="text-[10px] text-muted-foreground shrink-0 w-32">KZ Buffer (min) <FeatureStateBadge state="unavailable" reason="Kill Zone boundaries currently come from the shared session authority; a per-config buffer is not implemented." /></Label>
                      <Input type="number" value={strat.ictKZBufferMinutes ?? 5} onChange={() => {}} step={1} min={0} max={30} className="h-7 text-xs w-20" disabled />
                    </div>
                    <p className="text-[9px] text-muted-foreground">Minutes before/after Kill Zone boundaries that still count as "inside" the zone. 0 = exact boundaries only.</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="rounded border border-border bg-muted/20 p-3">
          <p className="text-[10px] text-muted-foreground">
            <span className="font-bold text-foreground">Note:</span> The scanner reads these flags from{" "}
            <span className="font-mono">config.strategy</span> first, then falls back to its compiled defaults.
            Saving here persists overrides to your bot config — no redeploy required.
          </p>
        </div>
      </CollapsibleSection>

      {/* ── SMC Enhancements ── */}
      <CollapsibleSection
        id="smcEnhancements"
        title="SMC Enhancements"
        subtitle="Phase detection, zone lifecycle v2, breaker blocks, trendline liquidity, monthly containment"
        icon={<Layers className="h-4 w-4" />}
        badge={
          <div className="flex items-center gap-1">
            <Badge variant="outline" className="text-[9px] font-mono">{smcEnabledCount}/{SMC_ENHANCEMENT_MODULES.length}</Badge>
            {smcActiveGates > 0 && <Badge variant="outline" className="text-[9px] font-mono">{smcActiveGates} gate{smcActiveGates === 1 ? "" : "s"}</Badge>}
          </div>
        }
        searchLabels={[
          ...SMC_ENHANCEMENT_MODULES.map(module => module.label),
          "Gate Mode",
          "Consolidation Threshold",
          "Trend Threshold",
          "Max Retests",
          "Confidence Decay",
          "Min Displacement",
          "Size Multiplier",
          "Primary TP Level",
          "Min Touches",
          "Trap Touch #",
        ]}
        defaultOpen={false}
      >
        {/* Info banner */}
        <div className="rounded border border-primary/30 bg-primary/5 p-3 space-y-1.5">
          <p className="text-[10px] text-primary font-bold uppercase tracking-wider">How these modules work</p>
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Each module adds new <span className="font-mono font-bold text-foreground">confluence factors</span> and optional <span className="font-mono font-bold text-foreground">gates</span> to the scanner.
            When disabled, the module has zero impact — the bot runs identically to before.
          </p>
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            <span className="font-mono font-bold text-foreground">Recommended:</span> Enable one module at a time. Watch scan details for a few sessions. Then enable the next.
          </p>
        </div>
        {/* Module cards */}
        <div className="space-y-3">
          {SMC_ENHANCEMENT_MODULES.map(m => {
            const enabled = getSMCEnabled(m.configField);
            const gate = m.hasGate ? getSMCGate(m.gateField!) : null;
            return (
              <div
                key={m.key}
                className={`border p-3 space-y-3 transition-colors ${
                  enabled ? "border-primary/40 bg-primary/[0.02]" : "border-border/40 opacity-70"
                }`}
              >
                {/* Header row */}
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold">{m.label}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">{m.description}</p>
                  </div>
                  <Switch
                    checked={enabled}
                    onCheckedChange={v => updateEnhancement(m.configField, v)}
                    className="shrink-0 mt-0.5"
                  />
                </div>
                {/* Gate mode selector */}
                {m.hasGate && enabled && (
                  <div className="flex items-center gap-3 pt-1 border-t border-border/40">
                    <Label className="text-[10px] uppercase tracking-wider text-muted-foreground shrink-0">Gate Mode</Label>
                    <Select
                      value={gate || "off"}
                      onValueChange={(v: string) => updateEnhancement(m.gateField!, v)}
                    >
                      <SelectTrigger className="h-8 text-xs w-32"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="off" className="text-xs">Off — log only</SelectItem>
                        <SelectItem value="soft" className="text-xs">Soft — score impact</SelectItem>
                        <SelectItem value="hard" className="text-xs">Hard — block trade</SelectItem>
                      </SelectContent>
                    </Select>
                    {gate && gate !== "off" && (
                      <Badge variant="outline" className={`text-[9px] font-mono ${gate === "hard" ? "text-red-500 border-red-500/40" : "text-amber-500 border-amber-500/40"}`}>
                        {gate === "hard" ? "BLOCKING" : "SCORING"}
                      </Badge>
                    )}
                  </div>
                )}
                {/* Per-module fine-tuning */}
                {enabled && m.key === "phase" && (
                  <div className="pt-2 border-t border-border/30 space-y-2">
                    <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Fine-Tuning</p>
                    <div className="flex items-center gap-4">
                      <Label className="text-[10px] text-muted-foreground shrink-0 w-36">Consolidation Threshold <FeatureStateBadge state="unavailable" reason="This control is locked until its scale is reconciled with the engine signed regime score." /></Label>
                      <Slider value={[enhancements.consolidationThreshold ?? 4]} onValueChange={() => {}} min={2} max={8} step={1} className="flex-1" disabled />
                      <span className="text-[10px] font-mono font-bold w-8 text-right">{enhancements.consolidationThreshold ?? 4}</span>
                    </div>
                    <p className="text-[9px] text-muted-foreground">Held until its scale is reconciled with the engine's signed regime score.</p>
                    <div className="flex items-center gap-4">
                      <Label className="text-[10px] text-muted-foreground shrink-0 w-36">Trend Threshold</Label>
                      <Slider value={[enhancements.trendThreshold ?? 6]} onValueChange={v => updateEnhancement('trendThreshold', v[0])} min={4} max={12} step={1} className="flex-1" />
                      <span className="text-[10px] font-mono font-bold w-8 text-right">{enhancements.trendThreshold ?? 6}</span>
                    </div>
                    <p className="text-[9px] text-muted-foreground">Regime score above this = trending. Higher = stricter (only strong trends qualify). Default: 6.</p>
                  </div>
                )}
                {enabled && m.key === "zoneLifecycle" && (
                  <div className="pt-2 border-t border-border/30 space-y-2">
                    <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Fine-Tuning</p>
                    <div className="flex items-center gap-4">
                      <Label className="text-[10px] text-muted-foreground shrink-0 w-36">Max Retests</Label>
                      <Slider value={[enhancements.maxRetests ?? 3]} onValueChange={v => updateEnhancement('maxRetests', v[0])} min={1} max={5} step={1} className="flex-1" />
                      <span className="text-[10px] font-mono font-bold w-8 text-right">{enhancements.maxRetests ?? 3}</span>
                    </div>
                    <p className="text-[9px] text-muted-foreground">How many times a zone can be traded before it's considered exhausted. Default: 3.</p>
                    <div className="flex items-center gap-4">
                      <Label className="text-[10px] text-muted-foreground shrink-0 w-36">Confidence Decay</Label>
                      <Slider value={[enhancements.confidenceDecay ?? 0.3]} onValueChange={v => updateEnhancement('confidenceDecay', v[0])} min={0.1} max={0.5} step={0.05} className="flex-1" />
                      <span className="text-[10px] font-mono font-bold w-10 text-right">{(enhancements.confidenceDecay ?? 0.3).toFixed(2)}</span>
                    </div>
                    <p className="text-[9px] text-muted-foreground">How much confidence drops per retest. 0.3 = 1st touch 100%, 2nd 70%, 3rd 40%. Default: 0.30.</p>
                  </div>
                )}
                {enabled && m.key === "breaker" && (
                  <div className="pt-2 border-t border-border/30 space-y-2">
                    <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Fine-Tuning</p>
                    <div className="flex items-center gap-4">
                      <Label className="text-[10px] text-muted-foreground shrink-0 w-36">Min Displacement</Label>
                      <Slider value={[enhancements.breakerMinDisplacement ?? 1.5]} onValueChange={v => updateEnhancement('breakerMinDisplacement', v[0])} min={1.0} max={3.0} step={0.1} className="flex-1" />
                      <span className="text-[10px] font-mono font-bold w-10 text-right">{(enhancements.breakerMinDisplacement ?? 1.5).toFixed(1)}×</span>
                    </div>
                    <p className="text-[9px] text-muted-foreground">Minimum ATR multiple for the displacement candle that breaks the OB. Higher = stricter. Default: 1.5×.</p>
                    <div className="flex items-center gap-4">
                      <Label className="text-[10px] text-muted-foreground shrink-0 w-36">Size Multiplier</Label>
                      <Slider value={[enhancements.breakerSizeMultiplier ?? 0.5]} onValueChange={v => updateEnhancement('breakerSizeMultiplier', v[0])} min={0.25} max={1.0} step={0.05} className="flex-1" />
                      <span className="text-[10px] font-mono font-bold w-10 text-right">{(enhancements.breakerSizeMultiplier ?? 0.5).toFixed(2)}×</span>
                    </div>
                    <p className="text-[9px] text-muted-foreground">Position size multiplier for breaker entries vs normal entries. Default: 0.5× (half size).</p>
                  </div>
                )}
                {enabled && m.key === "fib3pt" && (
                  <div className="pt-2 border-t border-border/30 space-y-2">
                    <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Extension Levels</p>
                    <div className="flex items-center gap-4">
                      <Label className="text-[10px] text-muted-foreground shrink-0 w-36">Primary TP Level</Label>
                      <Select value={String(enhancements.primaryFibLevel ?? -0.272)} onValueChange={v => updateEnhancement('primaryFibLevel', parseFloat(v))}>
                        <SelectTrigger className="h-8 text-xs flex-1"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="-0.272" className="text-xs">-27.2% (conservative)</SelectItem>
                          <SelectItem value="-0.618" className="text-xs">-61.8% (standard)</SelectItem>
                          <SelectItem value="-1.0" className="text-xs">-100% (aggressive)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="text-[9px] text-muted-foreground">Which fib extension level to use as the primary TP target. Measured from your entry point. Default: -27.2%.</p>
                  </div>
                )}
                {enabled && m.key === "trendline" && (
                  <div className="pt-2 border-t border-border/30 space-y-2">
                    <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Fine-Tuning</p>
                    <div className="flex items-center gap-4">
                      <Label className="text-[10px] text-muted-foreground shrink-0 w-36">Min Touches</Label>
                      <Slider value={[enhancements.trendlineMinTouches ?? 3]} onValueChange={v => updateEnhancement('trendlineMinTouches', v[0])} min={2} max={5} step={1} className="flex-1" />
                      <span className="text-[10px] font-mono font-bold w-8 text-right">{enhancements.trendlineMinTouches ?? 3}</span>
                    </div>
                    <p className="text-[9px] text-muted-foreground">Minimum touch points to confirm a trendline exists. Default: 3.</p>
                    <div className="flex items-center gap-4">
                      <Label className="text-[10px] text-muted-foreground shrink-0 w-36">Trap Touch #</Label>
                      <Slider value={[enhancements.trendlineTrapTouch ?? 4]} onValueChange={v => updateEnhancement('trendlineTrapTouch', v[0])} min={3} max={6} step={1} className="flex-1" />
                      <span className="text-[10px] font-mono font-bold w-8 text-right">{enhancements.trendlineTrapTouch ?? 4}</span>
                    </div>
                    <p className="text-[9px] text-muted-foreground">Which touch number is considered a liquidity trap. Default: 4 (4th touch = likely fake breakout).</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {/* Quick enable/disable all */}
        <div className="flex items-center gap-3 pt-2 border-t border-border/40">
          <Button
            variant="outline"
            size="sm"
            className="text-[10px] h-7"
            onClick={() => {
              SMC_ENHANCEMENT_MODULES.forEach(m => updateEnhancement(m.configField, true));
            }}
          >
            Enable All
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-[10px] h-7"
            onClick={() => {
              SMC_ENHANCEMENT_MODULES.forEach(m => updateEnhancement(m.configField, false));
            }}
          >
            Disable All
          </Button>
          <span className="text-[9px] text-muted-foreground ml-auto">
            Changes are saved when you click Save at the bottom of this modal.
          </span>
        </div>
        {/* Info note */}
        <div className="rounded border border-border/50 bg-secondary/20 p-3 mt-3">
          <p className="text-[10px] text-muted-foreground">
            <span className="font-bold text-foreground">Note:</span> These settings are stored in{" "}
            <span className="font-mono">config.smcEnhancements</span>. The scanner reads them on every scan cycle — no redeploy required.
            Enhancement factors appear in the scan detail panel when enabled.
          </p>
        </div>
      </CollapsibleSection>
    </div>
  );
}

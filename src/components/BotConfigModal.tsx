import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { botConfigApi } from "@/lib/api";
import { INSTRUMENTS, INSTRUMENT_TYPES, INSTRUMENT_TYPE_LABELS } from "@/lib/marketData";
import { STYLE_PARAMS, STYLE_META, type TradingStyleMode } from "@/lib/botStyleClassifier";
import { toast } from "sonner";
import { X, Zap, Shield, TrendingUp, Clock, Globe, ShieldAlert, LogIn, LogOut, BarChart3, Gauge } from "lucide-react";

const PRESETS = {
  conservative: { confluenceThreshold: 7, riskPerTrade: 0.5, maxDailyDrawdown: 2, maxConcurrentTrades: 2, tradingStyle: "swing_trader" as const, description: "Low risk, swing trading" },
  moderate: { confluenceThreshold: 5, riskPerTrade: 1, maxDailyDrawdown: 3, maxConcurrentTrades: 4, tradingStyle: "day_trader" as const, description: "Balanced day trading" },
  aggressive: { confluenceThreshold: 3, riskPerTrade: 2, maxDailyDrawdown: 5, maxConcurrentTrades: 6, tradingStyle: "scalper" as const, description: "High frequency scalping" },
};

interface BotConfigModalProps {
  open: boolean;
  onClose: () => void;
}

export function BotConfigModal({ open, onClose }: BotConfigModalProps) {
  const queryClient = useQueryClient();
  const { data: rawConfig } = useQuery({ queryKey: ["bot-config"], queryFn: () => botConfigApi.get(), enabled: open });
  const [config, setConfig] = useState<any>(null);
  const [activeTab, setActiveTab] = useState("strategy");

  useEffect(() => {
    if (rawConfig && open) setConfig(JSON.parse(JSON.stringify(rawConfig)));
  }, [rawConfig, open]);

  const saveMut = useMutation({
    mutationFn: () => botConfigApi.update(config),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["bot-config"] }); toast.success("Config saved"); onClose(); },
    onError: (e: any) => toast.error(e.message),
  });

  const resetMut = useMutation({
    mutationFn: () => botConfigApi.reset(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["bot-config"] }); setConfig(null); toast.success("Config reset"); },
  });

  const updateField = (section: string, key: string, value: any) => {
    setConfig((prev: any) => ({ ...prev, [section]: { ...(prev?.[section] || {}), [key]: value } }));
  };

  if (!open) return null;

  const tabs = [
    { id: "tradingStyle", label: "Trading Style", icon: Gauge },
    { id: "strategy", label: "Strategy", icon: TrendingUp },
    { id: "risk", label: "Risk", icon: Shield },
    { id: "entry_exit", label: "Entry / Exit", icon: LogIn },
    { id: "instruments", label: "Instruments", icon: Globe },
    { id: "sessions", label: "Sessions", icon: Clock },
    { id: "protection", label: "Protection", icon: ShieldAlert },
    { id: "openingRange", label: "Opening Range", icon: BarChart3 },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-card border border-border w-full max-w-4xl max-h-[85vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-bold">Bot Configuration</h2>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => resetMut.mutate()}>Reset Defaults</Button>
            <Button size="sm" className="text-xs" onClick={() => saveMut.mutate()}>Save Config</Button>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground ml-2"><X className="h-4 w-4" /></button>
          </div>
        </div>

        {/* Presets Bar */}
        <div className="px-6 py-3 border-b border-border bg-secondary/30">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1"><Zap className="h-3 w-3 text-primary" /> Quick Presets</p>
          <div className="grid grid-cols-3 gap-3">
            {Object.entries(PRESETS).map(([key, preset]) => (
              <button key={key} onClick={() => {
                if (!config) return;
                setConfig({
                  ...config,
                  strategy: { ...(config.strategy || {}), confluenceThreshold: preset.confluenceThreshold },
                  risk: { ...(config.risk || {}), riskPerTrade: preset.riskPerTrade, maxDailyDrawdown: preset.maxDailyDrawdown, maxConcurrentTrades: preset.maxConcurrentTrades },
                  tradingStyle: { ...(config.tradingStyle || {}), mode: preset.tradingStyle },
                });
                toast.info(`Applied ${key} preset → ${STYLE_META[preset.tradingStyle].icon} ${STYLE_META[preset.tradingStyle].label}`);
              }} className="p-3 border border-border hover:border-primary/50 hover:bg-primary/5 transition-colors text-left">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-bold capitalize">{key}</p>
                  <span className="text-[10px] text-muted-foreground">{STYLE_META[preset.tradingStyle].icon} {STYLE_META[preset.tradingStyle].label}</span>
                </div>
                <p className="text-[10px] text-muted-foreground mt-0.5">{preset.description}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Body: Tab nav + content */}
        <div className="flex flex-1 min-h-0">
          {/* Vertical Tab Nav */}
          <div className="w-44 border-r border-border py-2 shrink-0">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-xs transition-colors ${activeTab === tab.id ? "bg-primary/10 text-primary border-l-2 border-primary font-medium" : "text-muted-foreground hover:text-foreground hover:bg-secondary/30 border-l-2 border-transparent"}`}
              >
                <tab.icon className="h-3.5 w-3.5 shrink-0" />
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-y-auto p-6">
            {config && (
              <>
                {activeTab === "tradingStyle" && (
                  <div className="space-y-5">
                    <SectionHeader title="Trading Style" description="Choose how the bot trades — this overrides entry timeframe, TP/SL ratios, and hold duration" />
                    <div className="grid grid-cols-2 gap-3">
                      {(["scalper", "day_trader", "swing_trader", "auto"] as TradingStyleMode[]).map(mode => {
                        const isActive = (config.tradingStyle?.mode || "day_trader") === mode;
                        const meta = mode !== "auto" ? STYLE_META[mode] : null;
                        const params = mode !== "auto" ? STYLE_PARAMS[mode] : null;
                        return (
                          <button
                            key={mode}
                            onClick={() => updateField("tradingStyle", "mode", mode)}
                            className={`p-4 border text-left transition-colors ${isActive ? "border-primary bg-primary/5" : "border-border hover:border-border/80"}`}
                          >
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-lg">{meta?.icon || "🤖"}</span>
                              <span className="text-xs font-bold">{meta?.label || "Auto-Detect"}</span>
                            </div>
                            <p className="text-[10px] text-muted-foreground">
                              {meta?.description || "Bot analyzes volatility and trend per instrument to pick the best style automatically."}
                            </p>
                            {params && (
                              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px] text-muted-foreground">
                                <span>Entry TF: <strong className="text-foreground">{params.entryTimeframe}</strong></span>
                                <span>HTF Bias: <strong className="text-foreground">{params.htfTimeframe}</strong></span>
                                <span>TP Ratio: <strong className="text-foreground">{params.tpRatio}:1</strong></span>
                                <span>SL Buffer: <strong className="text-foreground">{params.slBufferPips} pip</strong></span>
                                <span>Max Hold: <strong className="text-foreground">{params.maxHoldHours}h</strong></span>
                                <span>Min Score: <strong className="text-foreground">{params.minConfluence}</strong></span>
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-[10px] text-muted-foreground italic">
                      Style sets default parameters. You can still fine-tune individual settings in the other tabs — manual overrides take precedence.
                    </p>
                  </div>
                )}

                {activeTab === "strategy" && (
                  <div className="space-y-5">
                    <SectionHeader title="Strategy Settings" description="Configure how the bot identifies trade setups" />
                    <FieldGroup label="Confluence Threshold" description="Minimum score (1-10) required to consider a trade setup valid">
                      <div className="flex items-center gap-4">
                        <Slider value={[config.strategy?.confluenceThreshold ?? 5]} onValueChange={v => updateField('strategy', 'confluenceThreshold', v[0])} min={1} max={10} step={1} className="flex-1" />
                        <span className="text-sm font-mono font-bold text-primary w-8 text-right">{config.strategy?.confluenceThreshold ?? 5}</span>
                      </div>
                    </FieldGroup>
                    <div className="grid grid-cols-2 gap-4">
                      <ToggleField label="Order Blocks" description="Detect institutional order blocks" checked={config.strategy?.useOrderBlocks ?? true} onChange={v => updateField('strategy', 'useOrderBlocks', v)} />
                      <ToggleField label="Fair Value Gaps" description="Identify FVG imbalances" checked={config.strategy?.useFVG ?? true} onChange={v => updateField('strategy', 'useFVG', v)} />
                      <ToggleField label="Liquidity Sweeps" description="Track liquidity pool sweeps" checked={config.strategy?.useLiquiditySweep ?? true} onChange={v => updateField('strategy', 'useLiquiditySweep', v)} />
                      <ToggleField label="Structure Breaks" description="BOS / CHoCH detection" checked={config.strategy?.useStructureBreak ?? true} onChange={v => updateField('strategy', 'useStructureBreak', v)} />
                    </div>
                    <ToggleField label="Require HTF Bias Alignment" description="Only trade in the direction of higher timeframe bias" checked={config.strategy?.requireHTFBias ?? true} onChange={v => updateField('strategy', 'requireHTFBias', v)} />
                  </div>
                )}

                {activeTab === "risk" && (
                  <div className="space-y-5">
                    <SectionHeader title="Risk Management" description="Control position sizing and drawdown limits" />
                    <div className="grid grid-cols-2 gap-4">
                      <FieldGroup label="Risk per Trade (%)" description="Percentage of balance risked per trade">
                        <Input type="number" value={config.risk?.riskPerTrade ?? 1} onChange={e => updateField('risk', 'riskPerTrade', parseFloat(e.target.value) || 0)} step={0.1} className="h-9 text-sm" />
                      </FieldGroup>
                      <FieldGroup label="Max Daily Drawdown (%)" description="Halt trading if daily loss exceeds this">
                        <Input type="number" value={config.risk?.maxDailyDrawdown ?? 3} onChange={e => updateField('risk', 'maxDailyDrawdown', parseFloat(e.target.value) || 0)} step={0.5} className="h-9 text-sm" />
                      </FieldGroup>
                      <FieldGroup label="Max Concurrent Trades" description="Maximum open positions at once">
                        <Input type="number" value={config.risk?.maxConcurrentTrades ?? 5} onChange={e => updateField('risk', 'maxConcurrentTrades', parseFloat(e.target.value) || 0)} min={1} max={20} className="h-9 text-sm" />
                      </FieldGroup>
                      <FieldGroup label="Min R:R Ratio" description="Minimum risk-to-reward ratio">
                        <Input type="number" value={config.risk?.minRR ?? 1.5} onChange={e => updateField('risk', 'minRR', parseFloat(e.target.value) || 0)} step={0.5} className="h-9 text-sm" />
                      </FieldGroup>
                    </div>
                    <FieldGroup label="Max Total Drawdown (%)" description="Kill switch if total drawdown exceeds this">
                      <Input type="number" value={config.risk?.maxDrawdown ?? 15} onChange={e => updateField('risk', 'maxDrawdown', parseFloat(e.target.value) || 0)} className="h-9 text-sm" />
                    </FieldGroup>
                  </div>
                )}

                {activeTab === "entry_exit" && (
                  <div className="space-y-5">
                    <SectionHeader title="Entry & Exit Rules" description="Configure trade entry timing and exit strategies" />
                    <div className="space-y-4">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Entry</p>
                      <FieldGroup label="Cooldown Between Trades (minutes)" description="Minimum wait time between consecutive trades">
                        <Input type="number" value={config.entry?.cooldownMinutes ?? 30} onChange={e => updateField('entry', 'cooldownMinutes', parseFloat(e.target.value) || 0)} className="h-9 text-sm" />
                      </FieldGroup>
                      <ToggleField label="Close on Reverse Signal" description="Auto-close position when an opposite signal appears" checked={config.entry?.closeOnReverse ?? false} onChange={v => updateField('entry', 'closeOnReverse', v)} />
                    </div>
                    <div className="border-t border-border pt-4 space-y-4">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Exit</p>
                      <div className="grid grid-cols-2 gap-4">
                        <ToggleField label="Trailing Stop" description="Move SL as price moves in favor" checked={config.exit?.trailingStop ?? false} onChange={v => updateField('exit', 'trailingStop', v)} />
                        <ToggleField label="Break Even" description="Move SL to entry once in profit" checked={config.exit?.breakEven ?? false} onChange={v => updateField('exit', 'breakEven', v)} />
                        <ToggleField label="Partial Take Profit" description="Close portion of position at first TP" checked={config.exit?.partialTP ?? false} onChange={v => updateField('exit', 'partialTP', v)} />
                      </div>
                      <FieldGroup label="Time-Based Exit (hours)" description="Auto-close after N hours (0 = disabled)">
                        <Input type="number" value={config.exit?.timeExitHours ?? 0} onChange={e => updateField('exit', 'timeExitHours', parseFloat(e.target.value) || 0)} className="h-9 text-sm" />
                      </FieldGroup>
                    </div>
                  </div>
                )}

                {activeTab === "instruments" && (
                  <div className="space-y-5">
                    <SectionHeader title="Instruments" description="Select which instruments to scan" />
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-muted-foreground">{(config.instruments?.enabled || INSTRUMENTS.map(i => i.symbol)).length} / {INSTRUMENTS.length} enabled</span>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="sm" className="text-[10px] h-6" onClick={() => updateField('instruments', 'enabled', INSTRUMENTS.map(i => i.symbol))}>All</Button>
                        <Button variant="ghost" size="sm" className="text-[10px] h-6" onClick={() => updateField('instruments', 'enabled', [])}>None</Button>
                      </div>
                    </div>
                    {INSTRUMENT_TYPES.map(type => {
                      const typeInstruments = INSTRUMENTS.filter(i => i.type === type);
                      const enabledInType = typeInstruments.filter(i => (config.instruments?.enabled || INSTRUMENTS.map(x => x.symbol)).includes(i.symbol)).length;
                      return (
                        <div key={type} className="space-y-2">
                          <div className="flex items-center justify-between">
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">{INSTRUMENT_TYPE_LABELS[type]} <span className="font-normal">({enabledInType}/{typeInstruments.length})</span></p>
                            <div className="flex gap-1">
                              <Button variant="ghost" size="sm" className="text-[9px] h-5 px-1.5" onClick={() => {
                                const current = config.instruments?.enabled || INSTRUMENTS.map(i => i.symbol);
                                const typeSymbols = typeInstruments.map(i => i.symbol);
                                updateField('instruments', 'enabled', [...new Set([...current, ...typeSymbols])]);
                              }}>All</Button>
                              <Button variant="ghost" size="sm" className="text-[9px] h-5 px-1.5" onClick={() => {
                                const current = config.instruments?.enabled || INSTRUMENTS.map(i => i.symbol);
                                const typeSymbols = typeInstruments.map(i => i.symbol);
                                updateField('instruments', 'enabled', current.filter((s: string) => !typeSymbols.includes(s)));
                              }}>None</Button>
                            </div>
                          </div>
                          <div className="grid grid-cols-3 gap-2">
                            {typeInstruments.map(inst => {
                              const enabled = config.instruments?.enabled?.includes(inst.symbol) ?? true;
                              return (
                                <button
                                  key={inst.symbol}
                                  onClick={() => {
                                    const current = config.instruments?.enabled || INSTRUMENTS.map(i => i.symbol);
                                    updateField('instruments', 'enabled', enabled ? current.filter((s: string) => s !== inst.symbol) : [...current, inst.symbol]);
                                  }}
                                  className={`flex items-center gap-2 px-3 py-2 border text-xs transition-colors ${enabled ? "border-primary/40 bg-primary/5 text-foreground" : "border-border text-muted-foreground hover:border-border/80"}`}
                                >
                                  <span className={`w-1.5 h-1.5 rounded-full ${enabled ? "bg-primary" : "bg-muted-foreground/30"}`} />
                                  {inst.symbol}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {activeTab === "sessions" && (
                  <div className="space-y-5">
                    <SectionHeader title="Trading Sessions" description="Control which market sessions the bot is active during" />
                    <div className="grid grid-cols-2 gap-3">
                      {[
                        { id: "asian", label: "Asian", time: "00:00 – 09:00 UTC" },
                        { id: "london", label: "London", time: "07:00 – 16:00 UTC" },
                        { id: "newyork", label: "New York", time: "12:00 – 21:00 UTC" },
                        { id: "sydney", label: "Sydney", time: "21:00 – 06:00 UTC" },
                      ].map(session => {
                        const enabled = config.sessions?.filter?.includes(session.id) ?? true;
                        return (
                          <button
                            key={session.id}
                            onClick={() => {
                              const current = config.sessions?.filter || ["asian", "london", "newyork", "sydney"];
                              updateField('sessions', 'filter', enabled ? current.filter((s: string) => s !== session.id) : [...current, session.id]);
                            }}
                            className={`flex items-center justify-between px-4 py-3 border text-left transition-colors ${enabled ? "border-primary/40 bg-primary/5" : "border-border text-muted-foreground"}`}
                          >
                            <div>
                              <p className="text-xs font-medium">{session.label}</p>
                              <p className="text-[10px] text-muted-foreground">{session.time}</p>
                            </div>
                            <span className={`w-2 h-2 rounded-full ${enabled ? "bg-primary" : "bg-muted-foreground/30"}`} />
                          </button>
                        );
                      })}
                    </div>
                    <ToggleField label="Kill Zone Only Trading" description="Only trade during high-volume kill zone windows" checked={config.sessions?.killZoneOnly ?? false} onChange={v => updateField('sessions', 'killZoneOnly', v)} />
                  </div>
                )}

                {activeTab === "protection" && (
                  <div className="space-y-5">
                    <SectionHeader title="Protection" description="Safety limits and circuit breakers" />
                    <div className="grid grid-cols-2 gap-4">
                      <FieldGroup label="Max Daily Loss ($)" description="Hard dollar limit — triggers kill switch">
                        <Input type="number" value={config.protection?.maxDailyLoss ?? 500} onChange={e => updateField('protection', 'maxDailyLoss', parseFloat(e.target.value) || 0)} className="h-9 text-sm" />
                      </FieldGroup>
                      <FieldGroup label="Max Consecutive Losses" description="Pause after N consecutive losing trades">
                        <Input type="number" value={config.protection?.maxConsecutiveLosses ?? 3} onChange={e => updateField('protection', 'maxConsecutiveLosses', parseFloat(e.target.value) || 0)} min={1} max={10} className="h-9 text-sm" />
                      </FieldGroup>
                    </div>
                    <FieldGroup label="Equity Circuit Breaker (%)" description="Emergency stop if equity drops below this percentage of peak">
                      <div className="flex items-center gap-4">
                        <Slider value={[config.protection?.circuitBreakerPct ?? 20]} onValueChange={v => updateField('protection', 'circuitBreakerPct', v[0])} min={5} max={50} step={1} className="flex-1" />
                        <span className="text-sm font-mono font-bold text-destructive w-10 text-right">{config.protection?.circuitBreakerPct ?? 20}%</span>
                      </div>
                    </FieldGroup>
                  </div>
                )}

                {activeTab === "openingRange" && (
                  <div className="space-y-5">
                    <SectionHeader title="Opening Range" description="Use the first N hourly candles of the trading day to derive bias, levels, and filters" />
                    <ToggleField label="Enable Opening Range" description="Master toggle — all sub-features require this to be on" checked={config.openingRange?.enabled ?? false} onChange={v => updateField('openingRange', 'enabled', v)} />
                    <FieldGroup label="Candle Count" description="Number of 1h candles that define the opening range (default 24)">
                      <Input type="number" value={config.openingRange?.candleCount ?? 24} onChange={e => updateField('openingRange', 'candleCount', Math.max(1, parseInt(e.target.value) || 24))} min={1} max={48} className="h-9 text-sm" disabled={!config.openingRange?.enabled} />
                    </FieldGroup>
                    <div className="grid grid-cols-2 gap-3">
                      <ToggleField label="Daily Bias from OR" description="Determine bullish/bearish bias based on price vs OR range" checked={config.openingRange?.useBias ?? true} onChange={v => updateField('openingRange', 'useBias', v)} />
                      <ToggleField label="Judas Swing Detection" description="Detect fake breakouts (sweeps) of OR high/low" checked={config.openingRange?.useJudasSwing ?? true} onChange={v => updateField('openingRange', 'useJudasSwing', v)} />
                      <ToggleField label="OR Key Levels" description="Use OR high, low, midpoint as support/resistance" checked={config.openingRange?.useKeyLevels ?? true} onChange={v => updateField('openingRange', 'useKeyLevels', v)} />
                      <ToggleField label="Premium/Discount from OR" description="Use OR range instead of swing range for P/D zones" checked={config.openingRange?.usePremiumDiscount ?? false} onChange={v => updateField('openingRange', 'usePremiumDiscount', v)} />
                    </div>
                    <ToggleField label="Wait for OR Completion" description="Don't trade until the opening range candle count is fully formed" checked={config.openingRange?.waitForCompletion ?? true} onChange={v => updateField('openingRange', 'waitForCompletion', v)} />
                    {!config.openingRange?.enabled && (
                      <p className="text-[10px] text-muted-foreground italic">Enable the master toggle above to activate sub-features.</p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-2">
      <h3 className="text-sm font-bold">{title}</h3>
      <p className="text-[11px] text-muted-foreground">{description}</p>
    </div>
  );
}

function FieldGroup({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div>
        <Label className="text-xs font-medium">{label}</Label>
        {description && <p className="text-[10px] text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

function ToggleField({ label, description, checked, onChange }: { label: string; description?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-3 p-3 border border-border hover:border-border/80 transition-colors">
      <div>
        <p className="text-xs font-medium">{label}</p>
        {description && <p className="text-[10px] text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} className="shrink-0 mt-0.5" />
    </div>
  );
}

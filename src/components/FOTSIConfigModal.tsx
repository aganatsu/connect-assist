import React, { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { fotsiConfigApi } from "@/lib/api";
import { toast } from "sonner";
import {
  X, Zap, Shield, TrendingUp, Clock, BarChart3,
  Target, Activity, Settings2,
} from "lucide-react";

// ─── Default config (mirrors bot-scanner-fotsi DEFAULTS) ──────────
const DEFAULTS = {
  minDivergenceSpread: 40,
  hookRequired: true,
  hookBars: 3,
  minExtremeLevel: 25,
  riskPerTrade: 1.0,
  maxConcurrent: 3,
  cooldownMinutes: 240,
  maxDailyLoss: 3.0,
  maxDailyTrades: 5,
  slMethod: "atr" as "structure" | "atr" | "fixed",
  slATRMultiplier: 2.0,
  slFixedPips: 50,
  slBufferPips: 2,
  minRR: 2.0,
  tp1Method: "ema50" as "ema50" | "fixed_rr",
  tp2Method: "ema100" as "ema100" | "fixed_rr",
  tp1RR: 1.5,
  tp2RR: 3.0,
  partialClosePercent: 50,
  maxHoldHours: 48,
  breakEvenAfterTP1: true,
  sessions: {
    london: true,
    newYork: true,
    asian: false,
    sydney: false,
  },
  killZoneOnly: false,
  ema50Period: 50,
  ema100Period: 100,
  entryTimeframe: "4h" as "1h" | "4h",
};

type Config = typeof DEFAULTS;

// ─── Presets ──────────────────────────────────────────────────────
const PRESETS = {
  conservative: {
    minDivergenceSpread: 50,
    riskPerTrade: 0.5,
    maxConcurrent: 2,
    maxDailyLoss: 2.0,
    minRR: 2.5,
    description: "Wide spreads, low risk, fewer trades",
  },
  balanced: {
    minDivergenceSpread: 40,
    riskPerTrade: 1.0,
    maxConcurrent: 3,
    maxDailyLoss: 3.0,
    minRR: 2.0,
    description: "Default settings — balanced approach",
  },
  aggressive: {
    minDivergenceSpread: 30,
    riskPerTrade: 1.5,
    maxConcurrent: 5,
    maxDailyLoss: 5.0,
    minRR: 1.5,
    description: "Tighter spreads, more trades, higher risk",
  },
};

// ─── Tab definitions ──────────────────────────────────────────────
const TABS = [
  { id: "divergence", label: "Divergence", icon: BarChart3 },
  { id: "risk", label: "Risk", icon: Shield },
  { id: "sl_tp", label: "SL / TP", icon: Target },
  { id: "sessions", label: "Sessions", icon: Clock },
];

interface FOTSIConfigModalProps {
  open: boolean;
  onClose: () => void;
}

export function FOTSIConfigModal({ open, onClose }: FOTSIConfigModalProps) {
  const queryClient = useQueryClient();
  const [config, setConfig] = useState<Config | null>(null);
  const [activeTab, setActiveTab] = useState("divergence");

  const { data: rawConfig } = useQuery({
    queryKey: ["fotsi-config"],
    queryFn: () => fotsiConfigApi.get(),
    enabled: open,
  });

  useEffect(() => {
    if (open) {
      if (rawConfig) {
        // Merge with defaults to fill any missing fields
        setConfig({ ...DEFAULTS, ...rawConfig, sessions: { ...DEFAULTS.sessions, ...(rawConfig?.sessions || {}) } });
      } else {
        setConfig({ ...DEFAULTS });
      }
    }
  }, [rawConfig, open]);

  const saveMut = useMutation({
    mutationFn: (cfg: Config) => fotsiConfigApi.update(cfg),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fotsi-config"] });
      toast.success("FOTSI config saved");
      onClose();
    },
    onError: (e: any) => toast.error(e?.message || "Failed to save FOTSI config"),
  });

  const resetMut = useMutation({
    mutationFn: () => fotsiConfigApi.reset(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fotsi-config"] });
      setConfig({ ...DEFAULTS });
      toast.success("FOTSI config reset to defaults");
    },
    onError: (e: any) => toast.error(e?.message || "Failed to reset FOTSI config"),
  });

  const update = (key: string, value: any) => {
    setConfig((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const updateSession = (key: string, value: boolean) => {
    setConfig((prev) =>
      prev ? { ...prev, sessions: { ...prev.sessions, [key]: value } } : prev
    );
  };

  if (!open || !config) return null;

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-card border border-border w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            <div>
              <h2 className="text-base font-bold">Bot #2 — FOTSI Mean Reversion Config</h2>
              <p className="text-[10px] text-muted-foreground">Magala-style currency strength mean reversion settings</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => resetMut.mutate()} disabled={resetMut.isPending}>
              Reset Defaults
            </Button>
            <Button type="button" size="sm" className="text-xs" onClick={() => config && saveMut.mutate(config)} disabled={saveMut.isPending || !config}>
              {saveMut.isPending ? "Saving..." : "Save Config"}
            </Button>
            <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground ml-2">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Presets Bar */}
        <div className="px-6 py-3 border-b border-border bg-secondary/30">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1">
            <Zap className="h-3 w-3 text-primary" /> Quick Presets
          </p>
          <div className="grid grid-cols-3 gap-3">
            {Object.entries(PRESETS).map(([key, preset]) => (
              <button
                type="button"
                key={key}
                onClick={() => {
                  setConfig((prev) =>
                    prev
                      ? {
                          ...prev,
                          minDivergenceSpread: preset.minDivergenceSpread,
                          riskPerTrade: preset.riskPerTrade,
                          maxConcurrent: preset.maxConcurrent,
                          maxDailyLoss: preset.maxDailyLoss,
                          minRR: preset.minRR,
                        }
                      : prev
                  );
                  toast.info(`Applied ${key} preset`);
                }}
                className="p-3 border border-border hover:border-primary/50 hover:bg-primary/5 transition-colors text-left"
              >
                <p className="text-xs font-bold capitalize">{key}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">{preset.description}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Body: Tab nav + content */}
        <div className="flex flex-1 min-h-0">
          {/* Vertical Tab Nav */}
          <div className="w-40 border-r border-border py-2 shrink-0 overflow-y-auto">
            {TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  type="button"
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-xs transition-colors ${
                    isActive
                      ? "bg-primary/10 text-primary border-l-2 border-primary font-medium"
                      : "text-muted-foreground hover:text-foreground hover:bg-secondary/30 border-l-2 border-transparent"
                  }`}
                >
                  <tab.icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="text-left">{tab.label}</span>
                </button>
              );
            })}
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-y-auto p-6 space-y-5">
            {activeTab === "divergence" && (
              <>
                <SectionHeader
                  title="Divergence & Hook Settings"
                  description="Controls how the bot identifies currency strength divergences and hook entry signals"
                />

                <FieldRow label="Min Divergence Spread" hint="Minimum TSI spread between base and quote currencies to consider a pair">
                  <div className="flex items-center gap-3">
                    <Slider
                      value={[config.minDivergenceSpread]}
                      onValueChange={([v]) => update("minDivergenceSpread", v)}
                      min={20}
                      max={80}
                      step={5}
                      className="flex-1"
                    />
                    <span className="text-xs font-mono font-bold w-8 text-right">{config.minDivergenceSpread}</span>
                  </div>
                </FieldRow>

                <FieldRow label="Require Hook Signal" hint="Require TSI line to curve back from extremes before entry">
                  <Switch checked={config.hookRequired} onCheckedChange={(v) => update("hookRequired", v)} />
                </FieldRow>

                <FieldRow label="Hook Detection Bars" hint="Number of bars to detect hook pattern (TSI deceleration)">
                  <Input
                    type="number"
                    value={config.hookBars}
                    onChange={(e) => update("hookBars", parseInt(e.target.value) || 3)}
                    className="w-20 h-8 text-xs"
                    min={2}
                    max={10}
                  />
                </FieldRow>

                <FieldRow label="Min Extreme Level" hint="Currency must be outside ±this value to qualify as extreme">
                  <div className="flex items-center gap-3">
                    <Slider
                      value={[config.minExtremeLevel]}
                      onValueChange={([v]) => update("minExtremeLevel", v)}
                      min={15}
                      max={50}
                      step={5}
                      className="flex-1"
                    />
                    <span className="text-xs font-mono font-bold w-8 text-right">±{config.minExtremeLevel}</span>
                  </div>
                </FieldRow>

                <FieldRow label="Entry Timeframe" hint="Candle timeframe for entry signals">
                  <Select value={config.entryTimeframe} onValueChange={(v) => update("entryTimeframe", v)}>
                    <SelectTrigger className="w-28 h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1h">1 Hour</SelectItem>
                      <SelectItem value="4h">4 Hour</SelectItem>
                    </SelectContent>
                  </Select>
                </FieldRow>
              </>
            )}

            {activeTab === "risk" && (
              <>
                <SectionHeader
                  title="Risk Management"
                  description="Position sizing, exposure limits, and daily loss controls"
                />

                <FieldRow label="Risk per Trade (%)" hint="Percentage of account balance risked per trade">
                  <div className="flex items-center gap-3">
                    <Slider
                      value={[config.riskPerTrade]}
                      onValueChange={([v]) => update("riskPerTrade", v)}
                      min={0.25}
                      max={3}
                      step={0.25}
                      className="flex-1"
                    />
                    <span className="text-xs font-mono font-bold w-10 text-right">{config.riskPerTrade}%</span>
                  </div>
                </FieldRow>

                <FieldRow label="Max Concurrent Positions" hint="Maximum number of Bot #2 positions open at once">
                  <Input
                    type="number"
                    value={config.maxConcurrent}
                    onChange={(e) => update("maxConcurrent", parseInt(e.target.value) || 3)}
                    className="w-20 h-8 text-xs"
                    min={1}
                    max={10}
                  />
                </FieldRow>

                <FieldRow label="Max Daily Trades" hint="Maximum trades per day for Bot #2">
                  <Input
                    type="number"
                    value={config.maxDailyTrades}
                    onChange={(e) => update("maxDailyTrades", parseInt(e.target.value) || 5)}
                    className="w-20 h-8 text-xs"
                    min={1}
                    max={20}
                  />
                </FieldRow>

                <FieldRow label="Max Daily Loss (%)" hint="Stop trading if daily loss exceeds this percentage">
                  <div className="flex items-center gap-3">
                    <Slider
                      value={[config.maxDailyLoss]}
                      onValueChange={([v]) => update("maxDailyLoss", v)}
                      min={1}
                      max={10}
                      step={0.5}
                      className="flex-1"
                    />
                    <span className="text-xs font-mono font-bold w-10 text-right">{config.maxDailyLoss}%</span>
                  </div>
                </FieldRow>

                <FieldRow label="Cooldown Between Trades (min)" hint="Minimum wait time between trades on the same pair">
                  <Input
                    type="number"
                    value={config.cooldownMinutes}
                    onChange={(e) => update("cooldownMinutes", parseInt(e.target.value) || 240)}
                    className="w-24 h-8 text-xs"
                    min={30}
                    max={1440}
                  />
                </FieldRow>

                <FieldRow label="Min Risk:Reward Ratio" hint="Minimum R:R required to take a trade">
                  <div className="flex items-center gap-3">
                    <Slider
                      value={[config.minRR]}
                      onValueChange={([v]) => update("minRR", v)}
                      min={1}
                      max={5}
                      step={0.5}
                      className="flex-1"
                    />
                    <span className="text-xs font-mono font-bold w-10 text-right">1:{config.minRR}</span>
                  </div>
                </FieldRow>
              </>
            )}

            {activeTab === "sl_tp" && (
              <>
                <SectionHeader
                  title="Stop Loss & Take Profit"
                  description="SL method, TP targets (EMA-based or fixed R:R), and partial close settings"
                />

                <FieldRow label="SL Method" hint="How stop loss is calculated">
                  <Select value={config.slMethod} onValueChange={(v) => update("slMethod", v)}>
                    <SelectTrigger className="w-36 h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="atr">ATR-Based</SelectItem>
                      <SelectItem value="structure">Structure (Swing)</SelectItem>
                      <SelectItem value="fixed">Fixed Pips</SelectItem>
                    </SelectContent>
                  </Select>
                </FieldRow>

                {config.slMethod === "atr" && (
                  <FieldRow label="ATR Multiplier" hint="SL = ATR × this multiplier">
                    <div className="flex items-center gap-3">
                      <Slider
                        value={[config.slATRMultiplier]}
                        onValueChange={([v]) => update("slATRMultiplier", v)}
                        min={1}
                        max={4}
                        step={0.25}
                        className="flex-1"
                      />
                      <span className="text-xs font-mono font-bold w-10 text-right">{config.slATRMultiplier}×</span>
                    </div>
                  </FieldRow>
                )}

                {config.slMethod === "fixed" && (
                  <FieldRow label="Fixed SL Pips" hint="Stop loss distance in pips">
                    <Input
                      type="number"
                      value={config.slFixedPips}
                      onChange={(e) => update("slFixedPips", parseInt(e.target.value) || 50)}
                      className="w-20 h-8 text-xs"
                      min={10}
                      max={200}
                    />
                  </FieldRow>
                )}

                <FieldRow label="SL Buffer (pips)" hint="Extra buffer above/below SL level">
                  <Input
                    type="number"
                    value={config.slBufferPips}
                    onChange={(e) => update("slBufferPips", parseInt(e.target.value) || 2)}
                    className="w-20 h-8 text-xs"
                    min={0}
                    max={10}
                  />
                </FieldRow>

                <div className="border-t border-border pt-4 mt-4">
                  <p className="text-xs font-bold mb-3">Take Profit Settings</p>
                </div>

                <FieldRow label="TP1 Method" hint="First take profit target (partial close)">
                  <Select value={config.tp1Method} onValueChange={(v) => update("tp1Method", v)}>
                    <SelectTrigger className="w-36 h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ema50">EMA 50 (Dynamic)</SelectItem>
                      <SelectItem value="fixed_rr">Fixed R:R</SelectItem>
                    </SelectContent>
                  </Select>
                </FieldRow>

                {config.tp1Method === "fixed_rr" && (
                  <FieldRow label="TP1 R:R" hint="Risk:Reward ratio for TP1">
                    <div className="flex items-center gap-3">
                      <Slider
                        value={[config.tp1RR]}
                        onValueChange={([v]) => update("tp1RR", v)}
                        min={0.5}
                        max={3}
                        step={0.25}
                        className="flex-1"
                      />
                      <span className="text-xs font-mono font-bold w-10 text-right">1:{config.tp1RR}</span>
                    </div>
                  </FieldRow>
                )}

                <FieldRow label="TP2 Method" hint="Second take profit target (full close)">
                  <Select value={config.tp2Method} onValueChange={(v) => update("tp2Method", v)}>
                    <SelectTrigger className="w-36 h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ema100">EMA 100 (Dynamic)</SelectItem>
                      <SelectItem value="fixed_rr">Fixed R:R</SelectItem>
                    </SelectContent>
                  </Select>
                </FieldRow>

                {config.tp2Method === "fixed_rr" && (
                  <FieldRow label="TP2 R:R" hint="Risk:Reward ratio for TP2">
                    <div className="flex items-center gap-3">
                      <Slider
                        value={[config.tp2RR]}
                        onValueChange={([v]) => update("tp2RR", v)}
                        min={1}
                        max={5}
                        step={0.5}
                        className="flex-1"
                      />
                      <span className="text-xs font-mono font-bold w-10 text-right">1:{config.tp2RR}</span>
                    </div>
                  </FieldRow>
                )}

                <FieldRow label="Partial Close at TP1 (%)" hint="Percentage of position to close at TP1">
                  <div className="flex items-center gap-3">
                    <Slider
                      value={[config.partialClosePercent]}
                      onValueChange={([v]) => update("partialClosePercent", v)}
                      min={25}
                      max={75}
                      step={5}
                      className="flex-1"
                    />
                    <span className="text-xs font-mono font-bold w-10 text-right">{config.partialClosePercent}%</span>
                  </div>
                </FieldRow>

                <FieldRow label="Break Even After TP1" hint="Move SL to entry price after TP1 is hit">
                  <Switch checked={config.breakEvenAfterTP1} onCheckedChange={(v) => update("breakEvenAfterTP1", v)} />
                </FieldRow>

                <FieldRow label="Max Hold Time (hours)" hint="Auto-close position after this many hours">
                  <Input
                    type="number"
                    value={config.maxHoldHours}
                    onChange={(e) => update("maxHoldHours", parseInt(e.target.value) || 48)}
                    className="w-20 h-8 text-xs"
                    min={4}
                    max={168}
                  />
                </FieldRow>
              </>
            )}

            {activeTab === "sessions" && (
              <>
                <SectionHeader
                  title="Session Filter"
                  description="Which trading sessions Bot #2 is allowed to scan and trade during"
                />

                <div className="space-y-3">
                  {[
                    { key: "london", label: "London Session", time: "3:00 AM – 12:00 PM NY", emoji: "🇬🇧" },
                    { key: "newYork", label: "New York Session", time: "8:00 AM – 5:00 PM NY", emoji: "🇺🇸" },
                    { key: "asian", label: "Asian Session", time: "7:00 PM – 4:00 AM NY", emoji: "🇯🇵" },
                    { key: "sydney", label: "Sydney Session", time: "5:00 PM – 2:00 AM NY", emoji: "🇦🇺" },
                  ].map((s) => (
                    <div key={s.key} className="flex items-center justify-between p-3 border border-border hover:border-border/80 transition-colors">
                      <div className="flex items-center gap-2">
                        <span className="text-sm">{s.emoji}</span>
                        <div>
                          <p className="text-xs font-bold">{s.label}</p>
                          <p className="text-[10px] text-muted-foreground">{s.time}</p>
                        </div>
                      </div>
                      <Switch
                        checked={config.sessions[s.key as keyof typeof config.sessions]}
                        onCheckedChange={(v) => updateSession(s.key, v)}
                      />
                    </div>
                  ))}
                </div>

                <FieldRow label="Kill Zone Only" hint="Only trade during high-volume kill zone windows within active sessions">
                  <Switch checked={config.killZoneOnly} onCheckedChange={(v) => update("killZoneOnly", v)} />
                </FieldRow>

                <div className="border-t border-border pt-4 mt-4">
                  <p className="text-xs font-bold mb-3">EMA Periods (for TP calculation)</p>
                </div>

                <FieldRow label="EMA 50 Period" hint="Period for the fast EMA used in TP1 calculation">
                  <Input
                    type="number"
                    value={config.ema50Period}
                    onChange={(e) => update("ema50Period", parseInt(e.target.value) || 50)}
                    className="w-20 h-8 text-xs"
                    min={20}
                    max={100}
                  />
                </FieldRow>

                <FieldRow label="EMA 100 Period" hint="Period for the slow EMA used in TP2 calculation">
                  <Input
                    type="number"
                    value={config.ema100Period}
                    onChange={(e) => update("ema100Period", parseInt(e.target.value) || 100)}
                    className="w-20 h-8 text-xs"
                    min={50}
                    max={200}
                  />
                </FieldRow>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Shared sub-components ────────────────────────────────────────

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-4">
      <h3 className="text-sm font-bold">{title}</h3>
      <p className="text-[10px] text-muted-foreground mt-0.5">{description}</p>
    </div>
  );
}

function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <Label className="text-xs font-medium">{label}</Label>
        {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { botConfigApi } from "@/lib/api";
import { INSTRUMENTS } from "@/lib/marketData";
import { toast } from "sonner";
import { X, Zap } from "lucide-react";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";

const PRESETS = {
  conservative: { confluenceThreshold: 7, riskPerTrade: 0.5, maxDailyDrawdown: 2, maxConcurrentTrades: 2, description: "Low risk, high confluence" },
  moderate: { confluenceThreshold: 5, riskPerTrade: 1, maxDailyDrawdown: 3, maxConcurrentTrades: 4, description: "Balanced" },
  aggressive: { confluenceThreshold: 3, riskPerTrade: 2, maxDailyDrawdown: 5, maxConcurrentTrades: 6, description: "Higher risk" },
};

interface BotConfigModalProps {
  open: boolean;
  onClose: () => void;
}

export function BotConfigModal({ open, onClose }: BotConfigModalProps) {
  const queryClient = useQueryClient();
  const { data: rawConfig } = useQuery({ queryKey: ["bot-config"], queryFn: () => botConfigApi.get(), enabled: open });
  const [config, setConfig] = useState<any>(null);

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

  return (
    <div className="fixed inset-0 z-50 bg-background/95 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h2 className="text-lg font-bold">Bot Configuration</h2>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => resetMut.mutate()}>Reset Defaults</Button>
          <Button size="sm" onClick={() => saveMut.mutate()}>Save Config</Button>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground ml-2"><X className="h-5 w-5" /></button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 max-w-3xl mx-auto w-full space-y-3">
        {/* Presets */}
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1"><Zap className="h-3 w-3" /> Presets</p>
          <div className="grid grid-cols-3 gap-2">
            {Object.entries(PRESETS).map(([key, preset]) => (
              <button key={key} onClick={() => {
                if (!config) return;
                setConfig({
                  ...config,
                  strategy: { ...(config.strategy || {}), confluenceThreshold: preset.confluenceThreshold },
                  risk: { ...(config.risk || {}), riskPerTrade: preset.riskPerTrade, maxDailyDrawdown: preset.maxDailyDrawdown, maxConcurrentTrades: preset.maxConcurrentTrades },
                });
                toast.info(`Applied ${key} preset`);
              }} className="p-2 border border-border hover:border-primary/50 text-left">
                <p className="text-xs font-medium capitalize">{key}</p>
                <p className="text-[9px] text-muted-foreground">{preset.description}</p>
              </button>
            ))}
          </div>
        </div>

        {config && (
          <>
            <ConfigSection title="Strategy">
              <ConfigNumber label="Confluence Threshold (1-10)" value={config.strategy?.confluenceThreshold ?? 5} onChange={v => updateField('strategy', 'confluenceThreshold', v)} min={1} max={10} />
              <ConfigToggle label="Use Order Blocks" checked={config.strategy?.useOrderBlocks ?? true} onChange={v => updateField('strategy', 'useOrderBlocks', v)} />
              <ConfigToggle label="Use Fair Value Gaps" checked={config.strategy?.useFVG ?? true} onChange={v => updateField('strategy', 'useFVG', v)} />
              <ConfigToggle label="Use Liquidity Sweeps" checked={config.strategy?.useLiquiditySweep ?? true} onChange={v => updateField('strategy', 'useLiquiditySweep', v)} />
              <ConfigToggle label="Use Structure Breaks (BOS/CHoCH)" checked={config.strategy?.useStructureBreak ?? true} onChange={v => updateField('strategy', 'useStructureBreak', v)} />
              <ConfigToggle label="Require HTF Bias Alignment" checked={config.strategy?.requireHTFBias ?? true} onChange={v => updateField('strategy', 'requireHTFBias', v)} />
            </ConfigSection>

            <ConfigSection title="Risk Management">
              <ConfigNumber label="Risk per Trade (%)" value={config.risk?.riskPerTrade ?? 1} onChange={v => updateField('risk', 'riskPerTrade', v)} step={0.1} />
              <ConfigNumber label="Max Daily Drawdown (%)" value={config.risk?.maxDailyDrawdown ?? 3} onChange={v => updateField('risk', 'maxDailyDrawdown', v)} step={0.5} />
              <ConfigNumber label="Max Concurrent Trades" value={config.risk?.maxConcurrentTrades ?? 5} onChange={v => updateField('risk', 'maxConcurrentTrades', v)} min={1} max={20} />
              <ConfigNumber label="Min R:R Ratio" value={config.risk?.minRR ?? 1.5} onChange={v => updateField('risk', 'minRR', v)} step={0.5} />
              <ConfigNumber label="Max Drawdown (%)" value={config.risk?.maxDrawdown ?? 15} onChange={v => updateField('risk', 'maxDrawdown', v)} />
            </ConfigSection>

            <ConfigSection title="Entry Rules">
              <ConfigNumber label="Cooldown Between Trades (min)" value={config.entry?.cooldownMinutes ?? 30} onChange={v => updateField('entry', 'cooldownMinutes', v)} />
              <ConfigToggle label="Close on Reverse Signal" checked={config.entry?.closeOnReverse ?? false} onChange={v => updateField('entry', 'closeOnReverse', v)} />
            </ConfigSection>

            <ConfigSection title="Exit Rules">
              <ConfigToggle label="Trailing Stop" checked={config.exit?.trailingStop ?? false} onChange={v => updateField('exit', 'trailingStop', v)} />
              <ConfigToggle label="Break Even" checked={config.exit?.breakEven ?? false} onChange={v => updateField('exit', 'breakEven', v)} />
              <ConfigToggle label="Partial Take Profit" checked={config.exit?.partialTP ?? false} onChange={v => updateField('exit', 'partialTP', v)} />
              <ConfigNumber label="Time-Based Exit (hours, 0=off)" value={config.exit?.timeExitHours ?? 0} onChange={v => updateField('exit', 'timeExitHours', v)} />
            </ConfigSection>

            <ConfigSection title="Instruments">
              <div className="grid grid-cols-3 gap-1.5">
                {INSTRUMENTS.map(inst => {
                  const enabled = config.instruments?.enabled?.includes(inst.symbol) ?? true;
                  return (
                    <div key={inst.symbol} className="flex items-center gap-1.5">
                      <Switch checked={enabled} onCheckedChange={v => {
                        const current = config.instruments?.enabled || INSTRUMENTS.map(i => i.symbol);
                        updateField('instruments', 'enabled', v ? [...current, inst.symbol] : current.filter((s: string) => s !== inst.symbol));
                      }} className="h-4 w-7" />
                      <Label className="text-[10px]">{inst.symbol}</Label>
                    </div>
                  );
                })}
              </div>
            </ConfigSection>

            <ConfigSection title="Sessions">
              <div className="grid grid-cols-2 gap-1.5">
                {["asian", "london", "newyork", "sydney"].map(session => {
                  const enabled = config.sessions?.filter?.includes(session) ?? true;
                  return (
                    <div key={session} className="flex items-center gap-1.5">
                      <Switch checked={enabled} onCheckedChange={v => {
                        const current = config.sessions?.filter || ["asian", "london", "newyork", "sydney"];
                        updateField('sessions', 'filter', v ? [...current, session] : current.filter((s: string) => s !== session));
                      }} className="h-4 w-7" />
                      <Label className="text-[10px] capitalize">{session}</Label>
                    </div>
                  );
                })}
              </div>
              <ConfigToggle label="Kill Zone Only Trading" checked={config.sessions?.killZoneOnly ?? false} onChange={v => updateField('sessions', 'killZoneOnly', v)} />
            </ConfigSection>

            <ConfigSection title="Protection">
              <ConfigNumber label="Max Daily Loss Hard Limit ($)" value={config.protection?.maxDailyLoss ?? 500} onChange={v => updateField('protection', 'maxDailyLoss', v)} />
              <ConfigNumber label="Max Consecutive Losses Before Pause" value={config.protection?.maxConsecutiveLosses ?? 3} onChange={v => updateField('protection', 'maxConsecutiveLosses', v)} min={1} max={10} />
              <ConfigNumber label="Equity Circuit Breaker (%)" value={config.protection?.circuitBreakerPct ?? 20} onChange={v => updateField('protection', 'circuitBreakerPct', v)} />
            </ConfigSection>
          </>
        )}
      </div>
    </div>
  );
}

function ConfigSection({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="w-full flex items-center justify-between py-2 border-b border-border text-xs font-medium text-primary uppercase tracking-wider">
        {title}
        <span className="text-muted-foreground">{open ? "−" : "+"}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 py-2">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ConfigToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-2">
      <Switch checked={checked} onCheckedChange={onChange} className="h-4 w-7" />
      <Label className="text-[11px]">{label}</Label>
    </div>
  );
}

function ConfigNumber({ label, value, onChange, min, max, step }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  return (
    <div>
      <Label className="text-[10px] text-muted-foreground">{label}</Label>
      <Input type="number" value={value} onChange={e => onChange(parseFloat(e.target.value) || 0)} min={min} max={max} step={step} className="mt-0.5 h-7 text-[11px]" />
    </div>
  );
}

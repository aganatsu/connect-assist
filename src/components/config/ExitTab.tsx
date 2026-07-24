import React from "react";
import { ShieldAlert, Flag, GitBranch } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { CollapsibleSection, FieldGroup, ToggleField, ConfigTabProps } from "./ConfigShared";

export function ExitTab({ config, setConfig, updateField }: ConfigTabProps) {
  return (
    <div className="space-y-3">
      {/* ── Stop Loss ── */}
      <CollapsibleSection
        id="stopLoss"
        title="Stop Loss"
        subtitle="SL method, placement, and limits"
        icon={<ShieldAlert className="h-4 w-4" />}
        defaultOpen={true}
      >
        <FieldGroup label="SL Method" description="How the stop loss is calculated">
          <Select value={config.exit?.slMethod ?? "structure"} onValueChange={v => updateField('exit', 'slMethod', v)}>
            <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="structure">Structure — Beyond swing point</SelectItem>
              <SelectItem value="below_ob">Below OB — Beyond order block boundary</SelectItem>
              <SelectItem value="atr">ATR — Fixed ATR multiple</SelectItem>
              <SelectItem value="fixed_pips">Fixed Pips</SelectItem>
            </SelectContent>
          </Select>
        </FieldGroup>
        {config.exit?.slMethod === "atr" && (
          <FieldGroup label="ATR Multiple" description="SL distance as multiple of ATR">
            <div className="flex items-center gap-4">
              <Slider value={[config.exit?.slATRMultiple ?? 1.5]} onValueChange={v => updateField('exit', 'slATRMultiple', v[0])} min={0.5} max={4.0} step={0.25} className="flex-1" />
              <span className="text-sm font-mono font-bold w-12 text-right">{(config.exit?.slATRMultiple ?? 1.5).toFixed(2)}×</span>
            </div>
          </FieldGroup>
        )}
        {config.exit?.slMethod === "fixed_pips" && (
          <FieldGroup label="Fixed SL (pips)">
            <Input type="number" value={config.exit?.slFixedPips ?? 20} onChange={e => updateField('exit', 'slFixedPips', parseFloat(e.target.value) || 20)} min={5} max={200} step={5} className="h-9 text-sm" />
          </FieldGroup>
        )}
        <FieldGroup label="SL Buffer (pips)" description="Extra buffer beyond the calculated SL level">
          <div className="flex items-center gap-4">
            <Slider value={[config.exit?.slBufferPips ?? 2]} onValueChange={v => updateField('exit', 'slBufferPips', v[0])} min={0} max={10} step={0.5} className="flex-1" />
            <span className="text-sm font-mono font-bold w-12 text-right">{config.exit?.slBufferPips ?? 2}</span>
          </div>
        </FieldGroup>
        <FieldGroup label="Max SL (pips)" description="Hard cap on SL distance — skip trade if SL would exceed this">
          <Input type="number" value={config.exit?.maxSLPips ?? 50} onChange={e => updateField('exit', 'maxSLPips', parseFloat(e.target.value) || 50)} min={5} max={500} step={5} className="h-9 text-sm" />
        </FieldGroup>
        <FieldGroup label="Min SL (pips)" description="Minimum SL distance — prevents unrealistically tight stops">
          <Input type="number" value={config.exit?.minSLPips ?? 5} onChange={e => updateField('exit', 'minSLPips', parseFloat(e.target.value) || 5)} min={1} max={50} step={1} className="h-9 text-sm" />
        </FieldGroup>
      </CollapsibleSection>

      {/* ── Take Profit ── */}
      <CollapsibleSection
        id="takeProfit"
        title="Take Profit"
        subtitle="TP method, R:R targets, multi-TP levels"
        icon={<Flag className="h-4 w-4" />}
        defaultOpen={true}
      >
        <FieldGroup label="TP Method" description="How take profit is calculated">
          <Select value={config.exit?.tpMethod ?? "rr_ratio"} onValueChange={v => updateField('exit', 'tpMethod', v)}>
            <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="rr_ratio">R:R Ratio — Fixed risk/reward</SelectItem>
              <SelectItem value="next_level">Next Level — Zone-to-zone TP</SelectItem>
              <SelectItem value="fib_extension">Fib Extension — From impulse swing</SelectItem>
              <SelectItem value="fib_extension_3pt">Fib Extension 3-Point — From entry</SelectItem>
              <SelectItem value="atr">ATR Multiple</SelectItem>
              <SelectItem value="structure">Structure — Next HTF level</SelectItem>
            </SelectContent>
          </Select>
        </FieldGroup>
        {config.exit?.tpMethod === "rr_ratio" && (
          <FieldGroup label="R:R Target" description="Target reward as multiple of risk">
            <div className="flex items-center gap-4">
              <Slider value={[config.exit?.rrTarget ?? 3.0]} onValueChange={v => updateField('exit', 'rrTarget', v[0])} min={1.0} max={10.0} step={0.5} className="flex-1" />
              <span className="text-sm font-mono font-bold text-primary w-12 text-right">{(config.exit?.rrTarget ?? 3.0).toFixed(1)}R</span>
            </div>
          </FieldGroup>
        )}
        {config.exit?.tpMethod === "fib_extension_3pt" && (
          <FieldGroup label="Primary TP Level" description="Which fib extension to target">
            <Select value={String(config.exit?.fib3ptLevel ?? -0.272)} onValueChange={v => updateField('exit', 'fib3ptLevel', parseFloat(v))}>
              <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="-0.272">-27.2% — Conservative</SelectItem>
                <SelectItem value="-0.618">-61.8% — Standard</SelectItem>
                <SelectItem value="-1.0">-100% — Full extension</SelectItem>
              </SelectContent>
            </Select>
          </FieldGroup>
        )}
        <FieldGroup label="Min R:R" description="Minimum R:R to accept a trade — skip if TP/SL ratio is below this">
          <div className="flex items-center gap-4">
            <Slider value={[config.exit?.minRR ?? 2.0]} onValueChange={v => updateField('exit', 'minRR', v[0])} min={1.0} max={5.0} step={0.5} className="flex-1" />
            <span className="text-sm font-mono font-bold w-12 text-right">{(config.exit?.minRR ?? 2.0).toFixed(1)}R</span>
          </div>
        </FieldGroup>
        <div className="border-t border-border pt-3 space-y-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Multi-TP (Partial Exits)</p>
          <ToggleField label="Enable Multi-TP" description="Take partial profits at multiple levels" checked={config.exit?.multiTPEnabled ?? false} onChange={v => updateField('exit', 'multiTPEnabled', v)} />
          {config.exit?.multiTPEnabled && (
            <div className="grid grid-cols-3 gap-3">
              <FieldGroup label="TP1 (R)">
                <Input type="number" value={config.exit?.tp1R ?? 1.5} onChange={e => updateField('exit', 'tp1R', parseFloat(e.target.value) || 1.5)} step={0.5} min={0.5} className="h-9 text-sm" />
              </FieldGroup>
              <FieldGroup label="TP2 (R)">
                <Input type="number" value={config.exit?.tp2R ?? 3.0} onChange={e => updateField('exit', 'tp2R', parseFloat(e.target.value) || 3.0)} step={0.5} min={1.0} className="h-9 text-sm" />
              </FieldGroup>
              <FieldGroup label="TP3 (R)">
                <Input type="number" value={config.exit?.tp3R ?? 5.0} onChange={e => updateField('exit', 'tp3R', parseFloat(e.target.value) || 5.0)} step={0.5} min={1.5} className="h-9 text-sm" />
              </FieldGroup>
              <FieldGroup label="TP1 Close %">
                <Input type="number" value={config.exit?.tp1Pct ?? 40} onChange={e => updateField('exit', 'tp1Pct', parseInt(e.target.value) || 40)} min={10} max={90} step={10} className="h-9 text-sm" />
              </FieldGroup>
              <FieldGroup label="TP2 Close %">
                <Input type="number" value={config.exit?.tp2Pct ?? 30} onChange={e => updateField('exit', 'tp2Pct', parseInt(e.target.value) || 30)} min={10} max={90} step={10} className="h-9 text-sm" />
              </FieldGroup>
              <FieldGroup label="TP3 Close %">
                <Input type="number" value={config.exit?.tp3Pct ?? 30} onChange={e => updateField('exit', 'tp3Pct', parseInt(e.target.value) || 30)} min={10} max={90} step={10} className="h-9 text-sm" />
              </FieldGroup>
            </div>
          )}
        </div>
      </CollapsibleSection>

      {/* ── Trade Management ── */}
      <CollapsibleSection
        id="tradeManagement"
        title="Trade Management"
        subtitle="Trailing stop, break-even, time-based exits"
        icon={<GitBranch className="h-4 w-4" />}
        defaultOpen={false}
      >
        {/* Break-Even */}
        <div className="space-y-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Break-Even</p>
          <ToggleField label="Auto Break-Even" description="Move SL to entry after reaching target" checked={config.management?.breakEvenEnabled ?? true} onChange={v => updateField('management', 'breakEvenEnabled', v)} />
          {(config.management?.breakEvenEnabled ?? true) && (
            <div className="grid grid-cols-2 gap-3">
              <FieldGroup label="Trigger (R)">
                <div className="flex items-center gap-3">
                  <Slider value={[config.management?.breakEvenTriggerR ?? 1.0]} onValueChange={v => updateField('management', 'breakEvenTriggerR', v[0])} min={0.5} max={3.0} step={0.25} className="flex-1" />
                  <span className="text-[11px] font-mono w-8 text-right">{(config.management?.breakEvenTriggerR ?? 1.0).toFixed(2)}R</span>
                </div>
              </FieldGroup>
              <FieldGroup label="Lock Profit (pips)">
                <Input type="number" value={config.management?.breakEvenLockPips ?? 2} onChange={e => updateField('management', 'breakEvenLockPips', parseFloat(e.target.value) || 0)} min={0} max={20} step={1} className="h-9 text-sm" />
              </FieldGroup>
            </div>
          )}
        </div>

        {/* Trailing Stop */}
        <div className="border-t border-border pt-3 space-y-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Trailing Stop</p>
          <ToggleField label="Enable Trailing" description="Trail SL behind price as trade moves in profit" checked={config.management?.trailingEnabled ?? false} onChange={v => updateField('management', 'trailingEnabled', v)} />
          {config.management?.trailingEnabled && (
            <>
              <FieldGroup label="Trailing Method">
                <Select value={config.management?.trailingMethod ?? "atr"} onValueChange={v => updateField('management', 'trailingMethod', v)}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="atr">ATR-based</SelectItem>
                    <SelectItem value="structure">Structure-based (swing points)</SelectItem>
                    <SelectItem value="fixed">Fixed distance</SelectItem>
                    <SelectItem value="chandelier">Chandelier (ATR from high)</SelectItem>
                  </SelectContent>
                </Select>
              </FieldGroup>
              <FieldGroup label="Trailing Activation (R)" description="Start trailing after this R is reached">
                <div className="flex items-center gap-3">
                  <Slider value={[config.management?.trailingActivationR ?? 1.5]} onValueChange={v => updateField('management', 'trailingActivationR', v[0])} min={0.5} max={5.0} step={0.25} className="flex-1" />
                  <span className="text-[11px] font-mono w-8 text-right">{(config.management?.trailingActivationR ?? 1.5).toFixed(2)}R</span>
                </div>
              </FieldGroup>
              {config.management?.trailingMethod === "atr" && (
                <FieldGroup label="ATR Multiple" description="Trail distance as ATR multiple">
                  <div className="flex items-center gap-3">
                    <Slider value={[config.management?.trailingATRMultiple ?? 2.0]} onValueChange={v => updateField('management', 'trailingATRMultiple', v[0])} min={0.5} max={5.0} step={0.25} className="flex-1" />
                    <span className="text-[11px] font-mono w-8 text-right">{(config.management?.trailingATRMultiple ?? 2.0).toFixed(1)}×</span>
                  </div>
                </FieldGroup>
              )}
            </>
          )}
        </div>

        {/* Time-Based Exits */}
        <div className="border-t border-border pt-3 space-y-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Time-Based Exits</p>
          <ToggleField label="Max Trade Duration" description="Close trade after maximum time" checked={config.management?.maxDurationEnabled ?? false} onChange={v => updateField('management', 'maxDurationEnabled', v)} />
          {config.management?.maxDurationEnabled && (
            <FieldGroup label="Max Duration (hours)">
              <Input type="number" value={config.management?.maxDurationHours ?? 24} onChange={e => updateField('management', 'maxDurationHours', parseInt(e.target.value) || 24)} min={1} max={168} step={1} className="h-9 text-sm" />
            </FieldGroup>
          )}
          <ToggleField label="Friday Close" description="Close all positions before weekend" checked={config.management?.fridayCloseEnabled ?? true} onChange={v => updateField('management', 'fridayCloseEnabled', v)} />
          {(config.management?.fridayCloseEnabled ?? true) && (
            <FieldGroup label="Friday Close Hour (UTC)">
              <Input type="number" value={config.management?.fridayCloseHour ?? 20} onChange={e => updateField('management', 'fridayCloseHour', parseInt(e.target.value) || 20)} min={15} max={23} step={1} className="h-9 text-sm" />
            </FieldGroup>
          )}
        </div>
      </CollapsibleSection>
    </div>
  );
}

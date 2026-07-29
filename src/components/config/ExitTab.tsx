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
          <Select value={config.exit?.stopLossMethod ?? config.exit?.slMethod ?? "structure"} onValueChange={v => { updateField('exit', 'stopLossMethod', v); updateField('exit', 'slMethod', v); }}>
            <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="structure">Structure — Beyond swing point</SelectItem>
              <SelectItem value="below_ob">Below OB — Beyond order block boundary</SelectItem>
              <SelectItem value="atr_based">ATR — Fixed ATR multiple</SelectItem>
              <SelectItem value="fixed_pips">Fixed Pips</SelectItem>
            </SelectContent>
          </Select>
        </FieldGroup>
        {(config.exit?.stopLossMethod ?? config.exit?.slMethod) === "atr_based" && (
          <FieldGroup label="ATR Multiple" description="SL distance as multiple of ATR">
            <div className="flex items-center gap-4">
              <Slider value={[config.exit?.slATRMultiple ?? 1.5]} onValueChange={v => updateField('exit', 'slATRMultiple', v[0])} min={0.5} max={4.0} step={0.25} className="flex-1" />
              <span className="text-sm font-mono font-bold w-12 text-right">{(config.exit?.slATRMultiple ?? 1.5).toFixed(2)}×</span>
            </div>
          </FieldGroup>
        )}
        {(config.exit?.stopLossMethod ?? config.exit?.slMethod) === "fixed_pips" && (
          <FieldGroup label="Fixed SL (pips)">
            <Input type="number" value={config.exit?.fixedSLPips ?? 25} onChange={e => updateField('exit', 'fixedSLPips', parseFloat(e.target.value) || 25)} min={5} max={200} step={5} className="h-9 text-sm" />
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
          <Select value={config.exit?.takeProfitMethod ?? config.exit?.tpMethod ?? "rr_ratio"} onValueChange={v => { updateField('exit', 'takeProfitMethod', v); updateField('exit', 'tpMethod', v); }}>
            <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="rr_ratio">R:R Ratio — Fixed risk/reward</SelectItem>
              <SelectItem value="next_level">Next Level — Zone-to-zone TP</SelectItem>
              <SelectItem value="fib_extension">Fib Extension — From impulse swing</SelectItem>
              <SelectItem value="fib_extension_3pt">Fib Extension 3-Point — From entry</SelectItem>
              <SelectItem value="atr_multiple">ATR Multiple</SelectItem>
              <SelectItem value="structure">Structure — Next HTF level</SelectItem>
            </SelectContent>
          </Select>
        </FieldGroup>
        {(config.exit?.takeProfitMethod ?? config.exit?.tpMethod ?? "rr_ratio") === "rr_ratio" && (
          <FieldGroup label="R:R Target" description="Target reward as multiple of risk">
            <div className="flex items-center gap-4">
              <Slider value={[config.exit?.tpRRRatio ?? 2.0]} onValueChange={v => updateField('exit', 'tpRRRatio', v[0])} min={1.0} max={10.0} step={0.5} className="flex-1" />
              <span className="text-sm font-mono font-bold text-primary w-12 text-right">{(config.exit?.tpRRRatio ?? 2.0).toFixed(1)}R</span>
            </div>
          </FieldGroup>
        )}
        {(config.exit?.takeProfitMethod ?? config.exit?.tpMethod) === "fib_extension_3pt" && (
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
        {(config.exit?.takeProfitMethod ?? config.exit?.tpMethod) === "atr_multiple" && (
          <FieldGroup label="TP ATR Multiple" description="TP distance as multiple of ATR">
            <div className="flex items-center gap-4">
              <Slider value={[config.exit?.tpATRMultiple ?? 2.0]} onValueChange={v => updateField('exit', 'tpATRMultiple', v[0])} min={1.0} max={5.0} step={0.5} className="flex-1" />
              <span className="text-sm font-mono font-bold w-12 text-right">{(config.exit?.tpATRMultiple ?? 2.0).toFixed(1)}×</span>
            </div>
          </FieldGroup>
        )}
        <div className="border-t border-border pt-3 space-y-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Multi-TP (Partial Exits)</p>
          <ToggleField label="Enable Partial TP" description="Close a portion at an R-multiple target, let the rest run" checked={config.exit?.partialTP ?? config.exit?.partialTPEnabled ?? false} onChange={v => { updateField('exit', 'partialTP', v); updateField('exit', 'partialTPEnabled', v); }} />
          {(config.exit?.partialTP ?? config.exit?.partialTPEnabled) && (
            <div className="grid grid-cols-2 gap-3">
              <FieldGroup label="Close %">
                <div className="flex items-center gap-3">
                  <Slider value={[config.exit?.partialTPPercent ?? 50]} onValueChange={v => updateField('exit', 'partialTPPercent', v[0])} min={10} max={90} step={5} className="flex-1" />
                  <span className="text-[11px] font-mono w-8 text-right">{config.exit?.partialTPPercent ?? 50}%</span>
                </div>
              </FieldGroup>
              <FieldGroup label="At R-level">
                <div className="flex items-center gap-3">
                  <Slider value={[config.exit?.partialTPLevel ?? 1.0]} onValueChange={v => updateField('exit', 'partialTPLevel', v[0])} min={0.3} max={5} step={0.1} className="flex-1" />
                  <span className="text-[11px] font-mono w-8 text-right">{(config.exit?.partialTPLevel ?? 1.0).toFixed(1)}R</span>
                </div>
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
          <ToggleField label="Auto Break-Even" description="Move SL to entry after reaching target" checked={config.exit?.breakEven ?? config.exit?.breakEvenEnabled ?? false} onChange={v => { updateField('exit', 'breakEven', v); updateField('exit', 'breakEvenEnabled', v); }} />
          {(config.exit?.breakEven ?? config.exit?.breakEvenEnabled) && (
            <div className="grid grid-cols-2 gap-3">
              <FieldGroup label="Trigger (pips profit)">
                <div className="flex items-center gap-3">
                  <Slider value={[config.exit?.breakEvenTriggerPips ?? 20]} onValueChange={v => updateField('exit', 'breakEvenTriggerPips', v[0])} min={1} max={100} step={1} className="flex-1" />
                  <span className="text-[11px] font-mono w-8 text-right">{config.exit?.breakEvenTriggerPips ?? 20}p</span>
                </div>
              </FieldGroup>
              <FieldGroup label="Offset (pips)" status="active">
                <div className="flex items-center gap-3">
                  <Slider value={[config.exit?.breakEvenOffsetPips ?? 3]} onValueChange={v => updateField('exit', 'breakEvenOffsetPips', v[0])} min={0} max={20} step={1} className="flex-1" />
                  <span className="text-[11px] font-mono w-8 text-right">{config.exit?.breakEvenOffsetPips ?? 3}p</span>
                </div>
              </FieldGroup>
            </div>
          )}
        </div>

        {/* Trailing Stop */}
        <div className="border-t border-border pt-3 space-y-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Trailing Stop</p>
          <ToggleField label="Enable Trailing" description="Trail SL behind price as trade moves in profit" checked={config.exit?.trailingStop ?? config.exit?.trailingStopEnabled ?? false} onChange={v => { updateField('exit', 'trailingStop', v); updateField('exit', 'trailingStopEnabled', v); }} />
          {(config.exit?.trailingStop ?? config.exit?.trailingStopEnabled) && (
            <>
              <FieldGroup label="Trailing Distance (pips)">
                <div className="flex items-center gap-3">
                  <Slider value={[config.exit?.trailingStopPips ?? 15]} onValueChange={v => updateField('exit', 'trailingStopPips', v[0])} min={1} max={100} step={1} className="flex-1" />
                  <span className="text-[11px] font-mono w-8 text-right">{config.exit?.trailingStopPips ?? 15}p</span>
                </div>
              </FieldGroup>
              <FieldGroup label="Activation" description="When trailing begins">
                <Select value={config.exit?.trailingStopActivation ?? "after_1r"} onValueChange={v => updateField('exit', 'trailingStopActivation', v)}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="immediate">Immediate</SelectItem>
                    <SelectItem value="after_1r">After 1R profit</SelectItem>
                    <SelectItem value="after_1.5r">After 1.5R profit</SelectItem>
                    <SelectItem value="after_2r">After 2R profit</SelectItem>
                  </SelectContent>
                </Select>
              </FieldGroup>
            </>
          )}
        </div>

        {/* Structure Invalidation */}
        <div className="border-t border-border pt-3 space-y-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Structure Invalidation</p>
          <ToggleField label="Structure Invalidation" description="Tighten SL by 50% when market structure breaks against your trade (CHoCH detected)" checked={config.exit?.structureInvalidationEnabled ?? false} onChange={v => updateField('exit', 'structureInvalidationEnabled', v)} />
        </div>

        {/* Time-Based Exits */}
        <div className="border-t border-border pt-3 space-y-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Time-Based Exits</p>
          <ToggleField label="Max Trade Duration" description="Close trade after maximum time" checked={config.exit?.maxHoldEnabled ?? config.exit?.timeBasedExitEnabled ?? false} onChange={v => { updateField('exit', 'maxHoldEnabled', v); updateField('exit', 'timeBasedExitEnabled', v); if (!v) { updateField('exit', 'timeExitHours', 0); updateField('exit', 'maxHoldHours', 0); } }} />
          {(config.exit?.maxHoldEnabled ?? config.exit?.timeBasedExitEnabled) && (
            <FieldGroup label="Max Duration (hours)">
              <div className="flex items-center gap-3">
                <Slider value={[config.exit?.timeExitHours ?? config.exit?.maxHoldHours ?? 24]} onValueChange={v => { updateField('exit', 'timeExitHours', v[0]); updateField('exit', 'maxHoldHours', v[0]); }} min={1} max={168} step={1} className="flex-1" />
                <span className="text-[11px] font-mono w-8 text-right">{config.exit?.timeExitHours ?? config.exit?.maxHoldHours ?? 24}h</span>
              </div>
            </FieldGroup>
          )}
          <ToggleField label="End-of-Session Close" description="Close all positions at end of trading session" checked={config.exit?.endOfSessionClose ?? false} onChange={v => updateField('exit', 'endOfSessionClose', v)} />
        </div>
      </CollapsibleSection>
    </div>
  );
}

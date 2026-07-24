import React from "react";
import { DollarSign, AlertTriangle, Zap, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { CollapsibleSection, FieldGroup, ToggleField, ConfigTabProps } from "./ConfigShared";

export function RiskTab({ config, setConfig, updateField }: ConfigTabProps) {
  const balance = config.account?.startingBalance ?? 10000;

  return (
    <div className="space-y-3">
      {/* ── Position Sizing ── */}
      <CollapsibleSection
        id="positionSizing"
        title="Position Sizing"
        subtitle="How lot size is calculated for each trade"
        icon={<DollarSign className="h-4 w-4" />}
        badge={
          <Badge variant="outline" className="text-[9px]">
            {config.risk?.positionSizingMethod === "fixed_lot" ? "FIXED" : config.risk?.positionSizingMethod === "volatility_adjusted" ? "VOL-ADJ" : "RISK %"}
          </Badge>
        }
        defaultOpen={true}
      >
        <FieldGroup label="Starting Balance ($)" description="Configured paper-trading bankroll. Used as the base for all % calculations.">
          <Input
            type="number"
            value={balance}
            onChange={e => updateField('account', 'startingBalance', parseFloat(e.target.value) || 0)}
            step={100}
            min={0}
            className="h-9 text-sm"
          />
        </FieldGroup>

        <FieldGroup label="Sizing Method" description="How lot size is calculated for each trade">
          <Select value={config.risk?.positionSizingMethod ?? "percent_risk"} onValueChange={v => updateField('risk', 'positionSizingMethod', v)}>
            <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="percent_risk">Risk-Based (%)</SelectItem>
              <SelectItem value="fixed_lot">Fixed Lot Size</SelectItem>
              <SelectItem value="volatility_adjusted">Volatility-Adjusted (ATR)</SelectItem>
            </SelectContent>
          </Select>
        </FieldGroup>

        {(config.risk?.positionSizingMethod === "percent_risk" || !config.risk?.positionSizingMethod) && (
          <p className="text-[10px] text-muted-foreground italic">Lot size = (Balance × Risk%) ÷ SL distance. Adjusts automatically with account growth.</p>
        )}

        {config.risk?.positionSizingMethod === "fixed_lot" && (
          <FieldGroup label="Fixed Lot Size" description="Use this exact lot size for every trade regardless of SL distance">
            <Input type="number" value={config.risk?.fixedLotSize ?? 0.1} onChange={e => updateField('risk', 'fixedLotSize', parseFloat(e.target.value) || 0.01)} step={0.01} min={0.01} max={100} className="h-9 text-sm" />
          </FieldGroup>
        )}

        {config.risk?.positionSizingMethod === "volatility_adjusted" && (
          <>
            <p className="text-[10px] text-muted-foreground italic">Lot size scales inversely with ATR — smaller positions in volatile markets, larger in calm markets. Uses Risk% as the base.</p>
            <FieldGroup label={`ATR Multiplier: ${config.risk?.atrVolatilityMultiplier ?? 1.5}×`} description="ATR is multiplied by this factor to set the volatility-based risk distance. Lower = larger lots (more aggressive), higher = smaller lots (more conservative)">
              <Slider
                value={[config.risk?.atrVolatilityMultiplier ?? 1.5]}
                onValueChange={([v]) => updateField('risk', 'atrVolatilityMultiplier', Math.round(v * 10) / 10)}
                min={0.5} max={3.0} step={0.1}
                className="w-full"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
                <span>0.5× (aggressive)</span>
                <span>1.5× (default)</span>
                <span>3.0× (conservative)</span>
              </div>
            </FieldGroup>
          </>
        )}

        {(config.risk?.positionSizingMethod !== "fixed_lot") && (
          <FieldGroup label="Risk per Trade (%)" description="Percentage of balance risked per trade">
            <Input type="number" value={config.risk?.riskPerTrade ?? 1} onChange={e => updateField('risk', 'riskPerTrade', parseFloat(e.target.value) || 0)} step={0.1} className="h-9 text-sm" />
            <p className="text-[11px] text-muted-foreground mt-1 font-mono">
              ≈ ${(((config.risk?.riskPerTrade ?? 1) / 100) * balance).toLocaleString(undefined, { maximumFractionDigits: 2 })} per trade
            </p>
          </FieldGroup>
        )}

        <FieldGroup label="Standalone Size Multiplier" description="Position size multiplier for standalone entries (unified gate not passed). 1.0 = full size, 0.5 = half size.">
          <div className="flex items-center gap-2">
            <Input type="number" value={config.risk?.standaloneMultiplier ?? 0.5} onChange={e => updateField('risk', 'standaloneMultiplier', Math.max(0.1, Math.min(1.0, parseFloat(e.target.value) || 0.5)))} step={0.1} min={0.1} max={1.0} className="h-9 text-sm" />
            <span className="text-[11px] text-muted-foreground font-mono">×{(config.risk?.standaloneMultiplier ?? 0.5).toFixed(1)}</span>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1">Unified entries always use full size (×1.0)</p>
        </FieldGroup>
      </CollapsibleSection>

      {/* ── Risk Limits ── */}
      <CollapsibleSection
        id="riskLimits"
        title="Risk Limits"
        subtitle="Exposure caps, concurrent trades, portfolio heat"
        icon={<AlertTriangle className="h-4 w-4" />}
        defaultOpen={true}
      >
        <div className="grid grid-cols-2 gap-4">
          <FieldGroup label="Max Concurrent Trades" description="Maximum open positions at once">
            <Input type="number" value={config.risk?.maxConcurrentTrades ?? 5} onChange={e => updateField('risk', 'maxConcurrentTrades', parseFloat(e.target.value) || 0)} min={1} max={20} className="h-9 text-sm" />
          </FieldGroup>
          <FieldGroup label="Min R:R Ratio" description="Gate: rejects trades below this R:R">
            <Input type="number" value={config.risk?.minRR ?? 1.5} onChange={e => updateField('risk', 'minRR', parseFloat(e.target.value) || 0)} step={0.5} className="h-9 text-sm" />
          </FieldGroup>
          <FieldGroup label="Max Portfolio Heat (%)" description="Max total risk exposure across all open positions">
            <Input type="number" value={config.risk?.maxPortfolioHeat ?? 10} onChange={e => updateField('risk', 'maxPortfolioHeat', parseFloat(e.target.value) || 0)} step={1} min={1} max={100} className="h-9 text-sm" />
          </FieldGroup>
          <FieldGroup label="Max Per Symbol" description="Max open positions allowed on the same instrument">
            <Input type="number" value={config.risk?.maxPositionsPerSymbol ?? 2} onChange={e => updateField('risk', 'maxPositionsPerSymbol', parseFloat(e.target.value) || 0)} min={1} max={10} className="h-9 text-sm" />
          </FieldGroup>
        </div>
        <ToggleField label="Allow Same-Direction Stacking" description="When enabled, the bot can open multiple positions in the same direction on the same pair (e.g. two longs on GBP/USD). Still limited by Max Per Symbol." checked={config.risk?.allowSameDirectionStacking ?? false} onChange={v => updateField('risk', 'allowSameDirectionStacking', v)} />
      </CollapsibleSection>

      {/* ── Drawdown & Circuit Breakers ── */}
      <CollapsibleSection
        id="circuitBreakers"
        title="Drawdown & Circuit Breakers"
        subtitle="Daily/total drawdown limits, consecutive loss pauses"
        icon={<Zap className="h-4 w-4" />}
        defaultOpen={false}
      >
        {/* Max Daily Drawdown: dual %/$ input */}
        <FieldGroup label="Max Daily Drawdown" description="Halts new trades for the day if intraday loss exceeds this.">
          <div className="flex items-center gap-2">
            <div className="flex-1 relative">
              <Input
                type="number"
                value={config.risk?._dailyDDMode === "dollar"
                  ? (config.risk?._dailyDDDollar ?? ((config.risk?.maxDailyDrawdown ?? 3) / 100 * balance))
                  : (config.risk?.maxDailyDrawdown ?? 3)
                }
                onChange={e => {
                  const val = parseFloat(e.target.value) || 0;
                  if (config.risk?._dailyDDMode === "dollar") {
                    const pct = balance > 0 ? (val / balance) * 100 : 0;
                    updateField('risk', 'maxDailyDrawdown', Math.round(pct * 100) / 100);
                    updateField('risk', '_dailyDDDollar', val);
                  } else {
                    updateField('risk', 'maxDailyDrawdown', val);
                    updateField('risk', '_dailyDDDollar', (val / 100) * balance);
                  }
                }}
                step={config.risk?._dailyDDMode === "dollar" ? 10 : 0.5}
                min={0}
                className="h-9 text-sm pr-10"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-mono">
                {config.risk?._dailyDDMode === "dollar" ? "$" : "%"}
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-9 px-3 text-xs font-mono min-w-[44px]"
              onClick={() => {
                const currentPct = config.risk?.maxDailyDrawdown ?? 3;
                if (config.risk?._dailyDDMode === "dollar") {
                  updateField('risk', '_dailyDDMode', 'percent');
                } else {
                  updateField('risk', '_dailyDDMode', 'dollar');
                  updateField('risk', '_dailyDDDollar', (currentPct / 100) * balance);
                }
              }}
            >
              {config.risk?._dailyDDMode === "dollar" ? "%" : "$"}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1 font-mono">
            {config.risk?._dailyDDMode === "dollar"
              ? `= ${(config.risk?.maxDailyDrawdown ?? 3).toFixed(1)}% of $${balance.toLocaleString()}`
              : `≈ $${(((config.risk?.maxDailyDrawdown ?? 3) / 100) * balance).toLocaleString(undefined, { maximumFractionDigits: 2 })} of $${balance.toLocaleString()}`
            }
          </p>
        </FieldGroup>

        {/* Max Total Drawdown: dual %/$ input */}
        <FieldGroup label="Max Total Drawdown" description="Kill switch — stops all trading if drawdown from peak balance exceeds this.">
          <div className="flex items-center gap-2">
            <div className="flex-1 relative">
              <Input
                type="number"
                value={config.risk?._totalDDMode === "dollar"
                  ? (config.risk?._totalDDDollar ?? ((config.risk?.maxDrawdown ?? 15) / 100 * balance))
                  : (config.risk?.maxDrawdown ?? 15)
                }
                onChange={e => {
                  const val = parseFloat(e.target.value) || 0;
                  if (config.risk?._totalDDMode === "dollar") {
                    const pct = balance > 0 ? (val / balance) * 100 : 0;
                    updateField('risk', 'maxDrawdown', Math.round(pct * 100) / 100);
                    updateField('risk', '_totalDDDollar', val);
                  } else {
                    updateField('risk', 'maxDrawdown', val);
                    updateField('risk', '_totalDDDollar', (val / 100) * balance);
                  }
                }}
                step={config.risk?._totalDDMode === "dollar" ? 50 : 1}
                min={0}
                className="h-9 text-sm pr-10"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-mono">
                {config.risk?._totalDDMode === "dollar" ? "$" : "%"}
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-9 px-3 text-xs font-mono min-w-[44px]"
              onClick={() => {
                const currentPct = config.risk?.maxDrawdown ?? 15;
                if (config.risk?._totalDDMode === "dollar") {
                  updateField('risk', '_totalDDMode', 'percent');
                } else {
                  updateField('risk', '_totalDDMode', 'dollar');
                  updateField('risk', '_totalDDDollar', (currentPct / 100) * balance);
                }
              }}
            >
              {config.risk?._totalDDMode === "dollar" ? "%" : "$"}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1 font-mono">
            {config.risk?._totalDDMode === "dollar"
              ? `= ${(config.risk?.maxDrawdown ?? 15).toFixed(1)}% of $${balance.toLocaleString()}`
              : `≈ $${(((config.risk?.maxDrawdown ?? 15) / 100) * balance).toLocaleString(undefined, { maximumFractionDigits: 2 })} of $${balance.toLocaleString()}`
            }
          </p>
        </FieldGroup>

        {/* Conflict Counter */}
        <div className="border-t border-border pt-3 space-y-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">Conflict Counter</p>
          <p className="text-[10px] text-muted-foreground italic">When multiple factors actively oppose the trade direction, the bot raises the bar or blocks entirely.</p>
          <FieldGroup label="Threshold Raise At" description="When this many factors oppose the trade, the minimum confluence threshold is raised by 10 percentage points.">
            <div className="flex items-center gap-4">
              <Slider value={[config.risk?.conflictThresholdRaise ?? 4]} onValueChange={v => updateField('risk', 'conflictThresholdRaise', v[0])} min={2} max={8} step={1} className="flex-1" />
              <span className="text-sm font-mono font-bold w-10 text-right">{config.risk?.conflictThresholdRaise ?? 4}</span>
            </div>
          </FieldGroup>
          <FieldGroup label="Hard Block At" description="When this many factors oppose the trade, the trade is blocked entirely regardless of score.">
            <div className="flex items-center gap-4">
              <Slider value={[config.risk?.conflictBlockAt ?? 6]} onValueChange={v => updateField('risk', 'conflictBlockAt', v[0])} min={3} max={12} step={1} className="flex-1" />
              <span className="text-sm font-mono font-bold w-10 text-right">{config.risk?.conflictBlockAt ?? 6}</span>
            </div>
          </FieldGroup>
        </div>
      </CollapsibleSection>

      {/* ── Protection ── */}
      <CollapsibleSection
        id="protection"
        title="Protection"
        subtitle="Hard dollar limits, consecutive loss pauses, equity circuit breaker"
        icon={<Shield className="h-4 w-4" />}
        defaultOpen={false}
      >
        <div className="grid grid-cols-2 gap-4">
          <FieldGroup label="Max Daily Loss ($)" description="Hard dollar limit on closed-trade P&L — halts trading for the day.">
            <Input type="number" value={config.protection?.maxDailyLoss ?? 500} onChange={e => updateField('protection', 'maxDailyLoss', parseFloat(e.target.value) || 0)} className="h-9 text-sm" />
          </FieldGroup>
          <FieldGroup label="Max Consecutive Losses" description="Pause after N consecutive losing trades">
            <Input type="number" value={config.protection?.maxConsecutiveLosses ?? 3} onChange={e => updateField('protection', 'maxConsecutiveLosses', parseFloat(e.target.value) || 0)} min={1} max={10} className="h-9 text-sm" />
          </FieldGroup>
        </div>
        <FieldGroup label="Equity Circuit Breaker (%)" description="Emergency override — combined with Max Total Drawdown via Math.min (the lower value wins).">
          <div className="flex items-center gap-4">
            <Slider value={[config.protection?.circuitBreakerPct ?? 20]} onValueChange={v => updateField('protection', 'circuitBreakerPct', v[0])} min={5} max={50} step={1} className="flex-1" />
            <span className="text-sm font-mono font-bold text-destructive w-10 text-right">{config.protection?.circuitBreakerPct ?? 20}%</span>
          </div>
        </FieldGroup>
      </CollapsibleSection>
    </div>
  );
}

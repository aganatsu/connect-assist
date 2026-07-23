import { useState, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Loader2, Settings2, RotateCcw, Info, Zap } from "lucide-react";
import { paperApi } from "@/lib/api";
import { toast } from "sonner";

// ─── Types ──────────────────────────────────────────────────────────

export interface TradeOverrides {
  breakEvenEnabled?: boolean;
  breakEvenPips?: number;
  breakEvenOffsetPips?: number;
  trailingStopEnabled?: boolean;
  trailingStopPips?: number;
  trailingStopActivation?: string;
  partialTPEnabled?: boolean;
  partialTPPercent?: number;
  partialTPLevel?: number;
  maxHoldEnabled?: boolean;
  maxHoldHours?: number;
}

export interface EffectiveConfig {
  breakEvenEnabled: boolean;
  breakEvenPips: number;
  breakEvenOffsetPips: number;
  trailingStopEnabled: boolean;
  trailingStopPips: number;
  trailingStopActivation: string;
  partialTPEnabled: boolean;
  partialTPPercent: number;
  partialTPLevel: number;
  maxHoldEnabled: boolean;
  maxHoldHours: number;
}

interface TradeOverrideEditorProps {
  position: any;
  onSaved: () => void;
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Fallback defaults when effectiveConfig is not available from API (pre-deploy) */
const HARDCODED_DEFAULTS: EffectiveConfig = {
  breakEvenEnabled: false,
  breakEvenPips: 20,
  breakEvenOffsetPips: 0,
  trailingStopEnabled: false,
  trailingStopPips: 15,
  trailingStopActivation: "after_1r",
  partialTPEnabled: false,
  partialTPPercent: 50,
  partialTPLevel: 1.5,
  maxHoldEnabled: false,
  maxHoldHours: 48,
};

function getEffectiveConfig(position: any): EffectiveConfig {
  // Prefer the resolved effectiveConfig from the API (the single source of truth)
  if (position.effectiveConfig && typeof position.effectiveConfig === "object") {
    return { ...HARDCODED_DEFAULTS, ...position.effectiveConfig };
  }
  // Fallback for pre-deploy: try to parse from signalReason exitFlags
  try {
    const sr = JSON.parse(position.signalReason || "{}");
    const ef = sr.exitFlags || {};
    return {
      breakEvenEnabled: ef.breakEvenEnabled ?? ef.breakEven ?? false,
      breakEvenPips: ef.breakEvenPips ?? 20,
      breakEvenOffsetPips: ef.breakEvenOffsetPips ?? 0,
      trailingStopEnabled: ef.trailingStopEnabled ?? ef.trailingStop ?? false,
      trailingStopPips: ef.trailingStopPips ?? 15,
      trailingStopActivation: ef.trailingStopActivation ?? "after_1r",
      partialTPEnabled: ef.partialTPEnabled ?? ef.partialTP ?? false,
      partialTPPercent: ef.partialTPPercent ?? 50,
      partialTPLevel: ef.partialTPLevel ?? 1.5,
      maxHoldEnabled: ef.maxHoldEnabled !== false && (ef.maxHoldHours ?? 0) > 0,
      maxHoldHours: ef.maxHoldHours ?? 48,
    };
  } catch {
    return HARDCODED_DEFAULTS;
  }
}

function getTradeOverrides(position: any): TradeOverrides | null {
  // Prefer the parsed tradeOverrides from the API
  if (position.tradeOverrides && typeof position.tradeOverrides === "object") {
    return Object.keys(position.tradeOverrides).length > 0 ? position.tradeOverrides : null;
  }
  // Fallback for pre-deploy: try to parse from raw field
  const raw = position.trade_overrides;
  if (!raw) return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Object.keys(parsed).length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

const ACTIVATION_OPTIONS = [
  { value: "immediate", label: "Immediate (0R)" },
  { value: "after_0.5r", label: "After 0.5R" },
  { value: "after_1r", label: "After 1R" },
  { value: "after_1.5r", label: "After 1.5R" },
  { value: "after_2r", label: "After 2R" },
];

// ─── Override Badge (for position table row) ────────────────────────

export function OverrideBadge({ position }: { position: any }) {
  const overrides = getTradeOverrides(position);
  if (!overrides) return null;

  const count = Object.keys(overrides).length;
  const labels: string[] = [];
  if (overrides.breakEvenEnabled !== undefined) labels.push(overrides.breakEvenEnabled ? "BE on" : "BE off");
  if (overrides.trailingStopEnabled !== undefined) labels.push(overrides.trailingStopEnabled ? "Trail on" : "Trail off");
  if (overrides.trailingStopPips !== undefined) labels.push(`Trail ${overrides.trailingStopPips}p`);
  if (overrides.partialTPEnabled !== undefined) labels.push(overrides.partialTPEnabled ? "PTP on" : "PTP off");
  if (overrides.maxHoldEnabled !== undefined) labels.push(overrides.maxHoldEnabled ? "Hold on" : "Hold off");

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-badge-info border border-violet-500/40 text-tier3 cursor-help">
            <Settings2 className="h-2.5 w-2.5" />
            {count}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[200px]">
          <p className="text-xs font-medium mb-1">Custom Overrides Active</p>
          <p className="text-[10px] text-muted-foreground">{labels.join(" · ") || `${count} field(s) overridden`}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ─── Section Card ───────────────────────────────────────────────────

function SectionCard({
  title,
  icon,
  enabled,
  onToggle,
  borderColor,
  children,
  isOverridden,
}: {
  title: string;
  icon: React.ReactNode;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  borderColor: string;
  children: React.ReactNode;
  isOverridden: boolean;
}) {
  return (
    <div className={`rounded-lg border-l-[3px] ${borderColor} bg-secondary/30 px-3 py-2.5 space-y-2`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-[11px] font-bold text-foreground/80 uppercase tracking-wider">{title}</span>
          {isOverridden && (
            <span className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-badge-info text-tier3">
              CUSTOM
            </span>
          )}
        </div>
        <Switch checked={enabled} onCheckedChange={onToggle} className="scale-75" />
      </div>
      {enabled && <div className="space-y-2">{children}</div>}
    </div>
  );
}

// ─── Field Row ──────────────────────────────────────────────────────

function FieldRow({
  label,
  tooltip,
  children,
}: {
  label: string;
  tooltip?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-1.5 min-w-0">
        <Label className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium whitespace-nowrap">
          {label}
        </Label>
        {tooltip && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3 w-3 text-muted-foreground/50 cursor-help flex-shrink-0" />
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[220px]">
                <p className="text-[10px]">{tooltip}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export function TradeOverrideEditor({ position, onSaved }: TradeOverrideEditorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Read from API-resolved data (single source of truth)
  const [effectiveCfg, setEffectiveCfg] = useState<EffectiveConfig>(() => getEffectiveConfig(position));
  const [overrides, setOverrides] = useState<TradeOverrides | null>(() => getTradeOverrides(position));

  // Local editing state — initialized from effective config
  const [beEnabled, setBeEnabled] = useState(effectiveCfg.breakEvenEnabled);
  const [bePips, setBePips] = useState(String(effectiveCfg.breakEvenPips));
  const [trailEnabled, setTrailEnabled] = useState(effectiveCfg.trailingStopEnabled);
  const [trailPips, setTrailPips] = useState(String(effectiveCfg.trailingStopPips));
  const [trailActivation, setTrailActivation] = useState(effectiveCfg.trailingStopActivation);
  const [ptpEnabled, setPtpEnabled] = useState(effectiveCfg.partialTPEnabled);
  const [ptpPercent, setPtpPercent] = useState(String(effectiveCfg.partialTPPercent));
  const [ptpLevel, setPtpLevel] = useState(String(effectiveCfg.partialTPLevel));
  const [holdEnabled, setHoldEnabled] = useState(effectiveCfg.maxHoldEnabled);
  const [holdHours, setHoldHours] = useState(String(effectiveCfg.maxHoldHours));

  // Sync from position prop ONLY when effectiveConfig/tradeOverrides actually change
  useEffect(() => {
    const newCfg = getEffectiveConfig(position);
    const newOv = getTradeOverrides(position);
    setEffectiveCfg(newCfg);
    setOverrides(newOv);
    // Reset local state to match the new effective config
    setBeEnabled(newCfg.breakEvenEnabled);
    setBePips(String(newCfg.breakEvenPips));
    setTrailEnabled(newCfg.trailingStopEnabled);
    setTrailPips(String(newCfg.trailingStopPips));
    setTrailActivation(newCfg.trailingStopActivation);
    setPtpEnabled(newCfg.partialTPEnabled);
    setPtpPercent(String(newCfg.partialTPPercent));
    setPtpLevel(String(newCfg.partialTPLevel));
    setHoldEnabled(newCfg.maxHoldEnabled);
    setHoldHours(String(newCfg.maxHoldHours));
  }, [position.effectiveConfig, position.tradeOverrides]);

  // Build the overrides payload — always send the full set of values the user sees
  // This ensures what's displayed = what's saved = what the scanner uses
  const buildPayload = (): TradeOverrides => {
    return {
      breakEvenEnabled: beEnabled,
      breakEvenPips: parseFloat(bePips) || 20,
      trailingStopEnabled: trailEnabled,
      trailingStopPips: parseFloat(trailPips) || 15,
      trailingStopActivation: trailActivation,
      partialTPEnabled: ptpEnabled,
      partialTPPercent: parseFloat(ptpPercent) || 50,
      partialTPLevel: parseFloat(ptpLevel) || 1.5,
      maxHoldEnabled: holdEnabled,
      maxHoldHours: parseFloat(holdHours) || 48,
    };
  };

  // Check if any field differs from the current effective config
  const hasChanges = useMemo(() => {
    const cfg = effectiveCfg;
    if (beEnabled !== cfg.breakEvenEnabled) return true;
    if (beEnabled && parseFloat(bePips) !== cfg.breakEvenPips) return true;
    if (trailEnabled !== cfg.trailingStopEnabled) return true;
    if (trailEnabled && parseFloat(trailPips) !== cfg.trailingStopPips) return true;
    if (trailEnabled && trailActivation !== cfg.trailingStopActivation) return true;
    if (ptpEnabled !== cfg.partialTPEnabled) return true;
    if (ptpEnabled && parseFloat(ptpPercent) !== cfg.partialTPPercent) return true;
    if (ptpEnabled && parseFloat(ptpLevel) !== cfg.partialTPLevel) return true;
    if (holdEnabled !== cfg.maxHoldEnabled) return true;
    if (holdEnabled && parseFloat(holdHours) !== cfg.maxHoldHours) return true;
    return false;
  }, [beEnabled, bePips, trailEnabled, trailPips, trailActivation, ptpEnabled, ptpPercent, ptpLevel, holdEnabled, holdHours, effectiveCfg]);

  const hasActiveOverrides = overrides !== null;

  // Check which sections have overrides
  const beOverridden = overrides?.breakEvenEnabled !== undefined || overrides?.breakEvenPips !== undefined;
  const trailOverridden = overrides?.trailingStopEnabled !== undefined || overrides?.trailingStopPips !== undefined || overrides?.trailingStopActivation !== undefined;
  const ptpOverridden = overrides?.partialTPEnabled !== undefined || overrides?.partialTPPercent !== undefined || overrides?.partialTPLevel !== undefined;
  const holdOverridden = overrides?.maxHoldEnabled !== undefined || overrides?.maxHoldHours !== undefined;

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = buildPayload();
      const response = await paperApi.updatePosition(position.id, { tradeOverrides: payload });
      // Use the response to update local state immediately — no flicker
      if (response?.effectiveConfig) {
        const newCfg = { ...HARDCODED_DEFAULTS, ...response.effectiveConfig };
        setEffectiveCfg(newCfg);
        setOverrides(response.tradeOverrides || payload);
        // Sync local editing state to match what was just saved
        setBeEnabled(newCfg.breakEvenEnabled);
        setBePips(String(newCfg.breakEvenPips));
        setTrailEnabled(newCfg.trailingStopEnabled);
        setTrailPips(String(newCfg.trailingStopPips));
        setTrailActivation(newCfg.trailingStopActivation);
        setPtpEnabled(newCfg.partialTPEnabled);
        setPtpPercent(String(newCfg.partialTPPercent));
        setPtpLevel(String(newCfg.partialTPLevel));
        setHoldEnabled(newCfg.maxHoldEnabled);
        setHoldHours(String(newCfg.maxHoldHours));
      }
      toast.success("Trade overrides saved — takes effect next scan cycle");
      onSaved(); // Still trigger parent refresh for other data (PnL, prices)
    } catch (e: any) {
      toast.error(e?.message || "Failed to save overrides");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setResetting(true);
    try {
      const response = await paperApi.updatePosition(position.id, { tradeOverrides: null });
      // Use response to update state immediately
      if (response?.effectiveConfig) {
        const newCfg = { ...HARDCODED_DEFAULTS, ...response.effectiveConfig };
        setEffectiveCfg(newCfg);
        setOverrides(null);
        setBeEnabled(newCfg.breakEvenEnabled);
        setBePips(String(newCfg.breakEvenPips));
        setTrailEnabled(newCfg.trailingStopEnabled);
        setTrailPips(String(newCfg.trailingStopPips));
        setTrailActivation(newCfg.trailingStopActivation);
        setPtpEnabled(newCfg.partialTPEnabled);
        setPtpPercent(String(newCfg.partialTPPercent));
        setPtpLevel(String(newCfg.partialTPLevel));
        setHoldEnabled(newCfg.maxHoldEnabled);
        setHoldHours(String(newCfg.maxHoldHours));
      }
      toast.success("Overrides cleared — using global config");
      onSaved();
      setIsOpen(false);
    } catch (e: any) {
      toast.error(e?.message || "Failed to reset overrides");
    } finally {
      setResetting(false);
    }
  };

  if (!isOpen) {
    return (
      <div className="flex items-center gap-2 pt-2 border-t border-border/30">
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs gap-1.5 border-violet-500/40 text-tier3 hover:bg-violet-500/10 hover:text-tier3"
          onClick={() => setIsOpen(true)}
        >
          <Settings2 className="h-3.5 w-3.5" />
          Trade Management Overrides
          {hasActiveOverrides && (
            <span className="ml-1 px-1.5 py-0.5 rounded bg-badge-info text-[9px] font-bold">
              {Object.keys(overrides!).length} active
            </span>
          )}
        </Button>
        {hasActiveOverrides && (
          <span className="text-[10px] text-tier3/70 italic">
            Custom settings override global config for this trade
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="pt-2 border-t border-violet-500/30 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-tier3" />
          <span className="text-xs font-bold text-tier3 uppercase tracking-wider">
            Per-Trade Management Overrides
          </span>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground/50 cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[280px]">
                <p className="text-[10px]">
                  These are the <strong>effective values</strong> the scanner will use for this trade.
                  Fields marked CUSTOM override your global config. Changes take effect on the next scan cycle (~15 min).
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-[10px] text-muted-foreground"
          onClick={() => setIsOpen(false)}
        >
          Collapse
        </Button>
      </div>

      {/* Override Sections — 2x2 grid on desktop, stacked on mobile */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {/* Break Even */}
        <SectionCard
          title="Break Even"
          icon={<span className="text-highlight text-sm">⚖</span>}
          enabled={beEnabled}
          onToggle={setBeEnabled}
          borderColor="border-l-yellow-500"
          isOverridden={beOverridden}
        >
          <FieldRow label="Trigger (pips)" tooltip="Move SL to entry after price moves this many pips in profit">
            <Input
              type="number"
              step="1"
              min="1"
              value={bePips}
              onChange={(e) => setBePips(e.target.value)}
              className="h-7 w-20 text-xs font-mono px-2 text-right"
            />
          </FieldRow>
        </SectionCard>

        {/* Trailing Stop */}
        <SectionCard
          title="Trailing Stop"
          icon={<span className="text-profit text-sm">↗</span>}
          enabled={trailEnabled}
          onToggle={setTrailEnabled}
          borderColor="border-l-emerald-500"
          isOverridden={trailOverridden}
        >
          <FieldRow label="Trail Distance (pips)" tooltip="SL trails this many pips behind the best price">
            <Input
              type="number"
              step="1"
              min="1"
              value={trailPips}
              onChange={(e) => setTrailPips(e.target.value)}
              className="h-7 w-20 text-xs font-mono px-2 text-right"
            />
          </FieldRow>
          <FieldRow label="Activation" tooltip="Trailing starts after price reaches this R-multiple">
            <Select value={trailActivation} onValueChange={setTrailActivation}>
              <SelectTrigger className="h-7 w-28 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACTIVATION_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value} className="text-xs">
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
        </SectionCard>

        {/* Partial TP */}
        <SectionCard
          title="Partial Take Profit"
          icon={<span className="text-cyan-400 text-sm">💰</span>}
          enabled={ptpEnabled}
          onToggle={setPtpEnabled}
          borderColor="border-l-cyan-500"
          isOverridden={ptpOverridden}
        >
          <FieldRow label="Close %" tooltip="Percentage of position to close at partial TP level">
            <Input
              type="number"
              step="5"
              min="10"
              max="90"
              value={ptpPercent}
              onChange={(e) => setPtpPercent(e.target.value)}
              className="h-7 w-20 text-xs font-mono px-2 text-right"
            />
          </FieldRow>
          <FieldRow label="At R-level" tooltip="Close partial at this R-multiple (e.g., 1.5 = 1.5× risk)">
            <Input
              type="number"
              step="0.1"
              min="0.5"
              max="5"
              value={ptpLevel}
              onChange={(e) => setPtpLevel(e.target.value)}
              className="h-7 w-20 text-xs font-mono px-2 text-right"
            />
          </FieldRow>
        </SectionCard>

        {/* Max Hold Time */}
        <SectionCard
          title="Max Hold Time"
          icon={<span className="text-warn text-sm">⏳</span>}
          enabled={holdEnabled}
          onToggle={setHoldEnabled}
          borderColor="border-l-orange-500"
          isOverridden={holdOverridden}
        >
          <FieldRow label="Hours" tooltip="Auto-close position after this many hours">
            <Input
              type="number"
              step="1"
              min="1"
              max="168"
              value={holdHours}
              onChange={(e) => setHoldHours(e.target.value)}
              className="h-7 w-20 text-xs font-mono px-2 text-right"
            />
          </FieldRow>
        </SectionCard>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center justify-between pt-1">
        <div className="flex items-center gap-2">
          {hasActiveOverrides && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10"
              onClick={handleReset}
              disabled={resetting || saving}
            >
              {resetting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
              Reset to Global Config
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            onClick={() => setIsOpen(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-8 px-5 text-xs gap-1.5 bg-violet-600 hover:bg-violet-700 text-white"
            disabled={!hasChanges || saving}
            onClick={handleSave}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
            Save Overrides
          </Button>
        </div>
      </div>

      {/* Info footer */}
      <p className="text-[10px] text-muted-foreground/60 italic">
        Showing effective values (global config + your overrides). Changes take effect on the next bot scan cycle (~15 min).
      </p>
    </div>
  );
}

export default TradeOverrideEditor;

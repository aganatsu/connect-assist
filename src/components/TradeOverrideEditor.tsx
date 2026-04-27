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
  trailingStopEnabled?: boolean;
  trailingStopPips?: number;
  trailingStopActivation?: string;
  partialTPEnabled?: boolean;
  partialTPPercent?: number;
  partialTPLevel?: number;
  maxHoldEnabled?: boolean;
  maxHoldHours?: number;
}

interface TradeOverrideEditorProps {
  position: any;
  onSaved: () => void;
}

// ─── Helpers ────────────────────────────────────────────────────────

function parseOverrides(position: any): TradeOverrides | null {
  if (!position.trade_overrides && !position.tradeOverrides) return null;
  const raw = position.trade_overrides || position.tradeOverrides;
  if (!raw) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

function getGlobalDefaults(position: any): TradeOverrides {
  // Extract from signalReason exitFlags (what the bot originally set)
  let ef: any = {};
  try {
    const sr = JSON.parse(position.signalReason || "{}");
    ef = sr.exitFlags || {};
  } catch { /* ignore */ }

  return {
    breakEvenEnabled: ef.breakEvenEnabled ?? ef.breakEven ?? false,
    breakEvenPips: ef.breakEvenPips ?? 20,
    trailingStopEnabled: ef.trailingStopEnabled ?? ef.trailingStop ?? false,
    trailingStopPips: ef.trailingStopPips ?? 15,
    trailingStopActivation: ef.trailingStopActivation ?? "after_1r",
    partialTPEnabled: ef.partialTPEnabled ?? ef.partialTP ?? false,
    partialTPPercent: ef.partialTPPercent ?? 50,
    partialTPLevel: ef.partialTPLevel ?? 1.5,
    maxHoldEnabled: ef.maxHoldEnabled !== false && (ef.maxHoldHours ?? 0) > 0,
    maxHoldHours: ef.maxHoldHours ?? 48,
  };
}

const ACTIVATION_OPTIONS = [
  { value: "after_0.5r", label: "After 0.5R" },
  { value: "after_1r", label: "After 1R" },
  { value: "after_1.5r", label: "After 1.5R" },
  { value: "after_2r", label: "After 2R" },
];

// ─── Override Badge (for position table row) ────────────────────────

export function OverrideBadge({ position }: { position: any }) {
  const overrides = parseOverrides(position);
  if (!overrides || Object.keys(overrides).length === 0) return null;

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
          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-500/15 border border-violet-500/40 text-violet-400 cursor-help">
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
            <span className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-400">
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

  const existing = useMemo(() => parseOverrides(position), [position]);
  const defaults = useMemo(() => getGlobalDefaults(position), [position]);

  // Local state — initialized from overrides (if any) or global defaults
  const [beEnabled, setBeEnabled] = useState(existing?.breakEvenEnabled ?? defaults.breakEvenEnabled ?? false);
  const [bePips, setBePips] = useState(String(existing?.breakEvenPips ?? defaults.breakEvenPips ?? 20));
  const [trailEnabled, setTrailEnabled] = useState(existing?.trailingStopEnabled ?? defaults.trailingStopEnabled ?? false);
  const [trailPips, setTrailPips] = useState(String(existing?.trailingStopPips ?? defaults.trailingStopPips ?? 15));
  const [trailActivation, setTrailActivation] = useState(existing?.trailingStopActivation ?? defaults.trailingStopActivation ?? "after_1r");
  const [ptpEnabled, setPtpEnabled] = useState(existing?.partialTPEnabled ?? defaults.partialTPEnabled ?? false);
  const [ptpPercent, setPtpPercent] = useState(String(existing?.partialTPPercent ?? defaults.partialTPPercent ?? 50));
  const [ptpLevel, setPtpLevel] = useState(String(existing?.partialTPLevel ?? defaults.partialTPLevel ?? 1.5));
  const [holdEnabled, setHoldEnabled] = useState(existing?.maxHoldEnabled ?? defaults.maxHoldEnabled ?? false);
  const [holdHours, setHoldHours] = useState(String(existing?.maxHoldHours ?? defaults.maxHoldHours ?? 48));

  // Reset local state when position changes
  useEffect(() => {
    const ov = parseOverrides(position);
    const def = getGlobalDefaults(position);
    setBeEnabled(ov?.breakEvenEnabled ?? def.breakEvenEnabled ?? false);
    setBePips(String(ov?.breakEvenPips ?? def.breakEvenPips ?? 20));
    setTrailEnabled(ov?.trailingStopEnabled ?? def.trailingStopEnabled ?? false);
    setTrailPips(String(ov?.trailingStopPips ?? def.trailingStopPips ?? 15));
    setTrailActivation(ov?.trailingStopActivation ?? def.trailingStopActivation ?? "after_1r");
    setPtpEnabled(ov?.partialTPEnabled ?? def.partialTPEnabled ?? false);
    setPtpPercent(String(ov?.partialTPPercent ?? def.partialTPPercent ?? 50));
    setPtpLevel(String(ov?.partialTPLevel ?? def.partialTPLevel ?? 1.5));
    setHoldEnabled(ov?.maxHoldEnabled ?? def.maxHoldEnabled ?? false);
    setHoldHours(String(ov?.maxHoldHours ?? def.maxHoldHours ?? 48));
  }, [position]);

  // Build the overrides payload — only include fields that differ from global defaults
  const buildPayload = (): TradeOverrides => {
    const overrides: TradeOverrides = {};

    if (beEnabled !== defaults.breakEvenEnabled) overrides.breakEvenEnabled = beEnabled;
    if (beEnabled) {
      const pips = parseFloat(bePips);
      if (!isNaN(pips) && pips !== defaults.breakEvenPips) overrides.breakEvenPips = pips;
      // If enabling BE but it was disabled globally, always include pips
      if (beEnabled !== defaults.breakEvenEnabled) overrides.breakEvenPips = isNaN(pips) ? (defaults.breakEvenPips ?? 20) : pips;
    }

    if (trailEnabled !== defaults.trailingStopEnabled) overrides.trailingStopEnabled = trailEnabled;
    if (trailEnabled) {
      const pips = parseFloat(trailPips);
      if (!isNaN(pips) && pips !== defaults.trailingStopPips) overrides.trailingStopPips = pips;
      if (trailActivation !== defaults.trailingStopActivation) overrides.trailingStopActivation = trailActivation;
      // If enabling trail but it was disabled globally, always include pips + activation
      if (trailEnabled !== defaults.trailingStopEnabled) {
        overrides.trailingStopPips = isNaN(pips) ? (defaults.trailingStopPips ?? 15) : pips;
        overrides.trailingStopActivation = trailActivation;
      }
    }

    if (ptpEnabled !== defaults.partialTPEnabled) overrides.partialTPEnabled = ptpEnabled;
    if (ptpEnabled) {
      const pct = parseFloat(ptpPercent);
      const lvl = parseFloat(ptpLevel);
      if (!isNaN(pct) && pct !== defaults.partialTPPercent) overrides.partialTPPercent = pct;
      if (!isNaN(lvl) && lvl !== defaults.partialTPLevel) overrides.partialTPLevel = lvl;
      if (ptpEnabled !== defaults.partialTPEnabled) {
        overrides.partialTPPercent = isNaN(pct) ? (defaults.partialTPPercent ?? 50) : pct;
        overrides.partialTPLevel = isNaN(lvl) ? (defaults.partialTPLevel ?? 1.5) : lvl;
      }
    }

    if (holdEnabled !== defaults.maxHoldEnabled) overrides.maxHoldEnabled = holdEnabled;
    if (holdEnabled) {
      const hrs = parseFloat(holdHours);
      if (!isNaN(hrs) && hrs !== defaults.maxHoldHours) overrides.maxHoldHours = hrs;
      if (holdEnabled !== defaults.maxHoldEnabled) {
        overrides.maxHoldHours = isNaN(hrs) ? (defaults.maxHoldHours ?? 48) : hrs;
      }
    }

    return overrides;
  };

  // Check if any field differs from what's currently saved
  const hasChanges = useMemo(() => {
    const payload = buildPayload();
    // Compare with existing overrides
    if (!existing && Object.keys(payload).length === 0) return false;
    if (!existing && Object.keys(payload).length > 0) return true;
    if (existing && Object.keys(payload).length === 0) return true; // clearing overrides
    return JSON.stringify(payload) !== JSON.stringify(existing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beEnabled, bePips, trailEnabled, trailPips, trailActivation, ptpEnabled, ptpPercent, ptpLevel, holdEnabled, holdHours, existing, defaults]);

  const hasActiveOverrides = existing && Object.keys(existing).length > 0;

  // Check which sections have overrides
  const beOverridden = existing?.breakEvenEnabled !== undefined || existing?.breakEvenPips !== undefined;
  const trailOverridden = existing?.trailingStopEnabled !== undefined || existing?.trailingStopPips !== undefined || existing?.trailingStopActivation !== undefined;
  const ptpOverridden = existing?.partialTPEnabled !== undefined || existing?.partialTPPercent !== undefined || existing?.partialTPLevel !== undefined;
  const holdOverridden = existing?.maxHoldEnabled !== undefined || existing?.maxHoldHours !== undefined;

  const handleSave = async () => {
    setSaving(true);
    try {
      const overrides = buildPayload();
      // If no overrides differ from defaults, send null to clear
      const payload = Object.keys(overrides).length === 0 ? null : overrides;
      await paperApi.updatePosition(position.id, { tradeOverrides: payload });
      toast.success(payload ? "Trade overrides saved — takes effect next scan cycle" : "Overrides cleared — using global config");
      onSaved();
      if (!payload) setIsOpen(false);
    } catch (e: any) {
      toast.error(e?.message || "Failed to save overrides");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setResetting(true);
    try {
      await paperApi.updatePosition(position.id, { tradeOverrides: null });
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
          className="h-8 text-xs gap-1.5 border-violet-500/40 text-violet-400 hover:bg-violet-500/10 hover:text-violet-300"
          onClick={() => setIsOpen(true)}
        >
          <Settings2 className="h-3.5 w-3.5" />
          Trade Management Overrides
          {hasActiveOverrides && (
            <span className="ml-1 px-1.5 py-0.5 rounded bg-violet-500/20 text-[9px] font-bold">
              {Object.keys(existing!).length} active
            </span>
          )}
        </Button>
        {hasActiveOverrides && (
          <span className="text-[10px] text-violet-400/70 italic">
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
          <Settings2 className="h-4 w-4 text-violet-400" />
          <span className="text-xs font-bold text-violet-400 uppercase tracking-wider">
            Per-Trade Management Overrides
          </span>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground/50 cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[280px]">
                <p className="text-[10px]">
                  Override the global bot config for this specific trade. Changes take effect on the next scan cycle (~15 min).
                  Fields not overridden will continue using the global config.
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
          icon={<span className="text-yellow-400 text-sm">⚖</span>}
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
          icon={<span className="text-emerald-400 text-sm">↗</span>}
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
          icon={<span className="text-orange-400 text-sm">⏳</span>}
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
        Changes take effect on the next bot scan cycle (~15 min). Only overridden fields are saved — everything else uses your global bot config.
      </p>
    </div>
  );
}

export default TradeOverrideEditor;

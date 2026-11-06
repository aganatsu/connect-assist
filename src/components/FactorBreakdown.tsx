import { useState } from "react";
import { ChevronDown } from "lucide-react";

/**
 * The confluence factors the scanner recorded for a setup: which were present, with their detail.
 * A plain list — the tiers and the score they summed to were removed, so nothing here is weighted.
 */

export interface FactorItem {
  name: string;
  present: boolean;
  weight?: number;
  detail?: string;
  group?: string;
}

// Display name overrides — clarify what each factor checks without changing the underlying key
const DISPLAY_NAME_MAP: Record<string, string> = {
  "Fair Value Gap": "Fair Value Gap (Entry TF)",
};
const displayName = (name: string) => DISPLAY_NAME_MAP[name] || name;

// Regime and spread are checks, not evidence for the setup: listed apart.
const INFO_ONLY = new Set(["Regime Alignment", "Spread Quality"]);

function FactorRow({ f, muted }: { f: FactorItem; muted?: boolean }) {
  return (
    <div className="flex items-start gap-1 text-[9px]">
      <span className={`mt-0.5 ${f.present ? "text-success" : "text-muted-foreground/50"}`}>{f.present ? "✓" : "✗"}</span>
      <div className="flex-1 min-w-0">
        <span className={f.present && !muted ? "text-foreground" : "text-muted-foreground/60"}>{displayName(f.name)}</span>
        {f.detail && <span className="text-muted-foreground ml-1">— {f.detail}</span>}
      </div>
    </div>
  );
}

export function FactorBreakdown({ factors, compact = false }: { factors: FactorItem[]; compact?: boolean }) {
  const [showAbsent, setShowAbsent] = useState(!compact);
  const isDisabled = (f: FactorItem) => f.weight === 0 || (typeof f.detail === "string" && /disabled/i.test(f.detail));
  const enabled = factors.filter(f => !isDisabled(f) && !INFO_ONLY.has(f.name));
  const info = factors.filter(f => !isDisabled(f) && INFO_ONLY.has(f.name));
  const disabled = factors.filter(isDisabled);
  const present = enabled.filter(f => f.present);
  const absent = enabled.filter(f => !f.present).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="space-y-1.5">
      <div className="border border-border/50 rounded-md px-2 py-1.5 space-y-0.5">
        <p className="text-[8px] text-muted-foreground uppercase tracking-wider font-bold">
          Factors present <span className="font-mono normal-case">({present.length}/{enabled.length})</span>
        </p>
        {present.length === 0 && <p className="text-[9px] text-muted-foreground/60">none</p>}
        {present.map((f, i) => <FactorRow key={`p-${i}`} f={f} />)}
        {absent.length > 0 && (
          <button type="button" onClick={() => setShowAbsent(!showAbsent)} className="flex items-center gap-1 text-[8px] text-muted-foreground hover:text-foreground pt-0.5">
            <ChevronDown className={`h-2.5 w-2.5 transition-transform ${showAbsent ? "" : "-rotate-90"}`} />
            {absent.length} absent
          </button>
        )}
        {showAbsent && absent.map((f, i) => <FactorRow key={`a-${i}`} f={f} />)}
      </div>

      {info.length > 0 && (
        <div className="space-y-0.5">
          <p className="text-[8px] text-muted-foreground uppercase tracking-wider">Checks</p>
          {info.map((f, i) => (
            <div key={i} className="flex items-start gap-1 text-[9px]">
              <span className={`mt-0.5 ${f.present ? "text-warning" : "text-success"}`}>{f.present ? "⚠" : "✓"}</span>
              <div>
                <span className="text-muted-foreground">{displayName(f.name)}</span>
                {f.detail && <span className="text-muted-foreground/70 ml-1">— {f.detail}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {disabled.length > 0 && (
        <div>
          <div className="border-t border-dashed border-border/50 mb-1.5" />
          <p className="text-[8px] uppercase tracking-wider text-muted-foreground/60 font-medium">Disabled ({disabled.length})</p>
          <div className="flex flex-wrap gap-1 mt-0.5">
            {disabled.map((f, i) => (
              <span key={`dis-${i}`} className="inline-flex items-center gap-1 rounded-full border border-border/30 px-1.5 py-0.5 text-[9px] font-mono opacity-50" title={`${f.name} — disabled`}>
                <span className="text-muted-foreground/60">—</span>
                <span className="truncate max-w-[120px] line-through text-muted-foreground/70">{displayName(f.name)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default FactorBreakdown;

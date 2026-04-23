import React, { useState } from "react";
import { ChevronDown, Info, ShieldCheck, ShieldX } from "lucide-react";

// ─── Types ──────────────────────────────────────────────────────────

export interface FactorItem {
  name: string;
  present: boolean;
  weight: number;
  detail?: string;
  group?: string;
  tier?: number; // 1, 2, or 3 — set by backend
}

export interface TieredScoringMeta {
  tier1Count: number;
  tier1Max: number;
  tier2Count: number;
  tier2Max: number;
  tier3Count: number;
  tier3Max: number;
  tieredScore: number;
  tieredMax: number;
  tier1GatePassed: boolean;
  tier1GateReason: string;
  regimeGatePassed: boolean;
  regimeGateReason: string;
  spreadGatePassed: boolean;
  spreadGateReason: string;
}

interface TierFactorBreakdownProps {
  factors: FactorItem[];
  tieredScoring?: TieredScoringMeta | null;
  /** If true, show a more compact layout (used in collapsed scan cards) */
  compact?: boolean;
}

// ─── Tier metadata ──────────────────────────────────────────────────

const TIER_CONFIG: Record<number, { label: string; sublabel: string; color: string; bgColor: string; borderColor: string; pointLabel: string }> = {
  1: {
    label: "TIER 1",
    sublabel: "Core Setup",
    color: "text-amber-400",
    bgColor: "bg-amber-400/10",
    borderColor: "border-amber-400/30",
    pointLabel: "2 pts each",
  },
  2: {
    label: "TIER 2",
    sublabel: "Confirmation",
    color: "text-sky-400",
    bgColor: "bg-sky-400/10",
    borderColor: "border-sky-400/30",
    pointLabel: "1 pt each",
  },
  3: {
    label: "TIER 3",
    sublabel: "Bonus",
    color: "text-violet-400",
    bgColor: "bg-violet-400/10",
    borderColor: "border-violet-400/30",
    pointLabel: "0.5 pts each",
  },
};

// Classify factors by tier, falling back to name-based classification if tier field is missing
const TIER_1_NAMES = new Set(["Market Structure", "Order Block", "Fair Value Gap", "Premium/Discount"]);
const TIER_2_NAMES = new Set(["PD/PW Levels", "Liquidity Sweep", "Displacement", "Reversal Candle", "Session Quality"]);

function classifyTier(f: FactorItem): number {
  if (f.tier && [1, 2, 3].includes(f.tier)) return f.tier;
  if (TIER_1_NAMES.has(f.name)) return 1;
  if (TIER_2_NAMES.has(f.name)) return 2;
  return 3;
}

// ─── Sub-components ─────────────────────────────────────────────────

function TierSection({
  tier,
  factors,
  passCount,
  totalCount,
  passPoints,
  totalPoints,
  defaultOpen,
}: {
  tier: number;
  factors: FactorItem[];
  passCount: number;
  totalCount: number;
  passPoints: number;
  totalPoints: number;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const cfg = TIER_CONFIG[tier] || TIER_CONFIG[3];
  const ratio = totalCount > 0 ? passCount / totalCount : 0;

  return (
    <div className={`border rounded-md overflow-hidden ${cfg.borderColor}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full flex items-center justify-between px-2 py-1.5 text-[9px] font-bold tracking-wide uppercase hover:bg-muted/20 transition-colors ${cfg.bgColor}`}
      >
        <span className="flex items-center gap-1.5">
          <span className={`${cfg.color} font-black`}>{cfg.label}</span>
          <span className="text-muted-foreground font-normal normal-case">{cfg.sublabel}</span>
          <span className={`text-[8px] font-mono ${ratio >= 0.5 ? "text-success" : "text-muted-foreground"}`}>
            ({passCount}/{totalCount})
          </span>
        </span>
        <span className="flex items-center gap-2">
          <span className="text-[8px] font-mono text-muted-foreground">
            {passPoints.toFixed(1)}/{totalPoints.toFixed(1)} pts
          </span>
          <ChevronDown className={`h-2.5 w-2.5 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
        </span>
      </button>
      {open && (
        <div className="px-2 py-1.5 space-y-0.5 border-t border-border/30">
          {factors.map((f, i) => (
            <div key={i} className="flex items-start gap-1 text-[9px]">
              <span className={`mt-0.5 ${f.present ? "text-success" : "text-muted-foreground/50"}`}>
                {f.present ? "✓" : "✗"}
              </span>
              <div className="flex-1 min-w-0">
                <span className={f.present ? "text-foreground" : "text-muted-foreground/60"}>
                  {f.name}
                </span>
                {f.detail && (
                  <span className="text-muted-foreground ml-1">— {f.detail}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Score Summary Bar ──────────────────────────────────────────────

export function TierScoreSummary({ tieredScoring }: { tieredScoring: TieredScoringMeta }) {
  const ts = tieredScoring;
  return (
    <div className="flex items-center gap-1.5 flex-wrap text-[9px] font-mono">
      <span className="text-amber-400">T1:{ts.tier1Count}/{ts.tier1Max}</span>
      <span className="text-muted-foreground/40">|</span>
      <span className="text-sky-400">T2:{ts.tier2Count}/{ts.tier2Max}</span>
      <span className="text-muted-foreground/40">|</span>
      <span className="text-violet-400">T3:{ts.tier3Count}/{ts.tier3Max}</span>
    </div>
  );
}

// ─── Gate Display ───────────────────────────────────────────────────

export function TierGates({ tieredScoring }: { tieredScoring: TieredScoringMeta }) {
  const ts = tieredScoring;
  const gates: { passed: boolean; reason: string; infoOnly?: boolean }[] = [
    { passed: ts.tier1GatePassed, reason: ts.tier1GateReason },
    { passed: ts.regimeGatePassed, reason: ts.regimeGateReason },
  ].filter(g => g.reason);

  // Spread is info-only — always show but with info icon, never as a failure
  if (ts.spreadGateReason) {
    gates.push({ passed: true, reason: ts.spreadGateReason, infoOnly: true });
  }

  if (gates.length === 0) return null;

  return (
    <div className="space-y-0.5">
      <p className="text-[8px] text-muted-foreground uppercase tracking-wider font-bold">Tier Gates</p>
      {gates.map((g, i) => (
        <div key={i} className={`flex items-center gap-1 text-[9px] ${
          g.infoOnly ? "text-muted-foreground/70" : g.passed ? "text-muted-foreground" : "text-destructive"
        }`}>
          <span>{
            g.infoOnly ? <Info className="h-2.5 w-2.5" /> :
            g.passed ? <ShieldCheck className="h-2.5 w-2.5" /> : <ShieldX className="h-2.5 w-2.5" />
          }</span>
          <span>{g.reason}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export function TierFactorBreakdown({ factors, tieredScoring, compact = false }: TierFactorBreakdownProps) {
  // Separate disabled factors
  const isDisabled = (f: FactorItem) => f.weight === 0 || (typeof f.detail === "string" && /disabled/i.test(f.detail));
  const enabledFactors = factors.filter(f => !isDisabled(f) || f.name === "Power of 3 Combo");
  const disabledFactors = factors.filter(f => isDisabled(f) && f.name !== "Power of 3 Combo");

  // Separate info-only factors (Regime Alignment, Spread Quality) — they are gates, not scored
  const INFO_ONLY = new Set(["Regime Alignment", "Spread Quality"]);
  const scoredFactors = enabledFactors.filter(f => !INFO_ONLY.has(f.name));
  const infoFactors = enabledFactors.filter(f => INFO_ONLY.has(f.name));

  // Group by tier
  const tier1 = scoredFactors.filter(f => classifyTier(f) === 1);
  const tier2 = scoredFactors.filter(f => classifyTier(f) === 2);
  const tier3 = scoredFactors.filter(f => classifyTier(f) === 3);

  // Calculate points per tier
  const tierPoints = (items: FactorItem[], pointsEach: number) => {
    const present = items.filter(f => f.present).length;
    return { passCount: present, totalCount: items.length, passPoints: present * pointsEach, totalPoints: items.length * pointsEach };
  };

  const t1 = tierPoints(tier1, 2);
  const t2 = tierPoints(tier2, 1);
  const t3 = tierPoints(tier3, 0.5);

  // Use tieredScoring metadata if available (more accurate since backend calculates with actual weights)
  const ts = tieredScoring;

  return (
    <div className="space-y-1.5">
      {/* Tier score summary */}
      {ts && (
        <div className="flex items-center gap-2">
          <TierScoreSummary tieredScoring={ts} />
          <span className="text-[8px] text-muted-foreground font-mono ml-auto">
            {ts.tieredScore.toFixed(1)}/{ts.tieredMax.toFixed(1)} pts
          </span>
        </div>
      )}

      {/* Tier sections */}
      {tier1.length > 0 && (
        <TierSection
          tier={1}
          factors={tier1}
          passCount={ts?.tier1Count ?? t1.passCount}
          totalCount={ts?.tier1Max ?? t1.totalCount}
          passPoints={ts ? ts.tier1Count * 2 : t1.passPoints}
          totalPoints={ts ? ts.tier1Max * 2 : t1.totalPoints}
          defaultOpen={!compact}
        />
      )}
      {tier2.length > 0 && (
        <TierSection
          tier={2}
          factors={tier2}
          passCount={ts?.tier2Count ?? t2.passCount}
          totalCount={ts?.tier2Max ?? t2.totalCount}
          passPoints={ts ? ts.tier2Count * 1 : t2.passPoints}
          totalPoints={ts ? ts.tier2Max * 1 : t2.totalPoints}
          defaultOpen={!compact && t2.passCount > 0}
        />
      )}
      {tier3.length > 0 && (
        <TierSection
          tier={3}
          factors={tier3}
          passCount={ts?.tier3Count ?? t3.passCount}
          totalCount={ts?.tier3Max ?? t3.totalCount}
          passPoints={ts ? ts.tier3Count * 0.5 : t3.passPoints}
          totalPoints={ts ? ts.tier3Max * 0.5 : t3.totalPoints}
          defaultOpen={false}
        />
      )}

      {/* Info-only factors (Regime, Spread) — shown as simple chips */}
      {infoFactors.length > 0 && (
        <div className="space-y-0.5">
          <p className="text-[8px] text-muted-foreground uppercase tracking-wider">Info Only (Gates)</p>
          {infoFactors.map((f, i) => (
            <div key={i} className="flex items-start gap-1 text-[9px]">
              <span className={`mt-0.5 ${f.present ? "text-warning" : "text-success"}`}>
                {f.present ? "⚠" : "✓"}
              </span>
              <div>
                <span className="text-muted-foreground">{f.name}</span>
                {f.detail && <span className="text-muted-foreground/70 ml-1">— {f.detail}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tier gates */}
      {ts && <TierGates tieredScoring={ts} />}

      {/* Disabled factors */}
      {disabledFactors.length > 0 && (
        <div>
          <div className="border-t border-dashed border-border/50 mb-1.5" />
          <p className="text-[8px] uppercase tracking-wider text-muted-foreground/60 font-medium">
            Disabled ({disabledFactors.length})
          </p>
          <div className="flex flex-wrap gap-1 mt-0.5">
            {disabledFactors.map((f, i) => (
              <span
                key={`dis-${i}`}
                className="inline-flex items-center gap-1 rounded-full border border-border/30 px-1.5 py-0.5 text-[9px] font-mono opacity-50"
                title={`${f.name} — disabled`}
              >
                <span className="text-muted-foreground/60">—</span>
                <span className="truncate max-w-[120px] line-through text-muted-foreground/70">{f.name}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default TierFactorBreakdown;

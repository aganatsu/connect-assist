import { BarChart3, ChevronDown } from "lucide-react";
import {
  TierFactorBreakdown,
  TierScoreSummary,
  type TieredScoringMeta,
} from "./TierFactorBreakdown";

interface FactorScore {
  name: string;
  present: boolean;
  weight: number;
  detail?: string;
  tier?: number;
}

interface Props {
  score?: number | null;
  factorCount?: number | null;
  factorTotal?: number | null;
  factors?: FactorScore[] | null;
  legacyFactorNames?: string[] | null;
  tieredScoring?: TieredScoringMeta | null;
  gates?: Array<{ passed: boolean; reason: string }> | null;
  ownershipDiagnostics?: Array<{
    code: string;
    owner: string;
    passed: boolean;
    diagnosticOnly: boolean;
    blocksAuthorization: boolean;
    reason: string;
  }> | null;
  formatGateReason?: (reason: string) => string;
  compact?: boolean;
}

export function LegacyDiagnosticsPanel({
  score,
  factorCount,
  factorTotal,
  factors,
  legacyFactorNames,
  tieredScoring,
  gates,
  ownershipDiagnostics,
  formatGateReason = (reason) => reason,
  compact = false,
}: Props) {
  const hasContent = score != null || tieredScoring || ((factors?.length ?? 0) > 0 || (legacyFactorNames?.length ?? 0) > 0) ||
    (gates?.length ?? 0) > 0 || (ownershipDiagnostics?.length ?? 0) > 0;
  if (!hasContent) return null;

  return (
    <details className="group border border-border/60 bg-muted/10">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs">
        <span className="flex min-w-0 items-center gap-2 font-medium">
          <BarChart3 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          Legacy Scores and Filters
          <span className="text-[9px] font-normal uppercase text-muted-foreground">Does not authorize</span>
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-3 border-t border-border/50 px-3 py-3">
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
          {score != null && <span className="font-mono">Legacy score {score > 10 ? `${score.toFixed(1)}%` : score.toFixed(1)}</span>}
          {factorCount != null && <span>{factorCount}{factorTotal ? `/${factorTotal}` : ""} factors</span>}
          {tieredScoring && <TierScoreSummary tieredScoring={tieredScoring} />}
        </div>

        {factors && factors.length > 0 ? (
          <TierFactorBreakdown factors={factors} tieredScoring={tieredScoring ?? null} compact={compact} />
        ) : legacyFactorNames && legacyFactorNames.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {legacyFactorNames.map((name) => <span key={name} className="border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">{name}</span>)}
          </div>
        ) : null}

        {ownershipDiagnostics && ownershipDiagnostics.length > 0 && (
          <div className="space-y-1">
            <p className="text-[9px] font-medium uppercase text-muted-foreground">Filter classification</p>
            {ownershipDiagnostics.map((gate, index) => (
              <div key={`${gate.code}:${index}`} className="flex items-start justify-between gap-3 text-[10px]">
                <span className={gate.passed ? "text-muted-foreground" : "text-warning"}>{gate.reason}</span>
                <span className="shrink-0 font-mono text-muted-foreground">{gate.owner}</span>
              </div>
            ))}
          </div>
        )}

        {gates && gates.length > 0 && (
          <div className="space-y-1">
            <p className="text-[9px] font-medium uppercase text-muted-foreground">Historical gate outputs</p>
            {gates.map((gate, index) => (
              <div key={index} className={`flex items-start gap-1 text-[10px] ${gate.passed ? "text-muted-foreground" : "text-destructive"}`}>
                <span>{gate.passed ? "Pass" : "Fail"}</span>
                <span>{formatGateReason(gate.reason)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

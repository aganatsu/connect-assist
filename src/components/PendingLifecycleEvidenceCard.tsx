import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getPipLabel } from "@/lib/pipDisplay";
import type { PendingLifecycleEvidenceRow } from "@/lib/pendingLifecycleEvidence";

interface PendingLifecycleReport {
  summary: {
    total: number;
    active: number;
    touched: number;
    expiredUntouched: number;
    expiredUntouchedRate: number | null;
    sequenceReady: number;
    filled: number;
    linkedOutcomes: number;
    frozenLocationAvailable: number;
    reachabilityAvailable: number;
    withinReferenceDistance: number;
    averageArmDistancePips: number | null;
    averageArmDistanceAtr: number | null;
    repeatedPlans: number;
    repeatedLifecycleRows: number;
    reasonCounts: Record<string, number>;
    confirmationEvaluations: number;
    confirmationBothPassed: number;
    confirmationDetectorOnly: number;
    confirmationLifecycleOnly: number;
    confirmationNeitherPassed: number;
    missingLifecycleContractSamples: number;
    finalAuthorizationObserved: number;
    finalAuthorizationBlocked: number;
    finalAuthorizationRiskRewardBlocked: number;
    averageFavorableEntryDriftR: number | null;
    riskRewardRegimes: Record<string, number>;
  };
  rows: PendingLifecycleEvidenceRow[];
}

export function PendingLifecycleEvidenceCard({
  report,
  loading,
}: {
  report: PendingLifecycleReport | null | undefined;
  loading: boolean;
}) {
  return (
    <Card className="border-cyan-500/25">
      <CardHeader className="px-4 pb-2 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-sm font-medium">Pending Lifecycle Evidence</CardTitle>
            <p className="mt-1 text-[10px] text-muted-foreground">
              Arm-time reachability, zone watches, and confirmation outcomes. This evidence never changes execution.
            </p>
          </div>
          <Badge variant="outline" className="border-cyan-500/40 text-[9px] text-cyan-400">
            OBSERVE ONLY
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 px-4 pb-4">
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading pending lifecycle evidence…</div>
        ) : !report ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Pending lifecycle evidence is unavailable.</div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4 xl:grid-cols-12">
              <Metric label="Setups" value={report.summary.total} />
              <Metric label="Active" value={report.summary.active} />
              <Metric label="Zone touched" value={report.summary.touched} />
              <Metric
                label="Expired untouched"
                value={report.summary.expiredUntouchedRate == null
                  ? report.summary.expiredUntouched
                  : report.summary.expiredUntouched + " · " + (report.summary.expiredUntouchedRate * 100).toFixed(0) + "%"}
              />
              <Metric label="Sequence seen" value={report.summary.sequenceReady} />
              <Metric label="Filled" value={report.summary.filled} />
              <Metric label="Linked outcomes" value={report.summary.linkedOutcomes} />
              <Metric label="Reachability sample" value={report.summary.reachabilityAvailable + "/" + report.summary.total} />
              <Metric
                label="Within limit reference"
                value={report.summary.withinReferenceDistance + "/" + report.summary.reachabilityAvailable}
              />
              <Metric
                label="Avg FX arm distance"
                value={report.summary.averageArmDistancePips == null
                  ? "—"
                  : report.summary.averageArmDistancePips.toFixed(1) + " pips"}
              />
              <Metric
                label="Avg arm distance"
                value={report.summary.averageArmDistanceAtr == null
                  ? "—"
                  : report.summary.averageArmDistanceAtr.toFixed(2) + " ATR"}
              />
              <Metric
                label="Repeated plans"
                value={report.summary.repeatedPlans + " · " + report.summary.repeatedLifecycleRows + " rows"}
              />
            </div>
            <div className="border-t border-border/60 pt-3">
              <p className="mb-2 text-[10px] font-medium uppercase text-muted-foreground">
                Confirmation ownership · closed-candle observations
              </p>
              <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4 xl:grid-cols-8">
                <Metric label="Evaluations" value={report.summary.confirmationEvaluations} />
                <Metric label="Both passed" value={report.summary.confirmationBothPassed} />
                <Metric label="Detector only" value={report.summary.confirmationDetectorOnly} />
                <Metric label="Lifecycle only" value={report.summary.confirmationLifecycleOnly} />
                <Metric label="Neither passed" value={report.summary.confirmationNeitherPassed} />
                <Metric label="Missing contract" value={report.summary.missingLifecycleContractSamples} />
                <Metric
                  label="Final auth blocked"
                  value={report.summary.finalAuthorizationBlocked + "/" + report.summary.finalAuthorizationObserved}
                />
                <Metric label="R:R blocked" value={report.summary.finalAuthorizationRiskRewardBlocked} />
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge variant="outline" className="text-[9px]">
                  Avg favorable entry drift · {report.summary.averageFavorableEntryDriftR == null
                    ? "—"
                    : report.summary.averageFavorableEntryDriftR.toFixed(2) + "R"}
                </Badge>
                {Object.entries(report.summary.riskRewardRegimes).map(([regime, count]) => (
                  <Badge key={regime} variant="outline" className="text-[9px]">
                    {regime} · {count}
                  </Badge>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-[10px] font-medium uppercase text-muted-foreground">Sequence reasons</p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(report.summary.reasonCounts)
                  .sort((a, b) => b[1] - a[1])
                  .map(([reason, count]) => (
                    <Badge key={reason} variant="outline" className="text-[9px]">
                      {reason.replace(/_/g, " ")} · {count}
                    </Badge>
                  ))}
              </div>
            </div>
            <div className="space-y-1.5">
              {report.rows.slice(0, 12).map((row) => {
                const unit = getPipLabel(row.symbol);
                return (
                  <div key={row.id} className="grid grid-cols-1 gap-1 border-l-2 border-cyan-500/40 pl-3 text-[10px] sm:grid-cols-[1fr_auto]">
                    <div>
                      <span className="font-mono font-medium">{row.symbol} {row.direction.toUpperCase()}</span>
                      <span className="text-muted-foreground"> · {row.status.replace(/_/g, " ")} · {row.sequenceReason?.replace(/_/g, " ") || "observation unavailable"}</span>
                    </div>
                    <div className="font-mono text-muted-foreground">
                      {row.armDistancePips == null ? "armed —" : "armed " + row.armDistancePips.toFixed(1) + " " + unit}
                      {row.armDistanceAtr == null ? "" : " / " + row.armDistanceAtr.toFixed(2) + " ATR"}
                      {row.latestDistancePips == null ? "" : " → latest " + row.latestDistancePips.toFixed(1) + " " + unit}
                      {row.armTtlMinutes == null ? "" : " · TTL " + row.armTtlMinutes.toFixed(0) + "m"}
                      {row.withinReferenceDistance == null ? "" : row.withinReferenceDistance
                        ? " · within distance reference"
                        : " · beyond " + row.referenceMaxDistancePips?.toFixed(0) + "p reference"}
                      {row.repeatPlanCount > 1 ? " · same plan ×" + row.repeatPlanCount : ""}
                      {row.frozenEntryLocationAllowed == null ? " · P/D —" : " · P/D " + (row.frozenEntryLocationAllowed ? "pass" : "block")}
                      {row.linkedPosition ? " · " + (row.linkedPosition.close_reason || row.linkedPosition.position_status) : ""}
                      {row.finalAuthorizationObserved
                        ? " · auth " + (row.finalAuthorizationAuthorized ? "pass" : "block") +
                          (row.authorizationRiskReward == null ? "" : " @ " + row.authorizationRiskReward.toFixed(2) + "R") +
                          (row.favorableEntryDriftR == null ? "" : " · drift " + row.favorableEntryDriftR.toFixed(2) + "R")
                        : ""}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div><span className="text-muted-foreground">{label}</span><p className="font-mono font-bold">{value}</p></div>;
}

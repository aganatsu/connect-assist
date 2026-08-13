import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PendingLifecycleEvidenceRow } from "@/lib/pendingLifecycleEvidence";

interface PendingLifecycleReport {
  summary: {
    total: number;
    active: number;
    touched: number;
    expiredUntouched: number;
    sequenceReady: number;
    filled: number;
    linkedOutcomes: number;
    frozenLocationAvailable: number;
    averageObservedDistancePips: number | null;
    reasonCounts: Record<string, number>;
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
              Zone watches and confirmation observations. These are not rejected setups and do not change execution.
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
            <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4 xl:grid-cols-9">
              <Metric label="Setups" value={report.summary.total} />
              <Metric label="Active" value={report.summary.active} />
              <Metric label="Zone touched" value={report.summary.touched} />
              <Metric label="Expired untouched" value={report.summary.expiredUntouched} />
              <Metric label="Sequence seen" value={report.summary.sequenceReady} />
              <Metric label="Filled" value={report.summary.filled} />
              <Metric label="Linked outcomes" value={report.summary.linkedOutcomes} />
              <Metric label="P/D available" value={report.summary.frozenLocationAvailable} />
              <Metric
                label="Observed distance"
                value={report.summary.averageObservedDistancePips == null
                  ? "—"
                  : `${report.summary.averageObservedDistancePips.toFixed(1)} pips`}
              />
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
              {report.rows.slice(0, 12).map((row) => (
                <div key={row.id} className="grid grid-cols-1 gap-1 border-l-2 border-cyan-500/40 pl-3 text-[10px] sm:grid-cols-[1fr_auto]">
                  <div>
                    <span className="font-mono font-medium">{row.symbol} {row.direction.toUpperCase()}</span>
                    <span className="text-muted-foreground"> · {row.status.replace(/_/g, " ")} · {row.sequenceReason?.replace(/_/g, " ") || "observation unavailable"}</span>
                  </div>
                  <div className="font-mono text-muted-foreground">
                    {row.observedDistancePips == null ? "distance —" : `${row.observedDistancePips.toFixed(1)} pips`}
                    {row.frozenEntryLocationAllowed == null ? " · P/D —" : ` · P/D ${row.frozenEntryLocationAllowed ? "pass" : "block"}`}
                    {row.linkedPosition ? ` · ${row.linkedPosition.close_reason || row.linkedPosition.position_status}` : ""}
                  </div>
                </div>
              ))}
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

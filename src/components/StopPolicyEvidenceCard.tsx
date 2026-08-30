import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OverflowText } from "@/components/ui/overflow-text";
import { getPipLabel } from "@/lib/pipDisplay";
import type { StopPolicyEvidenceRow } from "@/lib/stopPolicyEvidence";

interface StopPolicyEvidenceReport {
  summary: {
    total: number;
    currentValid: number;
    shadowValid: number;
    comparable: number;
    tighter: number;
    wider: number;
    unchanged: number;
    capBreaches: number;
    proxySamples: number;
    exactBrokerSamples: number;
    averageCurrentStopPips: number | null;
    averageShadowStopPips: number | null;
    averageCurrentRiskReward: number | null;
    averageShadowRiskReward: number | null;
  };
  rows: StopPolicyEvidenceRow[];
}

function number(value: number | null, suffix = "") {
  return value == null ? "—" : `${value.toFixed(2)}${suffix}`;
}

export function StopPolicyEvidenceCard({
  report,
  loading,
}: {
  report: StopPolicyEvidenceReport | null | undefined;
  loading: boolean;
}) {
  return (
    <Card className="border-cyan-500/25">
      <CardHeader className="px-4 pb-2 pt-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm font-medium">Stop Policy Shadow</CardTitle>
            <p className="mt-1 text-[10px] text-muted-foreground">
              First-evaluation comparison of the current stop and the proposed style-aware stop. It never changes execution.
            </p>
          </div>
          <Badge variant="outline" className="border-cyan-500/40 text-[9px] text-cyan-400">
            OBSERVE ONLY · 90 DAYS
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 px-4 pb-4">
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading stop-policy evidence…</div>
        ) : !report ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Stop-policy evidence is unavailable.</div>
        ) : report.summary.total === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No candidates have been observed since deployment. New zone-candidate evaluations will appear here automatically.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4 xl:grid-cols-10">
              <Metric label="Candidates" value={report.summary.total} />
              <Metric label="Comparable" value={report.summary.comparable} />
              <Metric label="Current valid" value={report.summary.currentValid} />
              <Metric label="Proposed valid" value={report.summary.shadowValid} />
              <Metric label="Tighter" value={report.summary.tighter} tone="success" />
              <Metric label="Wider" value={report.summary.wider} tone="warning" />
              <Metric label="Unchanged" value={report.summary.unchanged} />
              <Metric
                label="Cap breaches"
                value={report.summary.capBreaches === 0 ? "0 · untested" : report.summary.capBreaches}
                tone={report.summary.capBreaches > 0 ? "destructive" : "default"}
              />
              <Metric label="Proxy inputs" value={report.summary.proxySamples} />
              <Metric label="Exact broker" value={report.summary.exactBrokerSamples} />
            </div>

            <div className="grid grid-cols-2 gap-3 border-t border-border/60 pt-3 text-xs sm:grid-cols-4">
              <Metric label="Avg FX current stop" value={number(report.summary.averageCurrentStopPips, " pips")} />
              <Metric label="Avg FX proposed stop" value={number(report.summary.averageShadowStopPips, " pips")} />
              <Metric label="Avg current R:R" value={number(report.summary.averageCurrentRiskReward, "R")} />
              <Metric label="Avg proposed R:R" value={number(report.summary.averageShadowRiskReward, "R")} />
            </div>

            {report.summary.proxySamples > 0 && (
              <p className="border-l-2 border-warning/60 pl-3 text-[10px] text-muted-foreground">
                {report.summary.proxySamples} sample{report.summary.proxySamples === 1 ? " uses" : "s use"} the configured spread proxy.
                Broker stops level, digits, and tick size are not exact for those rows.
              </p>
            )}

            <div className="space-y-1.5">
              {report.rows.slice(0, 12).map((row) => {
                const unit = getPipLabel(row.symbol);
                const delta = row.stopDistanceDeltaPips;
                const deltaLabel = delta == null
                  ? "no comparison"
                  : Math.abs(delta) <= 0.05
                  ? "unchanged"
                  : delta < 0
                  ? `${Math.abs(delta).toFixed(1)} ${unit} tighter`
                  : `${delta.toFixed(1)} ${unit} wider`;
                return (
                  <div
                    key={row.id}
                    className="grid grid-cols-1 gap-1 border-l-2 border-cyan-500/40 pl-3 text-[10px] sm:grid-cols-[minmax(0,1fr)_auto]"
                  >
                    <div className="min-w-0">
                      <span className="font-mono font-medium">{row.symbol} {row.direction.toUpperCase()}</span>
                      <span className="text-muted-foreground">
                        {` · ${row.trading_style.replace(/_/g, " ")} · ${row.confirmation_timeframe} · ${row.execution_floor_source.replace(/_/g, " ")}`}
                      </span>
                      {row.shadow_plan_reason && (
                        <OverflowText
                          text={row.shadow_plan_reason.replace(/_/g, " ")}
                          className="block text-destructive"
                        />
                      )}
                    </div>
                    <div className="font-mono text-muted-foreground sm:text-right">
                      <span>{row.currentStopDistancePips == null ? "—" : row.currentStopDistancePips.toFixed(1)} → {row.shadowStopDistancePips == null ? "—" : row.shadowStopDistancePips.toFixed(1)} {unit}</span>
                      <span>{` · ${deltaLabel}`}</span>
                      <span>{` · R:R ${number(row.current_risk_reward)} → ${number(row.shadow_risk_reward)}`}</span>
                      <span>{` · TP ${row.current_take_profit_source || "—"} → ${row.shadow_take_profit_source || "—"}`}</span>
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

function Metric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string | number;
  tone?: "default" | "success" | "warning" | "destructive";
}) {
  const toneClass = tone === "success"
    ? "text-success"
    : tone === "warning"
    ? "text-warning"
    : tone === "destructive"
    ? "text-destructive"
    : "";
  return (
    <div className="min-w-0">
      <span className="text-muted-foreground">{label}</span>
      <p className={`font-mono font-bold ${toneClass}`}>{value}</p>
    </div>
  );
}

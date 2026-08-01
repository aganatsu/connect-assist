/**
 * TimeframeEvidencePanel — read-only Phase 1 evidence viewer.
 *
 * Historical records must provide an exact evidenceId. Live scan cards may
 * deliberately request the newest observation for their symbol. Loading is
 * lazy so a collapsed panel does not query the audit table.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

interface SlotEvidence {
  slot: "top" | "mid" | "low";
  timeframe: string;
  available: boolean;
  skippedReason: string | null;
  candleCount: number;
  reason: string;
  rejections?: Array<{
    code: string;
    measured: number | null;
    threshold: number | null;
    comparator: string | null;
    explanation: string;
  }>;
  impulses: Array<{
    impulseId?: string;
    selected: boolean;
    direction: string;
    startDate: string | null;
    endDate: string | null;
    spanBars: number;
    isValid: boolean;
    rejection: { code: string; explanation: string } | null;
  }>;
  pois: Array<{
    candidateId: string;
    impulseId?: string;
    type: string;
    formationTime: string | null;
    lifecycle: string | null;
    ageBars: number;
    bodyRatio: number | null;
    displacementRange: number | null;
    displacementATRMultiple: number | null;
    fibDepth: number | null;
    distancePips: number | null;
    accepted: boolean;
    rejection: {
      code: string;
      measured: number;
      threshold: number;
      comparator: string;
      explanation: string;
    } | null;
  }>;
  candidates: Array<{
    candidateId: string;
    rank: number;
    type: string;
    totalScore: number;
  }>;
}

interface EvidenceRecord {
  id: string;
  symbol: string;
  direction: string;
  observed_at: string;
  trading_style: string | null;
  style_policy_snapshot: {
    style?: string;
    timeframes?: Record<string, string>;
  } | null;
  selected_timeframe: string | null;
  final_reason: string | null;
  slots: SlotEvidence[];
  payload_truncated: boolean;
}

interface EvidenceSummary {
  evidence_id: string;
  observed_at: string;
  direction: string;
  selected_timeframe: string | null;
  final_reason: string | null;
  winner_candidate_id: string | null;
  rejection_code_counts: Record<string, number>;
  evidence_hash: string;
}

interface Props {
  symbol?: string;
  direction?: string | null;
  evidenceId?: string | null;
  isLiveContext?: boolean;
}

const SLOT_LABELS: Record<string, string> = {
  top: "Bias",
  mid: "Structure",
  low: "Setup",
};

function evidenceDirection(direction?: string | null): string | null {
  if (direction === "long") return "bullish";
  if (direction === "short") return "bearish";
  if (direction === "bullish" || direction === "bearish") return direction;
  return null;
}

export function TimeframeEvidencePanel({
  symbol,
  direction,
  evidenceId,
  isLiveContext = false,
}: Props) {
  const [record, setRecord] = useState<EvidenceRecord | null>(null);
  const [summary, setSummary] = useState<EvidenceSummary | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRecord(null);
    setSummary(null);
    setLoaded(false);
    setError(null);
  }, [evidenceId, symbol, direction, isLiveContext]);

  useEffect(() => {
    if (!open || loaded) return;
    if (!evidenceId && (!isLiveContext || !symbol)) {
      setLoaded(true);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      let query = supabase
        .from("zone_timeframe_evidence")
        .select(
          "id,symbol,direction,observed_at,trading_style,style_policy_snapshot,selected_timeframe,final_reason,slots,payload_truncated",
        );

      if (evidenceId) {
        query = query.eq("id", evidenceId);
      } else {
        query = query
          .eq("symbol", symbol)
          .eq("evidence_source", "live_scan");
        const normalizedDirection = evidenceDirection(direction);
        if (normalizedDirection) {
          query = query.eq("direction", normalizedDirection);
        }
        query = query.order("observed_at", { ascending: false });
      }

      const { data, error: queryError } = await query.limit(1);
      if (cancelled) return;
      const exactRecord = (data?.[0] as EvidenceRecord) ?? null;
      setRecord(exactRecord);
      let resolvedError = queryError?.message ?? null;
      if (!queryError && !exactRecord && evidenceId) {
        const { data: compactData, error: compactError } = await supabase
          .from("zone_timeframe_evidence_summary")
          .select(
            "evidence_id,observed_at,direction,selected_timeframe,final_reason,winner_candidate_id,rejection_code_counts,evidence_hash",
          )
          .eq("evidence_id", evidenceId)
          .limit(1);
        if (cancelled) return;
        setSummary((compactData?.[0] as EvidenceSummary) ?? null);
        resolvedError = compactError?.message ?? null;
      }
      setError(resolvedError);
      setLoaded(true);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [open, loaded, evidenceId, symbol, direction, isLiveContext]);

  if (!symbol && !evidenceId) return null;

  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between text-left text-xs font-semibold text-foreground"
      >
        <span>
          🔍 Timeframe Evidence
          {record
            ? ` — ${record.direction} · ${new Date(record.observed_at).toLocaleString()}`
            : summary
            ? ` — compact summary · ${new Date(summary.observed_at).toLocaleString()}`
            : evidenceId
            ? " — linked scan"
            : isLiveContext
            ? " — latest live scan"
            : " — not linked"}
        </span>
        <span className="text-muted-foreground">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          {loading && (
            <div className="text-[11px] text-muted-foreground">
              Loading the frozen scan evidence…
            </div>
          )}
          {error && (
            <div className="text-[11px] text-destructive">
              Evidence could not be loaded: {error}
            </div>
          )}
          {!loading && !error && loaded && !record && !summary && (
            <div className="text-[11px] text-muted-foreground">
              {evidenceId
                ? "The linked evidence row and its compact summary are unavailable."
                : isLiveContext
                ? "No live timeframe evidence has been recorded for this symbol yet."
                : "No evidence ID was frozen with this historical record. The latest symbol evidence is intentionally not substituted."}
            </div>
          )}
          {summary && (
            <div className="space-y-1 rounded border border-border/60 bg-background/40 p-2 text-[11px] text-muted-foreground">
              <div className="font-medium text-foreground">
                Compact retained summary · {summary.direction}
              </div>
              <div>
                Winner TF {summary.selected_timeframe ?? "none"} ·{" "}
                {summary.final_reason ?? "—"}
              </div>
              <div>
                Winner candidate {summary.winner_candidate_id ?? "none"}
              </div>
              <div>
                Rejections:{" "}
                {Object.entries(summary.rejection_code_counts ?? {})
                  .map(([code, count]) => `${code} ×${count}`)
                  .join(", ") || "none recorded"}
              </div>
              <div className="font-mono text-[10px]">
                Evidence hash {summary.evidence_hash}
              </div>
            </div>
          )}
          {record && (
            <>
              <div className="text-[11px] text-muted-foreground">
                Style {record.trading_style ?? "—"} · winner TF{" "}
                {record.selected_timeframe ?? "none"} ·{" "}
                {record.final_reason ?? "—"}
                {record.payload_truncated && " · payload truncated"}
              </div>
              {record.style_policy_snapshot?.timeframes && (
                <div className="text-[11px] text-muted-foreground">
                  Ladder{" "}
                  {Object.entries(record.style_policy_snapshot.timeframes)
                    .map(([role, timeframe]) => `${role} ${timeframe}`)
                    .join(" → ")}
                </div>
              )}
              {(record.slots ?? []).map((slot) => (
                <div
                  key={slot.slot}
                  className="rounded border border-border/60 bg-background/40 p-2"
                >
                  <div className="text-[11px] font-medium text-foreground">
                    {SLOT_LABELS[slot.slot] ?? slot.slot} · {slot.timeframe} ·{" "}
                    {slot.candleCount} candles
                  </div>
                  {!slot.available
                    ? (
                      <div className="text-[11px] text-muted-foreground">
                        {slot.skippedReason ?? "not evaluated"}
                      </div>
                    )
                    : (
                      <div className="mt-1 space-y-1 text-[11px] text-muted-foreground">
                        <div>
                          Legs: {slot.impulses.length}
                          {slot.impulses.some((leg) => leg.selected)
                            ? " (1 selected)"
                            : " (none selected)"}
                        </div>
                        <div>
                          POIs: {slot.pois.filter((poi) => poi.accepted).length}{" "}
                          accepted / {slot.pois.length} mapped
                        </div>
                        {(slot.rejections ?? []).map((rejection) => (
                          <div
                            key={`${slot.slot}-${rejection.code}`}
                            className="pl-2 text-destructive/80"
                          >
                            {rejection.explanation}
                            {rejection.measured !== null &&
                                rejection.threshold !== null
                              ? ` (${rejection.measured} ${rejection.comparator ?? "vs"} ${rejection.threshold})`
                              : ""}
                          </div>
                        ))}
                        {slot.pois
                          .filter((poi) => poi.rejection)
                          .slice(0, 4)
                          .map((poi) => (
                            <div
                              key={poi.candidateId}
                              className="pl-2 text-destructive/80"
                            >
                              {poi.type.toUpperCase()}{" "}
                              {poi.formationTime
                                ? `@ ${new Date(poi.formationTime).toLocaleString()}: `
                                : ""}
                              {poi.rejection?.explanation}
                              {poi.rejection
                                ? ` (${poi.rejection.measured} ${poi.rejection.comparator} ${poi.rejection.threshold})`
                                : ""}
                            </div>
                          ))}
                        {slot.pois
                          .filter((poi) => poi.accepted)
                          .slice(0, 4)
                          .map((poi) => (
                            <div
                              key={`${poi.candidateId}-accepted`}
                              className="pl-2 text-emerald-500/80"
                            >
                              {poi.type.toUpperCase()} accepted · lifecycle{" "}
                              {poi.lifecycle ?? "unknown"} · age {poi.ageBars} bars
                              {poi.displacementATRMultiple !== null
                                ? ` · displacement ${poi.displacementATRMultiple.toFixed(2)}× ATR`
                                : ""}
                              {poi.fibDepth !== null
                                ? ` · Fib depth ${(poi.fibDepth * 100).toFixed(1)}%`
                                : ""}
                              {poi.distancePips !== null
                                ? ` · ${poi.distancePips.toFixed(1)} pips away`
                                : ""}
                            </div>
                          ))}
                        <div>
                          Ranked candidates:{" "}
                          {slot.candidates
                            .map((candidate) =>
                              `#${candidate.rank} ${candidate.type.toUpperCase()} (${candidate.totalScore})`
                            )
                            .join(", ") || "none"}
                        </div>
                        <div className="text-muted-foreground/80">
                          {slot.reason}
                        </div>
                      </div>
                    )}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default TimeframeEvidencePanel;

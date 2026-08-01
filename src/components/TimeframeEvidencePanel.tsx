/**
 * TimeframeEvidencePanel — read-only Phase 1 evidence viewer.
 *
 * Shows what the zone engine saw on every timeframe slot for the most recent
 * scan of a symbol: legs considered, POIs mapped and why each was rejected.
 * Observation only — nothing here influences scoring, gating or execution.
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
  impulses: Array<{ selected: boolean; direction: string; startDate: string | null; endDate: string | null; spanBars: number; isValid: boolean; rejection: { code: string; explanation: string } | null }>;
  pois: Array<{ candidateId: string; type: string; accepted: boolean; rejection: { code: string; explanation: string } | null }>;
  candidates: Array<{ candidateId: string; rank: number; type: string; totalScore: number }>;
}

interface EvidenceRecord {
  id: string;
  symbol: string;
  direction: string;
  observed_at: string;
  trading_style: string | null;
  selected_timeframe: string | null;
  final_reason: string | null;
  slots: SlotEvidence[];
  payload_truncated: boolean;
}

const SLOT_LABELS: Record<string, string> = { top: "Bias", mid: "Structure", low: "Setup" };

export function TimeframeEvidencePanel({ symbol }: { symbol?: string }) {
  const [record, setRecord] = useState<EvidenceRecord | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!symbol) { setRecord(null); return; }
    let cancelled = false;
    (async () => {
      const { data } = await (supabase as any)
        .from("zone_timeframe_evidence")
        .select("id,symbol,direction,observed_at,trading_style,selected_timeframe,final_reason,slots,payload_truncated")
        .eq("symbol", symbol)
        .eq("evidence_source", "live_scan")
        .order("observed_at", { ascending: false })
        .limit(1);
      if (!cancelled) setRecord((data?.[0] as EvidenceRecord) ?? null);
    })();
    return () => { cancelled = true; };
  }, [symbol]);

  if (!record) return null;

  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left text-xs font-semibold text-foreground"
      >
        <span>🔍 Timeframe Evidence — {record.direction} · {new Date(record.observed_at).toLocaleString()}</span>
        <span className="text-muted-foreground">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          <div className="text-[11px] text-muted-foreground">
            Style {record.trading_style ?? "—"} · winner TF {record.selected_timeframe ?? "none"} ·{" "}
            {record.final_reason ?? "—"}
            {record.payload_truncated && " · payload truncated"}
          </div>
          {(record.slots ?? []).map((slot) => (
            <div key={slot.slot} className="rounded border border-border/60 bg-background/40 p-2">
              <div className="text-[11px] font-medium text-foreground">
                {SLOT_LABELS[slot.slot] ?? slot.slot} · {slot.timeframe} · {slot.candleCount} candles
              </div>
              {!slot.available
                ? <div className="text-[11px] text-muted-foreground">{slot.skippedReason ?? "not evaluated"}</div>
                : (
                  <div className="mt-1 space-y-1 text-[11px] text-muted-foreground">
                    <div>
                      Legs: {slot.impulses.length}
                      {slot.impulses.some((l) => l.selected) ? " (1 selected)" : " (none selected)"}
                    </div>
                    <div>
                      POIs: {slot.pois.filter((p) => p.accepted).length} accepted / {slot.pois.length} mapped
                    </div>
                    {slot.pois.filter((p) => p.rejection).slice(0, 4).map((p) => (
                      <div key={p.candidateId} className="pl-2 text-destructive/80">
                        {p.type}: {p.rejection?.explanation}
                      </div>
                    ))}
                    <div>Ranked candidates: {slot.candidates.length}</div>
                    <div className="text-muted-foreground/80">{slot.reason}</div>
                  </div>
                )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default TimeframeEvidencePanel;

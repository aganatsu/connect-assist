/**
 * Pending Orders → "V3 Shadow": the Impulse-on-V3 shadow's pretend orders (owner decisions 2026-10-26). They are NEVER real orders
 * (they live in iov3_shadow_events, not pending_orders), so every card carries a SHADOW badge. The ✓ / ✗ buttons record the
 * owner's chart check; 5 ✓ setups (or a week of SHADOW) unlock ON. Renders nothing while the switch is OFF.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { recentEvents, foldOrders, myFeedback, statusText, fmtUtc, priceFmt, pipsBetween, structureModeApi, type ShadowOrder } from "@/lib/structureMode";

export function V3ShadowOrders() {
  const qc = useQueryClient();
  const mode = useQuery({ queryKey: ["structure-mode"], queryFn: structureModeApi.status, staleTime: 60_000 });
  const on = mode.data && mode.data.mode !== "OFF";
  const q = useQuery({
    queryKey: ["v3-shadow-orders"],
    enabled: !!on,
    refetchInterval: 120_000,
    queryFn: async () => {
      const since = mode.data?.setAt ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
      const [ev, fb] = await Promise.all([recentEvents(since), myFeedback()]);
      return { orders: foldOrders(ev), fb };
    },
  });
  const fb = useMutation({
    mutationFn: (a: { o: ShadowOrder; verdict: "right" | "wrong"; note?: string }) => structureModeApi.feedback(a.o.cohortId, a.o.orderId, a.verdict, a.note),
    onSuccess: (r) => {
      if (r?.error) { toast.error(r.error); return; }
      qc.invalidateQueries({ queryKey: ["v3-shadow-orders"] });
      qc.invalidateQueries({ queryKey: ["structure-mode"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const [showDone, setShowDone] = useState(false);
  if (!on) return null;
  const orders = q.data?.orders ?? [], active = orders.filter((o) => ["watching", "in_zone", "filled"].includes(o.status)), done = orders.filter((o) => !active.includes(o));

  const card = (o: ShadowOrder) => {
    const verdict = q.data?.fb.get(o.orderId);
    return (
      <div key={`${o.cohortId}|${o.orderId}`} className="border border-info/30 bg-info/5 p-2 space-y-1 text-[10px]">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className="text-[9px] border-info/50 text-info">SHADOW</Badge>
          <span className="font-semibold text-xs">{o.pair}</span>
          <span className={o.dir === "long" ? "text-success font-bold" : "text-destructive font-bold"}>{o.dir === "long" ? "BUY LIMIT" : "SELL LIMIT"}</span>
          <span className="text-muted-foreground">placed {fmtUtc(o.placedAt)} UTC</span>
        </div>
        <div className="font-mono">
          Zone {o.zoneType.toUpperCase()} {priceFmt(o.pair, o.zoneLow)}–{priceFmt(o.pair, o.zoneHigh)} · entry {priceFmt(o.pair, o.entry)} · SL {priceFmt(o.pair, o.sl)} · TP {priceFmt(o.pair, o.tp)} · risk {pipsBetween(o.pair, o.entry, o.sl).toFixed(0)} pips
        </div>
        <div className="font-mono">Status: {statusText(o, o.pair)} <span className="text-muted-foreground">({fmtUtc(o.statusAt)} UTC)</span></div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Checked on your chart?</span>
          {(["right", "wrong"] as const).map((v) => (
            <button key={v} type="button" disabled={fb.isPending}
              onClick={() => fb.mutate({ o, verdict: v, note: v === "wrong" ? (window.prompt("What looks wrong? (optional — helps me fix it)") ?? undefined) : undefined })}
              className={`px-2 h-6 border text-[10px] ${verdict === v ? (v === "right" ? "border-success bg-success/15 text-success" : "border-destructive bg-destructive/15 text-destructive") : "border-border text-muted-foreground hover:bg-muted/40"}`}>
              {v === "right" ? "✓ Looks right" : "✗ Wrong"}
            </button>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-2 mt-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-info">V3 Shadow — pretend orders, never sent</span>
        <span className="text-[10px] text-muted-foreground">{active.length} active · {done.length} finished</span>
      </div>
      {q.isLoading && <p className="text-[10px] text-muted-foreground">Loading…</p>}
      {!q.isLoading && !active.length && <p className="text-[10px] text-muted-foreground">No active shadow orders. Each hour's reasoning is in the V3 Story under the Zone Story.</p>}
      {active.map(card)}
      {done.length > 0 && (
        <button type="button" className="text-[10px] text-muted-foreground underline" onClick={() => setShowDone(!showDone)}>
          {showDone ? "Hide" : "Show"} finished shadow orders ({done.length})
        </button>
      )}
      {showDone && done.slice(0, 30).map(card)}
    </div>
  );
}

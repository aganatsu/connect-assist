/**
 * V3 STORY — the Impulse-on-V3 shadow's latest hourly decision for one pair, shown under the Zone Story (owner-approved wording,
 * 2026-10-26). Every price comes with its time so it can be plotted. Renders nothing while the switch is OFF / no shadow data.
 */
import { useQuery } from "@tanstack/react-query";
import { latestDecision, recentEvents, foldOrders, reasonText, statusText, fmtUtc, pipsBetween, priceFmt, structureModeApi } from "@/lib/structureMode";

export function V3StoryPanel({ symbol }: { symbol: string }) {
  const mode = useQuery({ queryKey: ["structure-mode"], queryFn: structureModeApi.status, staleTime: 60_000 });
  const on = mode.data && mode.data.mode !== "OFF";
  const q = useQuery({
    queryKey: ["v3-story", symbol],
    enabled: !!on,
    refetchInterval: 120_000,
    queryFn: async () => {
      const d = await latestDecision(symbol);
      const ev = d ? await recentEvents(new Date(Date.parse(d.t) - 2 * 86_400_000).toISOString(), symbol) : [];
      return { d, order: foldOrders(ev)[0] ?? null };
    },
  });
  if (!on || !q.data?.d) return null;
  const { d, order } = q.data, leg = d.leg, bull = leg?.trend === "bull";
  const P = leg?.swing_price ?? null, X = leg?.extreme_price ?? null;
  const mid = P != null && X != null ? (P + X) / 2 : null;
  const pricePct = P != null && X != null && d.price != null && P !== X ? ((d.price - X) / (P - X)) * 100 : null;
  const row = (label: string, body: React.ReactNode) => (
    <div className="flex gap-2"><span className="w-28 shrink-0 text-muted-foreground">{label}</span><span className="min-w-0">{body}</span></div>
  );

  return (
    <div className="border border-info/30 bg-info/5 p-2 space-y-1 text-[10px] font-mono">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-zinc-200 uppercase tracking-wider">V3 Story · Shadow</span>
        <span className="text-muted-foreground">{symbol} · 1H · as of {fmtUtc(d.t)} UTC</span>
      </div>
      {!leg?.trend ? row("Trend", reasonText(d.reason)) : (
        <>
          {row("Trend", <span className={bull ? "text-success font-bold" : "text-destructive font-bold"}>{bull ? "BULLISH" : "BEARISH"}</span>)}
          {row("Leg", <>from swing {bull ? "low" : "high"} {priceFmt(symbol, P)} ({fmtUtc(leg.swing_time)}) {bull ? "up to highest high" : "down to lowest low"} {priceFmt(symbol, X)} ({fmtUtc(leg.extreme_time)}){P != null && X != null ? ` · ${pipsBetween(symbol, P, X).toFixed(1)} pips` : ""}</>)}
          {row("Trend flips if", <>a candle closes {bull ? "below" : "above"} {priceFmt(symbol, P)}</>)}
          {pricePct != null && row("Price now", <>{priceFmt(symbol, d.price)} · {pricePct.toFixed(0)}% {bull ? "down from the high" : "up from the low"} ({(pricePct >= 50) === bull ? "in discount" : "in premium"})</>)}
          {mid != null && row("Area of interest", <>{bull ? "discount" : "premium"} half of the leg: {priceFmt(symbol, Math.min(mid, P!))} – {priceFmt(symbol, Math.max(mid, P!))}</>)}
          {row("Zone", d.zone ? <>{d.zone.type.toUpperCase()} {priceFmt(symbol, d.zone.low)}–{priceFmt(symbol, d.zone.high)}{d.zone.fibDepth != null ? ` · ${(d.zone.fibDepth * 100).toFixed(0)}% retracement` : ""}{d.reason === "placed" || d.reason === "same_level_kept" ? " · best ranked" : ` · ${reasonText(d.reason)}`}</> : <>none — {reasonText(d.reason)}</>)}
          {d.order_plan && row("Order", <>{d.dir === "long" ? "BUY" : "SELL"} LIMIT {priceFmt(symbol, d.order_plan.entry)} · SL {priceFmt(symbol, d.order_plan.sl)} ({d.dir === "long" ? "below the swing low" : "above the swing high"}) · TP {priceFmt(symbol, d.order_plan.tp)} · risk {d.order_plan.riskPips.toFixed(0)} pips</>)}
          {order && row("Status", <>{statusText(order, symbol)} <span className="text-muted-foreground">({fmtUtc(order.statusAt)} UTC{order.status === "watching" || order.status === "in_zone" ? ` · expires ${fmtUtc(new Date(Date.parse(order.placedAt) + 8 * 3_600_000).toISOString())}` : ""})</span></>)}
          {row("4H trend", d.ctx4h ? <>{d.ctx4h === "bull" ? "BULLISH" : "BEARISH"} ({(d.ctx4h === "bull") === bull ? "agrees" : "against"})</> : "—")}
        </>
      )}
    </div>
  );
}

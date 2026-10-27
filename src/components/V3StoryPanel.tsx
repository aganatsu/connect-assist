/**
 * V3 STORY — the Impulse-on-V3 shadows' latest hourly decisions for one pair, shown under the Zone Story (owner-approved wording,
 * 2026-10-26). Two legs side by side: Big leg (A) = V3's external leg; Scalp leg (B) = V3's outer internal leg (owner approval
 * 2026-10-27). Every price comes with its time so it can be plotted. Renders nothing while the switch is OFF / no shadow data.
 */
import { useQuery } from "@tanstack/react-query";
import { latestDecision, recentEvents, foldOrders, reasonText, statusText, fmtUtc, pipsBetween, priceFmt, structureModeApi, ARM_LABEL, type ShadowArm, type ShadowDecision, type ShadowOrder } from "@/lib/structureMode";

const row = (label: string, body: React.ReactNode) => (
  <div className="flex gap-2"><span className="w-28 shrink-0 text-muted-foreground">{label}</span><span className="min-w-0">{body}</span></div>
);

function ArmBlock({ symbol, arm, d, order }: { symbol: string; arm: ShadowArm; d: ShadowDecision | null; order: ShadowOrder | null }) {
  if (!d) return <div className="pt-1"><span className="text-[10px] font-semibold text-info">{ARM_LABEL[arm]}</span> <span className="text-muted-foreground">— no decision yet</span></div>;
  const leg = d.leg, bull = leg?.trend === "bull";
  const P = leg?.swing_price ?? null, X = leg?.extreme_price ?? null;
  const mid = P != null && X != null ? (P + X) / 2 : null;
  const pricePct = P != null && X != null && d.price != null && P !== X ? ((d.price - X) / (P - X)) * 100 : null;
  return (
    <div className="pt-1 space-y-0.5 border-t border-info/20">
      <div className="text-[10px] font-semibold text-info">{ARM_LABEL[arm]}</div>
      {!leg?.trend ? row("Leg", reasonText(d.reason, d.dir)) : (
        <>
          {row("Leg", <>from swing {bull ? "low" : "high"} {priceFmt(symbol, P)} ({fmtUtc(leg.swing_time)}) {bull ? "up to highest high" : "down to lowest low"} {priceFmt(symbol, X)} ({fmtUtc(leg.extreme_time)}){P != null && X != null ? ` · ${pipsBetween(symbol, P, X).toFixed(1)} pips` : ""}</>)}
          {row(arm === "A" ? "Trend flips if" : "Leg breaks if", <>a candle closes {bull ? "below" : "above"} {priceFmt(symbol, P)}</>)}
          {pricePct != null && row("Price now", <>{priceFmt(symbol, d.price)} · {pricePct.toFixed(0)}% {bull ? "down from the high" : "up from the low"} ({(pricePct >= 50) === bull ? "in discount" : "in premium"})</>)}
          {mid != null && row("Area of interest", <>{bull ? "discount" : "premium"} half of the leg: {priceFmt(symbol, Math.min(mid, P!))} – {priceFmt(symbol, Math.max(mid, P!))}</>)}
          {row("Zone", d.zone ? <>{d.zone.type.toUpperCase()} {priceFmt(symbol, d.zone.low)}–{priceFmt(symbol, d.zone.high)}{d.zone.fibDepth != null ? ` · ${(d.zone.fibDepth * 100).toFixed(0)}% retracement` : ""}{d.reason === "placed" || d.reason === "same_level_kept" ? " · best ranked" : ` · ${reasonText(d.reason, d.dir)}`}</> : <>none — {reasonText(d.reason, d.dir)}</>)}
          {d.order_plan && row("Order", <>{d.dir === "long" ? "BUY" : "SELL"} LIMIT {priceFmt(symbol, d.order_plan.entry)} · SL {priceFmt(symbol, d.order_plan.sl)} ({d.dir === "long" ? "below the swing low" : "above the swing high"}) · TP {priceFmt(symbol, d.order_plan.tp)} · risk {d.order_plan.riskPips.toFixed(0)} pips</>)}
          {order && row("Status", <>{statusText(order, symbol)} <span className="text-muted-foreground">({fmtUtc(order.statusAt)} UTC{order.status === "watching" || order.status === "in_zone" ? ` · expires ${fmtUtc(new Date(Date.parse(order.placedAt) + 8 * 3_600_000).toISOString())}` : ""})</span></>)}
        </>
      )}
    </div>
  );
}

export function V3StoryPanel({ symbol }: { symbol: string }) {
  const mode = useQuery({ queryKey: ["structure-mode"], queryFn: structureModeApi.status, staleTime: 60_000 });
  const on = mode.data && mode.data.mode !== "OFF";
  const q = useQuery({
    queryKey: ["v3-story", symbol],
    enabled: !!on,
    refetchInterval: 120_000,
    queryFn: async () => {
      const [a, b] = await Promise.all([latestDecision(symbol, "A"), latestDecision(symbol, "B")]);
      const t = a?.t ?? b?.t;
      const orders = t ? foldOrders(await recentEvents(new Date(Date.parse(t) - 2 * 86_400_000).toISOString(), symbol)) : [];
      return { a, b, orderA: orders.find((o) => o.arm === "A") ?? null, orderB: orders.find((o) => o.arm === "B") ?? null };
    },
  });
  if (!on || !(q.data?.a || q.data?.b)) return null;
  const { a, b, orderA, orderB } = q.data, head = a ?? b!, trend = head.leg?.trend;
  return (
    <div className="border border-info/30 bg-info/5 p-2 space-y-1 text-[10px] font-mono">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-zinc-200 uppercase tracking-wider">V3 Story · Shadow</span>
        <span className="text-muted-foreground">{symbol} · 1H · as of {fmtUtc(head.t)} UTC</span>
      </div>
      {row("Trend", trend ? <span className={trend === "bull" ? "text-success font-bold" : "text-destructive font-bold"}>{trend === "bull" ? "BULLISH" : "BEARISH"}</span> : reasonText(head.reason, head.dir))}
      {row("4H trend", head.ctx4h ? <>{head.ctx4h === "bull" ? "BULLISH" : "BEARISH"}{trend ? ` (${(head.ctx4h === "bull") === (trend === "bull") ? "agrees" : "against"})` : ""}</> : "—")}
      <ArmBlock symbol={symbol} arm="A" d={a} order={orderA} />
      <ArmBlock symbol={symbol} arm="B" d={b} order={orderB} />
    </div>
  );
}

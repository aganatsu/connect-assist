/**
 * BREAKERS · Shadow — Unified zones that price closed through, flipped to the other side, and the pretend trades recorded for them
 * (Bot Config → "Breaker Shadow"). Shown under the Zone Story. Renders nothing when there are no breaker records for the pair.
 */
import { useQuery } from "@tanstack/react-query";
import { breakerEvents, breakerTotals, foldBreakers, BREAKER_ARM_LABEL, BREAKER_REASON, type BreakerArm, type BreakerArmView, type BreakerZoneView } from "@/lib/breakerShadow";
import { fmtUtc, priceFmt } from "@/lib/structureMode";

const row = (label: string, body: React.ReactNode) => (
  <div className="flex gap-2"><span className="w-28 shrink-0 text-muted-foreground">{label}</span><span className="min-w-0">{body}</span></div>
);
const side = (d: "long" | "short") => (d === "long" ? "BUY" : "SELL");

function armText(symbol: string, z: BreakerZoneView, a: BreakerArmView): React.ReactNode {
  const s = side(z.flip!.dir);
  switch (a.status) {
    case "waiting": return <>waiting for price to come back to {priceFmt(symbol, z.flip!.E)}</>;
    case "in_zone": return <>price is back at the zone — waiting for a 5m confirmation <span className="text-muted-foreground">({fmtUtc(a.t)} UTC)</span></>;
    case "open": return <>pretend {s} filled at {priceFmt(symbol, a.fill)} <span className="text-muted-foreground">({fmtUtc(a.fillT)} UTC)</span> · open</>;
    case "closed": return <span className={a.result === "TP" ? "text-success" : "text-destructive"}>pretend {s} {a.result === "TP" ? "hit target" : "hit stop"} · {a.net != null ? `${a.net > 0 ? "+" : ""}${a.net.toFixed(2)}R net` : ""} <span className="text-muted-foreground">({fmtUtc(a.t)} UTC)</span></span>;
    case "skipped": return <>skipped — {BREAKER_REASON[a.reason ?? ""] ?? a.reason}</>;
    case "cancelled": return <>no entry — {BREAKER_REASON[a.reason ?? ""] ?? a.reason} <span className="text-muted-foreground">({fmtUtc(a.t)} UTC)</span></>;
  }
}

export function BreakerStoryPanel({ symbol }: { symbol: string }) {
  const q = useQuery({
    queryKey: ["breaker-story", symbol],
    refetchInterval: 120_000,
    queryFn: async () => {
      const all = await breakerEvents(symbol, null);
      const since = new Date(Date.now() - 3 * 86_400_000).toISOString();
      const zones = foldBreakers(all).filter((z) => z.flip!.at >= since || ["waiting", "in_zone", "open"].includes(z.arms.C.status) || ["waiting", "in_zone", "open"].includes(z.arms.L.status));
      return { zones: zones.slice(0, 5), totals: breakerTotals(all), any: all.length > 0 };
    },
  });
  if (!q.data?.any) return null;
  const { zones, totals } = q.data;
  return (
    <div className="border border-warning/30 bg-warning/5 p-2 space-y-1 text-[10px] font-mono">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-zinc-200 uppercase tracking-wider">Breakers · Shadow</span>
        <span className="text-muted-foreground">{symbol} · pretend trades, never sent</span>
      </div>
      {!zones.length && <div className="text-muted-foreground">No Unified zone has flipped in the last 3 days.</div>}
      {zones.map((z) => (
        <div key={z.zoneId} className="pt-1 space-y-0.5 border-t border-warning/20">
          {row("Broken zone", <>{side(z.dir)} {z.zoneType ? z.zoneType.toUpperCase() + " " : ""}{Number.isFinite(z.zl) ? `${priceFmt(symbol, z.zl)}–${priceFmt(symbol, z.zh)}` : ""} · a {z.flip!.tfMin === 30 ? "30-minute" : `${z.flip!.tfMin}m`} candle closed {z.dir === "long" ? "below" : "above"} it at {fmtUtc(z.flip!.at)} UTC</>)}
          {row("Now a", <span className={z.flip!.dir === "long" ? "text-success font-bold" : "text-destructive font-bold"}>{side(z.flip!.dir)} zone</span>)}
          {row("Plan", <>entry {priceFmt(symbol, z.flip!.E)} · stop {priceFmt(symbol, z.flip!.S)} · target {priceFmt(symbol, z.flip!.T)} (1.5R) · valid until {fmtUtc(new Date(Date.parse(z.flip!.at) + 48 * 3_600_000).toISOString())} UTC</>)}
          {(["C", "L"] as BreakerArm[]).map((arm) => row(BREAKER_ARM_LABEL[arm], armText(symbol, z, z.arms[arm])))}
        </div>
      ))}
      <div className="pt-1 border-t border-warning/20 text-muted-foreground">
        So far on {symbol}: {(["C", "L"] as BreakerArm[]).map((arm) => `${BREAKER_ARM_LABEL[arm].toLowerCase()} ${totals[arm].n} closed, ${totals[arm].tp} at target, ${totals[arm].netR >= 0 ? "+" : ""}${totals[arm].netR.toFixed(2)}R`).join(" · ")}.
        {" "}The 5-minute version of this rule lost on past data (−0.13R a trade after costs); this 30-minute version is untested, which is why it is recorded, not traded.
      </div>
    </div>
  );
}

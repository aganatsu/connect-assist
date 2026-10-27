/**
 * Bot Config → Strategy → "Structure engine (V3)": the OFF / SHADOW / ON switch (Impulse-on-V3, owner decisions 2026-10-26).
 * Saved immediately through the structure-mode function — NOT part of the bot config (so SHADOW does not start a new cohort).
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Lock } from "lucide-react";
import { structureModeApi, fmtUtc, ARM_LABEL, type ShadowArm, type StructureMode } from "@/lib/structureMode";
import { brokerPriceSummary } from "@/lib/brokerPriceLog";

const DESCRIPTIONS: Record<StructureMode, string> = {
  OFF: "The bot trades exactly as now (Impulse structure). Nothing V3-related runs.",
  SHADOW: "The bot still trades exactly as now. Beside it, V3 records what it WOULD do — see the V3 Story under each Zone Story and the V3 Shadow section in Pending Orders. No real orders.",
  ON: "The bot trades V3 structure for real: each hour it places the shadow's decision for the chosen leg as a Route 2 order (your account rules still apply). Starts a new cohort; drops back to SHADOW automatically at −8R.",
};

export function StructureEngineSection() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["structure-mode"], queryFn: structureModeApi.status, refetchInterval: 60_000 });
  const setMode = useMutation({
    mutationFn: (a: { m: StructureMode; arm?: ShadowArm }) => structureModeApi.set(a.m, a.arm),
    onSuccess: (r, a) => {
      if (r?.error) { toast.error(r.error); return; }
      toast.success(`Structure engine: ${a.m}${a.arm ? ` · ${ARM_LABEL[a.arm]}` : ""}${r?.cancelledOrders ? ` — ${r.cancelledOrders} pending order(s) cancelled` : ""}`);
      qc.invalidateQueries({ queryKey: ["structure-mode"] });
      qc.invalidateQueries({ queryKey: ["v3-story"] });
      qc.invalidateQueries({ queryKey: ["v3-shadow-orders"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const s = status.data, mode: StructureMode = s?.mode ?? "OFF";
  // Broker vs bot (step 4c, S3 = measure first): last 7 days of MT5 copies, every mirrored trade (Impulse and V3)
  const broker = useQuery({ queryKey: ["broker-price-summary"], queryFn: () => brokerPriceSummary(new Date(Date.now() - 7 * 86_400_000).toISOString()), refetchInterval: 300_000 });
  const v3Age = s?.v3LatestClose ? (Date.now() - Date.parse(s.v3LatestClose)) / 3_600_000 : null;

  return (
    <div className="space-y-2 p-3 border border-border">
      <div>
        <p className="text-xs font-medium">Structure engine (V3)</p>
        <p className="text-[10px] text-muted-foreground mt-0.5">
          Which structure the bot reads. Saved instantly, separate from the settings below — switching to SHADOW does not change your config version.
        </p>
      </div>
      <div className="flex gap-0 border border-border w-fit">
        {(["OFF", "SHADOW", "ON"] as StructureMode[]).map((m) => {
          const locked = m === "ON" && mode !== "ON" && !(s?.unlock.met && s?.unlock.onAvailable);
          const active = mode === m;
          return (
            <button
              key={m}
              type="button"
              disabled={locked || active || setMode.isPending || status.isLoading}
              title={locked ? s?.unlock.reason : DESCRIPTIONS[m]}
              onClick={() => {
                if (m !== "ON") { setMode.mutate({ m }); return; }
                const pick = window.prompt(`Switch to ON — which leg should the bot trade?\n\nA = Big leg (${s?.rightA ?? 0} setups marked ✓)\nB = Scalp leg (${s?.rightB ?? 0} setups marked ✓)\n\nType A or B. Your Impulse pending orders on the V3 pairs are cancelled (open positions keep running) and a new cohort starts.`);
                const arm = pick?.trim().toUpperCase();
                if (arm !== "A" && arm !== "B") { if (pick !== null) toast.error("Type A or B"); return; }
                setMode.mutate({ m, arm });
              }}
              className={`px-4 h-8 text-[11px] font-semibold tracking-wider border-r last:border-r-0 border-border flex items-center gap-1 ${
                active ? (m === "OFF" ? "bg-muted text-foreground" : m === "SHADOW" ? "bg-info/15 text-info" : "bg-success/15 text-success") : "text-muted-foreground hover:bg-muted/40"
              } ${locked ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              {locked && <Lock className="h-3 w-3" />}{m}
            </button>
          );
        })}
      </div>
      <p className="text-[10px] text-muted-foreground">{DESCRIPTIONS[mode]}{mode === "ON" && s?.arm ? ` Trading: ${ARM_LABEL[s.arm]}${s.onSince ? ` since ${fmtUtc(s.onSince)} UTC` : ""}.` : ""}</p>
      {s?.killReason && mode !== "ON" && <p className="text-[10px] text-destructive">ON stopped automatically: {s.killReason}</p>}
      {status.isError && <p className="text-[10px] text-destructive">Could not load the switch status.</p>}
      {s && (
        <div className="text-[10px] font-mono text-muted-foreground space-y-0.5">
          <div>V3 data: last 1H close {fmtUtc(s.v3LatestClose)} UTC{v3Age != null && v3Age > 2.5 ? " — not fresh (weekend, or check the V3 state service)" : ""}</div>
          {mode !== "OFF" && <div>{mode} since {fmtUtc(s.setAt)} UTC ({s.unlock.daysInShadow.toFixed(1)} days)</div>}
          {([["Big leg (A)", s.summary], ["Scalp leg (B)", s.summaryB]] as const).map(([label, sm]) => sm && (
            <div key={label}>
              {label}: {sm.placed} orders · {sm.filled} filled · {sm.wins} TP / {sm.losses} SL · {sm.open} open
              {sm.voided ? ` · ${sm.voided} void (data gap)` : ""} · net {sm.netR > 0 ? "+" : ""}{sm.netR.toFixed(2)}R
            </div>
          ))}
          {mode !== "ON" && <div>ON: {s.unlock.reason} · setups marked ✓: big leg {s.rightA ?? 0}, scalp leg {s.rightB ?? 0}</div>}
        </div>
      )}
      {broker.data && (
        <div className="text-[10px] font-mono text-muted-foreground space-y-0.5 pt-1 border-t border-border">
          <div className="font-sans">
            Broker vs bot, last 7 days (all trades copied to MT5). Slippage in pips, + = MT5 got the worse price. "MT5 closed first" = MT5 shut the trade before the bot did; rollover = 20:50–21:30 UTC.
          </div>
          {broker.data.length === 0 && <div>No MT5 copies recorded yet.</div>}
          {broker.data.map((b) => (
            <div key={b.symbol}>
              {b.symbol}: {b.fills} copied{b.v3 ? ` (${b.v3} V3)` : ""}{b.avgEntrySlip != null ? `, entry ${b.avgEntrySlip > 0 ? "+" : ""}${b.avgEntrySlip}p` : ""}
              {b.noCopy ? ` · ${b.noCopy} not copied` : ""} · {b.closes} closed{b.avgCloseSlip != null ? `, exit ${b.avgCloseSlip > 0 ? "+" : ""}${b.avgCloseSlip}p` : ""}
              {b.brokerFirst ? ` · MT5 closed first ${b.brokerFirst} (${b.brokerFirstRollover} at rollover)` : ""}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

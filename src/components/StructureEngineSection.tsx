/**
 * Bot Config → Strategy → "Structure engine (V3)": the OFF / SHADOW / ON switch (Impulse-on-V3, owner decisions 2026-10-26).
 * Saved immediately through the structure-mode function — NOT part of the bot config (so SHADOW does not start a new cohort).
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Lock } from "lucide-react";
import { structureModeApi, fmtUtc, type StructureMode } from "@/lib/structureMode";

const DESCRIPTIONS: Record<StructureMode, string> = {
  OFF: "The bot trades exactly as now (Impulse structure). Nothing V3-related runs.",
  SHADOW: "The bot still trades exactly as now. Beside it, V3 records what it WOULD do — see the V3 Story under each Zone Story and the V3 Shadow section in Pending Orders. No real orders.",
  ON: "The bot uses V3 structure for real (V3 trend + leg, Impulse zone inside it, Route 2 order). Starts a new cohort.",
};

export function StructureEngineSection() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["structure-mode"], queryFn: structureModeApi.status, refetchInterval: 60_000 });
  const setMode = useMutation({
    mutationFn: (m: StructureMode) => structureModeApi.set(m),
    onSuccess: (r, m) => {
      if (r?.error) { toast.error(r.error); return; }
      toast.success(`Structure engine: ${m}`);
      qc.invalidateQueries({ queryKey: ["structure-mode"] });
      qc.invalidateQueries({ queryKey: ["v3-story"] });
      qc.invalidateQueries({ queryKey: ["v3-shadow-orders"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const s = status.data, mode: StructureMode = s?.mode ?? "OFF";
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
                if (m === "ON" && !window.confirm("Switch to ON? The bot will trade V3 structure on this account, and a new cohort starts.")) return;
                setMode.mutate(m);
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
      <p className="text-[10px] text-muted-foreground">{DESCRIPTIONS[mode]}</p>
      {status.isError && <p className="text-[10px] text-destructive">Could not load the switch status.</p>}
      {s && (
        <div className="text-[10px] font-mono text-muted-foreground space-y-0.5">
          <div>V3 data: last 1H close {fmtUtc(s.v3LatestClose)} UTC{v3Age != null && v3Age > 2.5 ? " — not fresh (weekend, or check the V3 state service)" : ""}</div>
          {mode !== "OFF" && <div>{mode} since {fmtUtc(s.setAt)} UTC ({s.unlock.daysInShadow.toFixed(1)} days)</div>}
          {s.summary && (
            <div>
              Shadow: {s.summary.placed} orders · {s.summary.filled} filled · {s.summary.wins} TP / {s.summary.losses} SL · {s.summary.open} open
              {s.summary.voided ? ` · ${s.summary.voided} void (data gap)` : ""} · net {s.summary.netR > 0 ? "+" : ""}{s.summary.netR.toFixed(2)}R
            </div>
          )}
          {mode !== "ON" && <div>ON: {s.unlock.reason} · setups marked ✓: {s.unlock.right}</div>}
        </div>
      )}
    </div>
  );
}

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type Setup = { outcome_status: string; raw_detail?: Record<string, any> | null };

export function StructureAuthorityEvidenceCard({ setups }: { setups: Setup[] }) {
  const records = setups.flatMap((setup) => {
    const decision = setup.raw_detail?.canonicalStructureDecision;
    const structure = setup.raw_detail?.canonicalStructureAuthority;
    const liquidity = setup.raw_detail?.canonicalLiquiditySequence;
    return decision?.contractVersion === "canonical-structure-decision.v1" ? [{ setup, decision, structure, liquidity }] : [];
  });
  const resolved = records.filter(({ setup }) => ["would_have_won", "would_have_lost"].includes(setup.outcome_status));
  const count = (value: string) => records.filter(({ decision }) => decision.decision === value).length;
  const eventCount = (value: string) => records.reduce((sum, { structure }) => sum + (structure?.events || []).filter((event: any) => event.type === value).length, 0);
  const allowedWins = resolved.filter(({ setup, decision }) => decision.decision === "allow" && setup.outcome_status === "would_have_won").length;
  const allowedLosses = resolved.filter(({ setup, decision }) => decision.decision === "allow" && setup.outcome_status === "would_have_lost").length;
  return <Card className="border-cyan-500/30">
    <CardHeader className="px-4 pb-2 pt-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><CardTitle className="text-sm font-medium">Market Structure Authority Evidence</CardTitle><p className="mt-1 text-[10px] text-muted-foreground">Frozen swings, liquidity sweeps, BOS, CHoCH and MSS evaluated as one ordered decision sequence.</p></div><Badge variant="outline" className="border-cyan-500/40 text-[9px] text-cyan-400">{records.length}/{setups.length} comparable</Badge></div></CardHeader>
    <CardContent className="space-y-3 px-4 pb-4">
      <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4 xl:grid-cols-8">
        <div><span className="text-muted-foreground">Allow</span><p className="font-mono font-bold text-success">{count("allow")}</p></div>
        <div><span className="text-muted-foreground">Watch</span><p className="font-mono font-bold text-warning">{count("watch")}</p></div>
        <div><span className="text-muted-foreground">Block</span><p className="font-mono font-bold text-destructive">{count("block")}</p></div>
        <div><span className="text-muted-foreground">Sweeps</span><p className="font-mono font-bold">{eventCount("sweep")}</p></div>
        <div><span className="text-muted-foreground">BOS</span><p className="font-mono font-bold">{eventCount("bos")}</p></div>
        <div><span className="text-muted-foreground">CHoCH</span><p className="font-mono font-bold">{eventCount("choch")}</p></div>
        <div><span className="text-muted-foreground">MSS</span><p className="font-mono font-bold">{eventCount("mss")}</p></div>
        <div><span className="text-muted-foreground">Allowed W/L</span><p className="font-mono font-bold">{allowedWins}/{allowedLosses}</p></div>
      </div>
      {records.length === 0 && <p className="text-[10px] text-muted-foreground">Existing history predates the structure contract. Evidence will populate from new scans after deployment.</p>}
      <p className="text-[10px] text-muted-foreground">Observe mode records this comparison only. Enforcement is controlled by Trade Decision Mode and Market Structure Authority in Bot Config.</p>
    </CardContent>
  </Card>;
}

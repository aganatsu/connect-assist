import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Download } from "lucide-react";

export interface AuthorityOutcomeReport {
  contractVersion: string;
  summary: { sampleSize: number; complete: number; historicalCompatible: number; unavailable: number; resolved: number; winnersPreserved: number; winnersBlockedOrWatched: number; poorEntriesRejected: number; poorEntriesWatched: number; poorEntriesAllowed: number };
  components: Array<{ role: string; resolved: number; passed: number; failed: number; wins: number; losses: number; winRate: number | null; expectancyR: number | null }>;
  rows: Array<{ id: string; source: string; symbol: string; direction: string; observedAt: string; outcome: string; outcomeR: number | null; stage: string | null; decision: string | null; explanation: string | null; evidenceQuality: string; authorities: unknown[] }>;
}

const label = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

export function AuthorityOutcomeResearchCard({ report, loading }: { report?: AuthorityOutcomeReport; loading: boolean }) {
  const download = () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `ict-decision-evidence-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return <Card className="border-cyan-500/35">
    <CardHeader className="px-4 pb-2 pt-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div><CardTitle className="text-sm font-medium">ICT Decision Evidence vs Outcome</CardTitle><p className="mt-1 text-[10px] text-muted-foreground">Measures the actual trading authorities. Legacy scores are excluded from authorization and shown separately as diagnostic research.</p></div>
        <div className="flex items-center gap-2"><Badge variant="outline" className="text-[9px] border-cyan-500/40 text-cyan-400">{loading ? "Loading" : `${report?.summary.resolved || 0} resolved`}</Badge><Button type="button" size="sm" variant="outline" className="h-7 px-2 text-[10px]" disabled={!report} onClick={download}><Download className="mr-1 h-3 w-3" />Dataset</Button></div>
      </div>
    </CardHeader>
    <CardContent className="space-y-4 px-4 pb-4">
      {loading ? <div className="py-8 text-center text-sm text-muted-foreground">Loading authority outcomes...</div> : report ? <>
        <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4 xl:grid-cols-7">
          <div><span className="text-muted-foreground">Complete evidence</span><p className="font-mono font-bold">{report.summary.complete}</p></div>
          <div><span className="text-muted-foreground">Compatible history</span><p className="font-mono font-bold">{report.summary.historicalCompatible}</p></div>
          <div><span className="text-muted-foreground">Winners preserved</span><p className="font-mono font-bold text-success">{report.summary.winnersPreserved}</p></div>
          <div><span className="text-muted-foreground">Winners blocked/watched</span><p className="font-mono font-bold text-warning">{report.summary.winnersBlockedOrWatched}</p></div>
          <div><span className="text-muted-foreground">Losses rejected</span><p className="font-mono font-bold text-success">{report.summary.poorEntriesRejected}</p></div>
          <div><span className="text-muted-foreground">Losses watched</span><p className="font-mono font-bold text-warning">{report.summary.poorEntriesWatched}</p></div>
          <div><span className="text-muted-foreground">Losses allowed</span><p className="font-mono font-bold text-destructive">{report.summary.poorEntriesAllowed}</p></div>
        </div>
        <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left text-[10px]"><thead className="text-muted-foreground"><tr className="border-b border-border/50"><th className="py-2 pr-3">Authority</th><th>Resolved</th><th>Passed</th><th>Failed</th><th>Win rate</th><th>Expectancy</th></tr></thead><tbody>{report.components.map((item) => <tr key={item.role} className="border-b border-border/20"><td className="py-2 pr-3 font-medium">{label(item.role)}</td><td>{item.resolved}</td><td>{item.passed}</td><td>{item.failed}</td><td>{item.winRate == null ? "-" : `${item.winRate.toFixed(1)}%`}</td><td>{item.expectancyR == null ? "-" : `${item.expectancyR >= 0 ? "+" : ""}${item.expectancyR.toFixed(2)}R`}</td></tr>)}</tbody></table></div>
        {report.summary.unavailable > 0 && <p className="text-[10px] text-muted-foreground">{report.summary.unavailable} older records lack stored authority evidence and are excluded. They are not reconstructed from current settings.</p>}
      </> : <div className="py-8 text-center text-sm text-muted-foreground">Authority outcome evidence is unavailable.</div>}
    </CardContent>
  </Card>;
}

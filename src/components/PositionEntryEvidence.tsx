/* eslint-disable @typescript-eslint/no-explicit-any */
import { ZoneStoryPanel } from "@/components/ZoneStoryPanel";
import { ImpulseZonePanel } from "@/components/ImpulseZonePanel";
import { formatPrice } from "@/lib/formatTime";
import { getPositionEntryEvidence } from "@/lib/positionEvidence";

interface PositionEntryEvidenceProps {
  position: any;
  minZoneScore?: number;
}

const text = (value: unknown): string | null => {
  if (value == null || value === "") return null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
};

const shortId = (value: unknown): string | null => {
  const raw = text(value);
  return raw && raw.length > 12 ? `${raw.slice(0, 8)}…` : raw;
};

const verdictDirection = (verdict: any): string | null =>
  text(verdict?.verdict ?? verdict?.direction ?? verdict?.result)?.toUpperCase() ?? null;

const authorizationAllowed = (auth: any): boolean | null => {
  const value = auth?.allowed ?? auth?.authorized ?? auth?.isAuthorized ?? auth?.result?.allowed;
  return typeof value === "boolean" ? value : null;
};

const thesisStatus = (thesis: any): { label: string; good: boolean | null } => {
  const value = thesis?.valid ?? thesis?.isValid ?? thesis?.allowed ?? thesis?.passed;
  if (typeof value === "boolean") return { label: value ? "VALID" : "INVALID", good: value };
  const status = text(thesis?.status ?? thesis?.verdict);
  return { label: status?.toUpperCase() ?? "RECORDED", good: status ? !/invalid|fail|block/i.test(status) : null };
};

function EvidenceChip({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "good" | "bad" }) {
  const toneClass = tone === "good"
    ? "border-success/30 bg-success/10 text-success"
    : tone === "bad"
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : "border-border bg-secondary/40 text-foreground/80";
  return <span className={`rounded border px-2 py-1 text-[10px] font-mono ${toneClass}`}><span className="text-muted-foreground">{label}: </span>{value}</span>;
}

export function PositionEntryEvidence({ position, minZoneScore = 4 }: PositionEntryEvidenceProps) {
  const evidence = getPositionEntryEvidence(position);
  const { signal, zoneStory, impulseZone, originatingZone, directionVerdict, thesisValidation, finalAuthorization, entryConfirmation, canonicalDealingRange, frozenContext, stylePolicy } = evidence;
  const range = canonicalDealingRange?.range ?? canonicalDealingRange;
  const zone = originatingZone?.zone ?? originatingZone ?? impulseZone?.bestZone?.zone?.poi ?? impulseZone?.bestZone;
  const zoneLow = zone?.low ?? zone?.zoneLow;
  const zoneHigh = zone?.high ?? zone?.zoneHigh;
  const zoneType = text(zone?.type ?? zone?.zoneType ?? signal?.limitOrderOrigin?.zoneType);
  const zoneTimeframe = text(
    zoneStory?.selectedTF ?? impulseZone?.selectedTF ?? range?.timeframe ?? position.entryZoneTimeframe ?? position.canonicalDealingRangeTimeframe ?? signal?.entryTimeframe,
  );
  const verdict = verdictDirection(directionVerdict);
  const confidence = directionVerdict?.confidence;
  const thesis = thesisValidation ? thesisStatus(thesisValidation) : null;
  const allowed = finalAuthorization ? authorizationAllowed(finalAuthorization) : null;
  const route = text(position.entryRoute ?? position.orderType ?? signal?.entryMethod ?? (signal?.filledFromLimitOrder ? "route2_pending" : null));
  const style = text(position.tradingStyle ?? stylePolicy?.style ?? stylePolicy?.tradingStyle ?? frozenContext?.tradingStyle);
  const gamePlanVersion = shortId(position.gamePlanVersion ?? evidence.decisionContext?.gamePlan?.version ?? frozenContext?.gamePlan?.version);
  const candidateId = shortId(position.candidateId ?? frozenContext?.candidateId ?? signal?.candidateId);
  const frozenAt = text(position.policyFrozenAt ?? frozenContext?.frozenAt);
  const hasAnyEvidence = !!(zoneStory || impulseZone || originatingZone || directionVerdict || thesisValidation || finalAuthorization || entryConfirmation || frozenContext);

  return (
    <section className="rounded-lg border border-cyan-500/25 bg-cyan-500/[0.035] p-2.5 space-y-2" data-testid="position-entry-evidence">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-[11px] font-bold uppercase tracking-[1.5px] text-cyan-300">Trade Story at Entry</h3>
          <p className="text-[9px] text-muted-foreground">Frozen evidence for this trade—not the current market.</p>
        </div>
        <span className="rounded border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[9px] font-bold text-cyan-300">FROZEN AT ENTRY</span>
      </div>

      {zoneStory ? (
        <ZoneStoryPanel
          unifiedData={zoneStory as never}
          gateData={impulseZone as never}
          symbol={position.symbol}
          minZoneScore={minZoneScore}
          zoneGateBypassed={signal.signalSource === "unified"}
        />
      ) : impulseZone?.hasZone ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[9px] text-muted-foreground">Legacy entry evidence preserved by the older scanner.</p>
            <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[8px] font-bold text-amber-300">PARTIAL HISTORICAL RECORD</span>
          </div>
          <ImpulseZonePanel data={impulseZone as never} isLiveContext={false} />
        </div>
      ) : (
        <div className="rounded border border-border/60 bg-secondary/25 p-2 space-y-1">
          <div className="text-[10px] font-semibold text-foreground/80">Zone evidence</div>
          {(zoneType || zoneLow != null || zoneHigh != null || zoneTimeframe) ? (
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] font-mono">
              {zoneType && <span><span className="text-muted-foreground">Type:</span> {zoneType.toUpperCase()}</span>}
              {zoneTimeframe && <span><span className="text-muted-foreground">TF:</span> {zoneTimeframe}</span>}
              {zoneLow != null && zoneHigh != null && <span><span className="text-muted-foreground">Bounds:</span> {formatPrice(Number(zoneLow), position.symbol)}–{formatPrice(Number(zoneHigh), position.symbol)}</span>}
            </div>
          ) : (
            <p className="text-[10px] text-muted-foreground">A full Zone Story was not frozen on this legacy or manually opened trade.</p>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {verdict && <EvidenceChip label="Direction Verdict" value={`${verdict}${confidence != null ? ` ${Number(confidence).toFixed(0)}%` : ""}`} tone={verdict.toLowerCase() === position.direction ? "good" : "bad"} />}
        {thesis && <EvidenceChip label="Thesis" value={thesis.label} tone={thesis.good === true ? "good" : thesis.good === false ? "bad" : "neutral"} />}
        {allowed != null && <EvidenceChip label="Final Authority" value={allowed ? "AUTHORIZED" : "BLOCKED"} tone={allowed ? "good" : "bad"} />}
        {entryConfirmation && <EvidenceChip label="Confirmation" value={text(entryConfirmation.type ?? entryConfirmation.method ?? entryConfirmation.status)?.replace(/_/g, " ") ?? "RECORDED"} tone="good" />}
        {route && <EvidenceChip label="Entry Route" value={route.replace(/_/g, " ")} />}
        {zoneTimeframe && <EvidenceChip label="Zone TF" value={zoneTimeframe} />}
        {style && <EvidenceChip label="Style" value={style.replace(/_/g, " ")} />}
        {gamePlanVersion && <EvidenceChip label="Gameplan" value={gamePlanVersion} />}
        {candidateId && <EvidenceChip label="Candidate" value={candidateId} />}
        {evidence.zoneStorySource && <EvidenceChip label="Story Source" value={evidence.zoneStorySource.replace(/_/g, " ")} />}
        {frozenAt && <EvidenceChip label="Frozen" value={new Date(frozenAt).toLocaleString()} />}
      </div>

      {range && (range.low != null || range.high != null || range.midpoint != null || range.mid != null) && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-[10px] font-mono border-t border-border/30 pt-2">
          <div><span className="text-muted-foreground">Range low</span><div>{range.low != null ? formatPrice(Number(range.low), position.symbol) : "—"}</div></div>
          <div><span className="text-muted-foreground">Equilibrium</span><div>{range.midpoint != null || range.mid != null ? formatPrice(Number(range.midpoint ?? range.mid), position.symbol) : "—"}</div></div>
          <div><span className="text-muted-foreground">Range high</span><div>{range.high != null ? formatPrice(Number(range.high), position.symbol) : "—"}</div></div>
          <div><span className="text-muted-foreground">Location</span><div>{text(canonicalDealingRange?.classification ?? canonicalDealingRange?.location ?? canonicalDealingRange?.priceClassification)?.replace(/_/g, " ") ?? "—"}</div></div>
        </div>
      )}

      {!hasAnyEvidence && <p className="text-[9px] text-muted-foreground">This position predates entry-evidence capture. New scanner trades will include the complete record.</p>}
    </section>
  );
}


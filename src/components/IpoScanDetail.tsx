/**
 * Detail pane for one observed IPO. Phase C — READ-ONLY.
 *
 * Deliberately a separate component from the SMC `ScanDetailInline`. The two
 * strategies describe a setup with different vocabularies, and merging them
 * would mean a conditional in the SMC path that has to stay correct for both.
 *
 * STATES THE FROZEN RULES DO NOT COMPUTE ARE SHOWN AS "not tracked", not as
 * "no". `ipoLifecycle` implements suppression, clearance, touch and
 * invalidation; MOVE_AWAY, EXPANSION and TREND live in the research state
 * machine and are not part of the frozen population rules. Rendering them as a
 * definite "no" would be a quiet fabrication.
 */

import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  lifecycleChain, candidatePath, contractionNote, chainCoverage, GLOSSARY,
  type Stage, type StageStatus, type PathNode,
} from "@/lib/ipoLifecycle";

export interface IpoRow {
  instrument: string;
  timeframe: string;
  direction: "long" | "short";
  ipoCandleTime: string;
  ipoIndex: number;
  zoneHigh: number;
  zoneLow: number;
  midpoint: number;
  state: string;
  signalValid: boolean;
  validationStatus: string;
  observationStatus: string;
  fvgPresent: boolean;
  fvgStatus: string;
  contraction: string;
  touch: string;
  oppositeSideCleared: string;
  moveAway: string;
  expansion: string;
  trend: string;
  volatilityBucket: string;
  volatilityEligible: boolean;
  intendedEntry: number;
  target2R: number;
  s2Invalidation: number;
  riskPrice: number;
  sequencingState: string;
  executionEligible: boolean;
  reasonCodes: string[];
}

const px = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(2) : n.toFixed(5));

function Line({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5 border-b border-border/40">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={`text-[11px] font-mono ${tone ?? ""}`}>{value}</span>
    </div>
  );
}

const tri = (v: string) =>
  v === "YES" ? <span className="text-emerald-600">yes</span>
  : v === "NO" ? <span className="text-muted-foreground">no</span>
  : <span className="text-muted-foreground/60 italic">not tracked</span>;

/**
 * Status colour.
 *
 * NOT_TRACKED is dashed and grey on purpose: it must not read as a failure, and
 * it must not read as a pass. It means the engine does not compute the stage.
 */
const statusClass = (s: StageStatus) =>
  s === "COMPLETED" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-500 border-emerald-500/40"
  : s === "DETECTED" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-500 border-emerald-500/40"
  : s === "ACTIVE" ? "bg-primary/15 text-primary border-primary/50"
  : s === "FAILED" ? "bg-destructive/15 text-destructive border-destructive/40"
  : s === "SUPPRESSED" ? "bg-amber-500/15 text-amber-600 border-amber-500/40"
  : s === "NOT_TRACKED" ? "bg-muted text-muted-foreground/70 border-dashed border-border"
  : "bg-muted/40 text-muted-foreground border-border";

const mark = (s: StageStatus) =>
  s === "COMPLETED" || s === "DETECTED" ? "\u2713"
  : s === "ACTIVE" ? "\u25cf"
  : s === "FAILED" ? "\u2717"
  : s === "SUPPRESSED" ? "\u25cb"
  : s === "NOT_TRACKED" ? "\u2013" : "\u00b7";

/**
 * One stage in the chain.
 *
 * The raw engine values sit in the tooltip rather than being dropped: this view
 * still has to be debuggable, and a pretty label alone cannot do that.
 */
function StageChip({ s }: { s: Stage }) {
  return (
    <div
      className={`flex flex-col border px-1.5 py-1 min-w-0 ${statusClass(s.status)}`}
      title={`${s.term} — ${s.meaning}\n${s.status}: ${s.why}\n\nengine: ${s.evidence.join(" · ")}`}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wider truncate">
        {mark(s.status)} {s.label}
      </span>
      <span className="text-[9px] opacity-80 truncate">
        {s.status === "NOT_TRACKED" ? <em>not tracked</em> : s.status.toLowerCase()}
      </span>
    </div>
  );
}

function PathChip({ n }: { n: PathNode }) {
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 border whitespace-nowrap ${statusClass(n.status)}`}
      title={`${n.term} — ${n.meaning}\n${n.status}: ${n.why}`}
    >
      {mark(n.status)} {n.label}
    </span>
  );
}

export function IpoScanDetail({ row }: { row: IpoRow | null }) {
  if (!row) {
    return (
      <Card className="min-w-0">
        <CardHeader className="py-2"><CardTitle className="text-xs uppercase tracking-wider">Detail</CardTitle></CardHeader>
        <CardContent className="text-xs text-muted-foreground">Select a row to inspect the IPO.</CardContent>
      </Card>
    );
  }

  const chain = lifecycleChain(row);
  const path = candidatePath(row);
  const note = contractionNote(row);
  const coverage = chainCoverage(chain);

  return (
    <Card className="min-w-0">
      <CardHeader className="py-2 flex-row items-center justify-between gap-2">
        <CardTitle className="text-xs uppercase tracking-wider">
          {row.instrument} · {row.timeframe} · {row.direction}
        </CardTitle>
        <Badge variant="outline" className="text-[10px]">observation</Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        <section>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">IPO candle</div>
          <Line label="candle time" value={row.ipoCandleTime?.slice(0, 16).replace("T", " ") || "—"} />
          <Line label="zone high" value={px(row.zoneHigh)} />
          <Line label="zone low" value={px(row.zoneLow)} />
          <Line label="midpoint (E2 entry)" value={px(row.midpoint)} />
          <Line label="direction" value={row.direction} />
        </section>

        <section>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-baseline gap-2">
            <span>Lifecycle</span>
            <span className="normal-case text-[9px] text-muted-foreground/70">
              {coverage.tracked} of {coverage.total} stages tracked by the frozen engine
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1">
            {chain.map((s) => <StageChip key={s.term} s={s} />)}
          </div>

          {note && (
            <div className={`mt-1.5 border px-1.5 py-1 ${
              note.headline === "Active contraction detected"
                ? "bg-amber-500/10 border-amber-500/40" : "bg-muted border-border"}`}>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-600">
                {note.headline}
              </div>
              <div className="text-[10px] text-muted-foreground">{note.detail}</div>
            </div>
          )}

          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-2 mb-1">
            Candidate path
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            {path.map((n, i) => (
              <React.Fragment key={n.term}>
                {i > 0 && <span className="text-muted-foreground text-[10px]">&rarr;</span>}
                <PathChip n={n} />
              </React.Fragment>
            ))}
          </div>

          <p className="text-[9px] text-muted-foreground mt-1.5">
            A stage is only marked detected when a field on this row proves it — nothing is
            inferred backwards from a later stage. Move away, expansion and trend are research
            states the frozen rules do not compute; valid external IPO needs a link to a
            predecessor IPO that the engine does not store. Hover any stage for the raw
            engine values behind it.
          </p>

          <div className="mt-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
              Raw engine fields
            </div>
            <Line label="state" value={row.state} />
            <Line label="validation" value={row.validationStatus} />
            <Line label="observation" value={row.observationStatus} />
            <Line label="FVG" value={`${row.fvgPresent ? "present" : "absent"} (${row.fvgStatus})`}
                  tone={row.fvgPresent ? "text-emerald-600" : "text-muted-foreground"} />
            <Line label="contraction" value={tri(row.contraction)} />
            <Line label="opposite-side cleared" value={tri(row.oppositeSideCleared)} />
            <Line label="touch" value={tri(row.touch)} />
            <Line label="move-away" value={tri(row.moveAway)} />
            <Line label="expansion" value={tri(row.expansion)} />
            <Line label="trend" value={tri(row.trend)} />
          </div>
        </section>

        <section>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Volatility</div>
          <Line label="bucket" value={row.volatilityBucket} />
          <Line label="eligible" value={row.volatilityEligible ? "yes" : "no"}
                tone={row.volatilityEligible ? "text-emerald-600" : "text-amber-600"} />
        </section>

        <section>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Plan</div>
          <Line label="intended entry" value={px(row.intendedEntry)} />
          <Line label="2R target" value={px(row.target2R)} />
          <Line label="S2 invalidation" value={px(row.s2Invalidation)} />
          <Line label="risk (price)" value={px(row.riskPrice)} />
          <Line label="sequencing" value={row.sequencingState} />
        </section>

        <section>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
            Execution eligibility <span className="normal-case italic">— informational only</span>
          </div>
          <Line label="would the rules admit it" value={row.executionEligible ? "yes" : "no"}
                tone={row.executionEligible ? "text-emerald-600" : "text-muted-foreground"} />
          <div className="flex flex-wrap gap-1 pt-1">
            {row.reasonCodes.map((c) => (
              <Badge key={c} variant="secondary" className="text-[9px] font-mono">{c}</Badge>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground pt-2">
            Phase C is observation only. No order is placed from this view.
          </p>
        </section>

        <section>
          <details>
            <summary className="text-[10px] uppercase tracking-wider text-muted-foreground cursor-pointer">
              Lifecycle glossary
            </summary>
            <dl className="mt-1">
              {(Object.keys(GLOSSARY) as Array<keyof typeof GLOSSARY>).map((k) => (
                <div key={k} className="flex items-baseline justify-between gap-2 py-0.5 border-b border-border/40">
                  <dt className="text-[9px] font-mono text-muted-foreground">{k}</dt>
                  <dd className="text-[10px] text-right">{GLOSSARY[k]}</dd>
                </div>
              ))}
            </dl>
          </details>
        </section>
      </CardContent>
    </Card>
  );
}

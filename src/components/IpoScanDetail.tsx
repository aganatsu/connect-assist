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

export function IpoScanDetail({ row }: { row: IpoRow | null }) {
  if (!row) {
    return (
      <Card className="min-w-0">
        <CardHeader className="py-2"><CardTitle className="text-xs uppercase tracking-wider">Detail</CardTitle></CardHeader>
        <CardContent className="text-xs text-muted-foreground">Select a row to inspect the IPO.</CardContent>
      </Card>
    );
  }

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
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Lifecycle</div>
          <Line label="state" value={row.state} />
          <Line label="FVG" value={`${row.fvgPresent ? "present" : "absent"} (${row.fvgStatus})`}
                tone={row.fvgPresent ? "text-emerald-600" : "text-muted-foreground"} />
          <Line label="contraction" value={tri(row.contraction)} />
          <Line label="opposite-side cleared" value={tri(row.oppositeSideCleared)} />
          <Line label="touch" value={tri(row.touch)} />
          <Line label="move-away" value={tri(row.moveAway)} />
          <Line label="expansion" value={tri(row.expansion)} />
          <Line label="trend" value={tri(row.trend)} />
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
      </CardContent>
    </Card>
  );
}

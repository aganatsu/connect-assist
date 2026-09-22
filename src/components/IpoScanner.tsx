/**
 * IPO observation scanner. Phase C — READ-ONLY.
 *
 * Master/detail over what the frozen IPO rules currently see. It is a separate
 * component tree from the SMC scanner on purpose: the two strategies have
 * different lifecycle vocabularies and different risk models, and folding IPO
 * into the SMC detail component would turn it into a strategy conditional that
 * both sides then have to reason about.
 *
 * NOTHING HERE CAN TRADE. There is no order button, no mutation and no broker
 * call. `executionEligible` is rendered as a label because it tells a human
 * whether the rules would admit the setup — it is not an action.
 */

import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { IpoScanDetail, type IpoRow } from "@/components/IpoScanDetail";

export interface IpoSnapshot {
  instrument: string;
  timeframe: string;
  asOf: string | null;
  barsProcessed: number;
  volatilityBucket: string;
  sequencingState: "FREE" | "BLOCKED_POSITION_OPEN";
  openPosition: { ipoIndex: number; entryIndex: number; entry: number } | null;
  rows: IpoRow[];
  completedTrades: number;
}

async function fetchObservation(): Promise<{ snapshots: IpoSnapshot[]; errors: Array<{ instrument: string; error: string }> }> {
  const { data, error } = await supabase.functions.invoke("ipo-observation", { body: {} });
  if (error) throw new Error(error.message);
  if (!data?.ok) throw new Error(data?.error ?? "observation failed");
  return { snapshots: data.snapshots ?? [], errors: data.errors ?? [] };
}

const stateTone = (s: string) =>
  s === "VALID_TOUCHED" ? "bg-primary/15 text-primary border-primary/40"
  : s === "VALID_LIVE" ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/40"
  : s === "SUPPRESSED_IN_CONTRACTION" ? "bg-amber-500/15 text-amber-600 border-amber-500/40"
  : s === "INVALIDATED" ? "bg-destructive/15 text-destructive border-destructive/40"
  : "bg-muted text-muted-foreground border-border";

export function IpoScanner() {
  const [selected, setSelected] = useState<IpoRow | null>(null);
  const [instrumentFilter, setInstrumentFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");

  const { data, isLoading, error } = useQuery({
    queryKey: ["ipo-observation"],
    queryFn: fetchObservation,
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  const rows = useMemo(() => {
    const all = (data?.snapshots ?? []).flatMap((s) => s.rows);
    return all
      .filter((r) => instrumentFilter === "all" || r.instrument === instrumentFilter)
      .filter((r) => stateFilter === "all" || r.state === stateFilter);
  }, [data, instrumentFilter, stateFilter]);

  return (
    <div className="flex flex-col gap-2 min-h-0">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
          Observation only — no orders
        </Badge>
        {(data?.snapshots ?? []).map((s) => (
          <Badge key={s.instrument} variant="secondary" className="text-[10px] font-mono">
            {s.instrument} · {s.timeframe} · {s.volatilityBucket} ·{" "}
            {s.sequencingState === "FREE" ? "free" : "blocked"} · {s.barsProcessed} bars
          </Badge>
        ))}
        <div className="ml-auto flex gap-2">
          <Select value={instrumentFilter} onValueChange={setInstrumentFilter}>
            <SelectTrigger className="h-7 w-[130px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All instruments</SelectItem>
              <SelectItem value="EUR/USD">EUR/USD</SelectItem>
              <SelectItem value="USD/JPY">USD/JPY</SelectItem>
              <SelectItem value="BTC/USD">BTC/USD</SelectItem>
            </SelectContent>
          </Select>
          <Select value={stateFilter} onValueChange={setStateFilter}>
            <SelectTrigger className="h-7 w-[190px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All states</SelectItem>
              <SelectItem value="VALID_TOUCHED">Valid — touched</SelectItem>
              <SelectItem value="VALID_LIVE">Valid — live</SelectItem>
              <SelectItem value="PENDING_CANDIDATE">Pending</SelectItem>
              <SelectItem value="SUPPRESSED_IN_CONTRACTION">Suppressed</SelectItem>
              <SelectItem value="INVALIDATED">Invalidated</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {(data?.errors ?? []).map((e) => (
        <div key={e.instrument} className="text-[11px] text-destructive border border-destructive/40 px-2 py-1">
          {e.instrument}: {e.error}
        </div>
      ))}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] gap-2 min-h-0">
        <Card className="min-w-0">
          <CardHeader className="py-2"><CardTitle className="text-xs uppercase tracking-wider">
            IPO Scanner {rows.length > 0 && <span className="text-muted-foreground">({rows.length})</span>}
          </CardTitle></CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            {isLoading && <div className="p-4 text-xs text-muted-foreground">Bootstrapping the IPO engine…</div>}
            {error && <div className="p-4 text-xs text-destructive">{(error as Error).message}</div>}
            {!isLoading && !error && rows.length === 0 && (
              <div className="p-4 text-xs text-muted-foreground">No IPO candidates in view.</div>
            )}
            {rows.length > 0 && (
              <table className="w-full text-[11px]">
                <thead className="text-muted-foreground border-b border-border">
                  <tr>
                    <th className="text-left px-2 py-1 font-medium">Pair</th>
                    <th className="text-left px-2 py-1 font-medium">TF</th>
                    <th className="text-left px-2 py-1 font-medium">Dir</th>
                    <th className="text-left px-2 py-1 font-medium">Lifecycle</th>
                    <th className="text-left px-2 py-1 font-medium">Signal</th>
                    <th className="text-left px-2 py-1 font-medium">Validation</th>
                    <th className="text-left px-2 py-1 font-medium">Observation</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={`${r.instrument}-${r.ipoIndex}`}
                      onClick={() => setSelected(r)}
                      className={`border-b border-border/50 cursor-pointer hover:bg-muted/50 ${
                        selected?.ipoIndex === r.ipoIndex && selected?.instrument === r.instrument ? "bg-muted" : ""}`}
                    >
                      <td className="px-2 py-1 font-mono">{r.instrument}</td>
                      <td className="px-2 py-1 text-muted-foreground">{r.timeframe}</td>
                      <td className={`px-2 py-1 font-medium ${r.direction === "long" ? "text-emerald-600" : "text-destructive"}`}>
                        {r.direction}
                      </td>
                      <td className="px-2 py-1">
                        <span className={`px-1 py-0.5 border text-[10px] ${stateTone(r.state)}`}>{r.state}</span>
                      </td>
                      <td className="px-2 py-1">{r.signalValid ? "valid" : "—"}</td>
                      <td className="px-2 py-1 font-mono text-muted-foreground">{r.validationStatus}</td>
                      <td className="px-2 py-1 text-muted-foreground">{r.observationStatus}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <IpoScanDetail row={selected} />
      </div>
    </div>
  );
}

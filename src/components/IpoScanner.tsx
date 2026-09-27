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

import React, { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { IpoScanDetail, type IpoRow } from "@/components/IpoScanDetail";
import { IpoPager } from "@/components/IpoPager";
import { paginate } from "@/lib/paginate";
import type { PaperState } from "@/components/IpoPaperMonitor";
import {
  linkRows, ownersOf, TRADE_STATUS_BADGE, type Linkage, type LinkedRow,
} from "@/lib/ipoTradeLinkage";

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

/**
 * The paper ledger, READ-ONLY, purely to answer "which IPO actually traded".
 *
 * A second endpoint on this view, and both are SELECT-only. The observation
 * snapshot knows the lifecycle but has never heard of a fill; the paper state
 * knows the fills but not which candidate produced them. Only the pair can say
 * which of several VALID_TOUCHED rows owns the open position.
 *
 * It fails SOFT: a scanner that cannot reach the ledger still renders every
 * lifecycle row, with trade status simply unknown. Losing the whole scanner
 * because the ownership decoration is unavailable would be a bad trade.
 */
async function fetchPaperLedger(): Promise<PaperState | null> {
  const { data, error } = await supabase.functions.invoke("ipo-paper-state", { body: {} });
  if (error || !data?.ok) return null;
  return data as PaperState;
}

const linkTone = (l: Linkage | undefined) =>
  !l ? "bg-muted text-muted-foreground border-border"
  : l.tone === "info" ? "bg-primary/15 text-primary border-primary/50"
  : l.tone === "good" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-500 border-emerald-500/40"
  : l.tone === "warn" ? "bg-amber-500/15 text-amber-600 border-amber-500/40"
  : l.tone === "bad" ? "bg-destructive/15 text-destructive border-destructive/40"
  : "bg-muted text-muted-foreground border-border";

const stateTone = (s: string) =>
  s === "VALID_TOUCHED" ? "bg-primary/15 text-primary border-primary/40"
  : s === "VALID_LIVE" ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/40"
  : s === "SUPPRESSED_IN_CONTRACTION" ? "bg-amber-500/15 text-amber-600 border-amber-500/40"
  : s === "INVALIDATED" ? "bg-destructive/15 text-destructive border-destructive/40"
  : "bg-muted text-muted-foreground border-border";

/** Stable identity for a row across refetches. The object itself is replaced every poll. */
const rowKey = (r: { instrument: string; ipoIndex: number }) => `${r.instrument}|${r.ipoIndex}`;

export function IpoScanner() {
  /**
   * The SELECTED KEY, not the selected row.
   *
   * Holding the row object meant every 2-minute refetch replaced it with an
   * equal-but-different object, so the detail pane showed a snapshot that
   * quietly stopped updating. Holding the key re-resolves against the current
   * data: the pane follows the live row, survives paging and refresh, and goes
   * empty only when the row genuinely leaves the dataset.
   */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  // One piece of state per CONCEPT, named after the concept. The two selects
  // previously read "All trade states" and "All states", which is two generic
  // labels for two different things.
  const [instrumentFilter, setInstrumentFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");        // lifecycle
  const [tradeFilter, setTradeFilter] = useState("all");        // trade status
  const [validationFilter, setValidationFilter] = useState("all");
  const [observationFilter, setObservationFilter] = useState("all");

  const { data, isLoading, error } = useQuery({
    queryKey: ["ipo-observation"],
    queryFn: fetchObservation,
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  const { data: ledger } = useQuery({
    queryKey: ["ipo-paper-state"],
    queryFn: fetchPaperLedger,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const linked = useMemo(() => {
    const all = (data?.snapshots ?? []).flatMap((s) => s.rows);
    return linkRows(all, ledger?.openPositions ?? [], ledger?.recentTrades ?? []);
  }, [data, ledger]);

  const linkOf = useMemo(() => {
    const m = new Map<string, Linkage>();
    for (const l of linked) m.set(`${l.row.instrument}|${l.row.ipoIndex}`, l.link);
    return m;
  }, [linked]);

  const owners = useMemo(() => ownersOf(linked), [linked]);

  // Derived from what is actually in view rather than a hardcoded three, so
  // enabling an instrument does not leave an unreachable filter behind.
  const instruments = useMemo(
    () => [...new Set(linked.map((l) => l.row.instrument))].sort(), [linked]);

  // A filter change restarts at page 1: staying on page 3 of a freshly narrowed
  // list shows a result set the user never asked to skip into.
  useEffect(() => { setPage(1); },
    [instrumentFilter, stateFilter, tradeFilter, validationFilter, observationFilter]);

  // Option lists are DERIVED from what is in view, so a filter can never offer a
  // value that matches nothing, and enabling a new instrument or state does not
  // leave an unreachable option behind.
  const validations = useMemo(
    () => [...new Set(linked.map((l) => l.row.validationStatus).filter(Boolean))].sort(), [linked]);
  const observations = useMemo(
    () => [...new Set(linked.map((l) => l.row.observationStatus).filter(Boolean))].sort(), [linked]);
  const lifecycles = useMemo(
    () => [...new Set(linked.map((l) => l.row.state).filter(Boolean))].sort(), [linked]);

  // EVERY filter applies to the FULL dataset. Pagination happens afterwards, so
  // the count in the header and the pager both describe the filtered set.
  const rows = useMemo(() => linked
    .map((l) => l.row)
    .filter((r) => instrumentFilter === "all" || r.instrument === instrumentFilter)
    .filter((r) => stateFilter === "all" || r.state === stateFilter)
    .filter((r) => validationFilter === "all" || r.validationStatus === validationFilter)
    .filter((r) => observationFilter === "all" || r.observationStatus === observationFilter)
    .filter((r) => tradeFilter === "all"
      || linkOf.get(rowKey(r))?.status === tradeFilter),
    [linked, linkOf, instrumentFilter, stateFilter, tradeFilter, validationFilter, observationFilter]);

  /** Active filters, for the chips and the clear-all control. */
  const active = useMemo(() => {
    const out: Array<{ key: string; label: string; clear: () => void }> = [];
    if (instrumentFilter !== "all") {
      out.push({ key: "instrument", label: instrumentFilter, clear: () => setInstrumentFilter("all") });
    }
    if (tradeFilter !== "all") {
      out.push({ key: "trade",
        label: TRADE_STATUS_BADGE[tradeFilter as keyof typeof TRADE_STATUS_BADGE] ?? tradeFilter,
        clear: () => setTradeFilter("all") });
    }
    if (stateFilter !== "all") out.push({ key: "lifecycle", label: stateFilter, clear: () => setStateFilter("all") });
    if (validationFilter !== "all") {
      out.push({ key: "validation", label: validationFilter, clear: () => setValidationFilter("all") });
    }
    if (observationFilter !== "all") {
      out.push({ key: "observation", label: observationFilter, clear: () => setObservationFilter("all") });
    }
    return out;
  }, [instrumentFilter, tradeFilter, stateFilter, validationFilter, observationFilter]);

  const clearAll = () => {
    setInstrumentFilter("all"); setTradeFilter("all"); setStateFilter("all");
    setValidationFilter("all"); setObservationFilter("all");
  };

  // AFTER filtering. Paging a list then filtering it would show page 2 of one
  // list labelled as page 2 of another.
  const pageOf = useMemo(() => paginate(rows, page, pageSize), [rows, page, pageSize]);

  // NO CLAMP EFFECT HERE, DELIBERATELY. An effect that wrote the clamped page
  // back into state raced the filter reset below and won, because it was
  // declared later: narrowing the list left the user on page 2 instead of
  // page 1. `paginate` already clamps what it returns, and IpoPager steps from
  // that clamped value, so a stale stored page is invisible and harmless.

  // Resolved from the FULL set, not the page, so selection survives paging.
  const selected = useMemo(
    () => linked.find((l) => rowKey(l.row) === selectedKey)?.row ?? null,
    [linked, selectedKey],
  );

  return (
    <div className="flex flex-col gap-2 min-h-0 h-full">
      {/* Filters stay out of the scroll areas so they are always reachable. */}
      <div className="flex items-center gap-2 flex-wrap shrink-0">
        {/* The scanner itself places no order, but it DOES display a live paper
            position, so "observation only — no orders" read as "no positions
            exist". It says what it is instead. */}
        <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
          Scanner view — paper execution shown for context
        </Badge>
        {owners.map((o) => (
          <Badge key={`${o.row.instrument}-${o.row.ipoIndex}`} variant="outline"
                 className="text-[10px] font-mono bg-primary/15 text-primary border-primary/50">
            OPEN POSITION · {o.row.instrument} {o.row.direction} · IPO {o.row.ipoCandleTime.slice(0, 16).replace("T", " ")}
          </Badge>
        ))}
        {(data?.snapshots ?? []).map((s) => (
          <Badge key={s.instrument} variant="secondary" className="text-[10px] font-mono">
            {s.instrument} · {s.timeframe} · {s.volatilityBucket} ·{" "}
            {s.sequencingState === "FREE" ? "free" : "blocked"} · {s.barsProcessed} bars
          </Badge>
        ))}
        {/* Native selects, matching the page-size control below the table.
            Three plain value lists need nothing more, and native gets keyboard
            and screen-reader behaviour, a real mobile picker, and testability
            for free — the Radix version cannot be opened outside a browser. */}
        <div className="ml-auto flex gap-2 flex-wrap">
          <select value={instrumentFilter} onChange={(e) => setInstrumentFilter(e.target.value)}
                  aria-label="Instrument"
                  className="h-7 w-[130px] text-xs bg-background border border-input text-foreground px-1">
            <option value="all">Instrument: any</option>
            {instruments.map((i) => <option key={i} value={i}>{i}</option>)}
          </select>
          <select value={tradeFilter} onChange={(e) => setTradeFilter(e.target.value)}
                  aria-label="Trade status"
                  className="h-7 w-[200px] text-xs bg-background border border-input text-foreground px-1">
            <option value="all">Trade status: any</option>
            {(Object.keys(TRADE_STATUS_BADGE) as Array<keyof typeof TRADE_STATUS_BADGE>).map((k) => (
              <option key={k} value={k}>{TRADE_STATUS_BADGE[k]}</option>
            ))}
          </select>
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}
                  aria-label="Lifecycle"
                  className="h-7 w-[190px] text-xs bg-background border border-input text-foreground px-1">
            <option value="all">Lifecycle: any</option>
            {lifecycles.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <select value={validationFilter} onChange={(e) => setValidationFilter(e.target.value)}
                  aria-label="Validation"
                  className="h-7 w-[170px] text-xs bg-background border border-input text-foreground px-1">
            <option value="all">Validation: any</option>
            {validations.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <select value={observationFilter} onChange={(e) => setObservationFilter(e.target.value)}
                  aria-label="Observation"
                  className="h-7 w-[170px] text-xs bg-background border border-input text-foreground px-1">
            <option value="all">Observation: any</option>
            {observations.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
      </div>

      {/* Active filters, individually removable. Without this a narrowed list
          and an empty one look the same. */}
      {active.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap shrink-0" data-testid="active-filters">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">filters</span>
          {active.map((f) => (
            <button key={f.key} type="button" onClick={f.clear}
                    aria-label={`Remove filter ${f.label}`}
                    className="text-[10px] font-mono border border-input px-1.5 py-0.5 hover:bg-muted">
              {f.label} <span aria-hidden="true">×</span>
            </button>
          ))}
          <button type="button" onClick={clearAll}
                  className="text-[10px] uppercase tracking-wider underline text-muted-foreground hover:text-foreground ml-1">
            Clear filters
          </button>
        </div>
      )}

      {(data?.errors ?? []).map((e) => (
        <div key={e.instrument} className="text-[11px] text-destructive border border-destructive/40 px-2 py-1">
          {e.instrument}: {e.error}
        </div>
      ))}

      {/* Fixed dashboard height so the two panes scroll independently instead of
          growing the page. min-h-0 at every level, or a flex child refuses to
          shrink below its content and the inner overflow never engages.
          On narrow screens the grid collapses to one column and each pane keeps
          its own bounded height rather than being forced into a column. */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] gap-2 min-h-0 flex-1 overflow-hidden">
        <Card className="min-w-0 flex flex-col min-h-0 max-h-[60vh] lg:max-h-none overflow-hidden">
          <CardHeader className="py-2 shrink-0"><CardTitle className="text-xs uppercase tracking-wider">
            IPO Scanner {rows.length > 0 && <span className="text-muted-foreground">({rows.length})</span>}
          </CardTitle></CardHeader>
          <CardContent className="p-0 overflow-auto flex-1 min-h-0" data-testid="scanner-scroll">
            {isLoading && <div className="p-4 text-xs text-muted-foreground">Bootstrapping the IPO engine…</div>}
            {error && <div className="p-4 text-xs text-destructive">{(error as Error).message}</div>}
            {/* A filtered-to-nothing list and a genuinely empty one are
                different situations and used to render the same sentence. */}
            {!isLoading && !error && rows.length === 0 && (
              <div className="p-4 text-xs text-muted-foreground">
                {active.length > 0 ? (
                  <>
                    <p>No IPOs match the current filters.</p>
                    <button type="button" onClick={clearAll}
                            className="mt-1 text-[11px] uppercase tracking-wider underline hover:text-foreground">
                      Clear filters
                    </button>
                  </>
                ) : "No IPO candidates in view."}
              </div>
            )}
            {rows.length > 0 && (
              <table className="w-full text-[11px]">
                {/* Sticky, so the column meanings stay on screen while the body scrolls. */}
                <thead className="text-muted-foreground border-b border-border sticky top-0 bg-card z-10">
                  <tr>
                    <th className="text-left px-2 py-1 font-medium">Pair</th>
                    <th className="text-left px-2 py-1 font-medium">TF</th>
                    <th className="text-left px-2 py-1 font-medium">Dir</th>
                    <th className="text-left px-2 py-1 font-medium">Lifecycle</th>
                    <th className="text-left px-2 py-1 font-medium">Trade status</th>
                    <th className="text-left px-2 py-1 font-medium">Signal</th>
                    <th className="text-left px-2 py-1 font-medium">Validation</th>
                    <th className="text-left px-2 py-1 font-medium">Observation</th>
                  </tr>
                </thead>
                <tbody>
                  {pageOf.items.map((r) => (
                    <tr
                      key={`${r.instrument}-${r.ipoIndex}`}
                      onClick={() => setSelectedKey(rowKey(r))}
                      className={`border-b border-border/50 cursor-pointer hover:bg-muted/50 ${
                        selectedKey === rowKey(r) ? "bg-muted" : ""}`}
                    >
                      <td className="px-2 py-1 font-mono">{r.instrument}</td>
                      <td className="px-2 py-1 text-muted-foreground">{r.timeframe}</td>
                      <td className={`px-2 py-1 font-medium ${r.direction === "long" ? "text-emerald-600" : "text-destructive"}`}>
                        {r.direction}
                      </td>
                      <td className="px-2 py-1">
                        <span className={`px-1 py-0.5 border text-[10px] ${stateTone(r.state)}`}>{r.state}</span>
                      </td>
                      {/* Lifecycle and execution are separate columns on purpose: a
                          lifecycle state must never be read as an entry. */}
                      <td className="px-2 py-1">
                        {(() => {
                          const l = linkOf.get(`${r.instrument}|${r.ipoIndex}`);
                          return (
                            <span className={`px-1 py-0.5 border text-[10px] whitespace-nowrap ${linkTone(l)}`}
                                  title={l ? `${l.status} — ${l.meaning}` : "trade ledger unavailable"}>
                              {l ? l.badge : "—"}
                            </span>
                          );
                        })()}
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
          {rows.length > 0 && (
            <IpoPager page={pageOf} onPage={setPage} size={pageSize}
                      onSize={(n) => { setPageSize(n); setPage(1); }} label="rows" />
          )}
        </Card>

        <IpoScanDetail
          row={selected}
          link={selected ? linkOf.get(`${selected.instrument}|${selected.ipoIndex}`) ?? null : null}
        />
      </div>
    </div>
  );
}

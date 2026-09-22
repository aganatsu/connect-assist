/**
 * IPO forward-paper monitor. READ-ONLY.
 *
 * The question this view exists to answer is "is the forward test running, and
 * what has it done" — not "should I trade". There is no order button, no
 * mutation and no broker call anywhere in it, and it calls exactly one endpoint:
 * `ipo-paper-state`, which itself only SELECTs.
 *
 * WHY THE HEARTBEAT IS THE FIRST THING ON THE PAGE. The runner deliberately
 * writes nothing when a run changes nothing, so the strategy tables cannot tell
 * you whether the scheduler is alive. During a quiet spell "ran and found no new
 * bar" and "stopped three days ago" look identical everywhere except here.
 *
 * SEPARATE FROM SMC BY CONSTRUCTION. This is its own component tree under the
 * IPO tab. Nothing here reads an SMC table, and IPO results are deliberately NOT
 * merged into the SMC Journal or its analytics — the two have different risk
 * models, and pooling them would make both numbers wrong.
 */

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";

export interface RunnerHealth {
  lastRunAt: string;
  lastSuccessAt: string | null;
  lastStatus: "OK" | "PARTIAL" | "FAILED";
  durationMs: number;
  instrumentsChecked: number;
  barsProcessed: number;
  eventsEmitted: number;
  bootstrapRequired: string[];
  divergent: string[];
  errorCode: string | null;
  errorMessage: string | null;
  consecutiveFailures: number;
  strategyVersion: string;
}

export interface PaperPositionRow {
  symbol: string; timeframe: string; direction: string; status: string;
  entry_time: string; entry_price: number; target_price: number;
  s2_invalidation_level: number; cost_r: number;
  nominal_risk_usd: number; nominal_risk_distance: number;
  ipo_candle_time: string; volatility_bucket: string;
  zone_entry_ordinal: number | null; zone_previous_exit_time: string | null;
  mae_r: number; mfe_r: number;
  gap_reason: string | null; gap_from_bar_time: string | null;
}

export interface PaperTradeRow extends PaperPositionRow {
  exit_time: string; exit_price: number | null; exit_reason: string;
  realized_r: number | null; gross_r: number | null; realized_pnl_usd: number | null;
  bars_held: number; same_bar_ambiguous: boolean;
  excluded_from_stats: boolean; exclusion_reason: string | null;
}

export interface PaperEventRow {
  bar_time: string; symbol: string; event_type: string;
  strategy_decision: string; account_decision: string;
  reason_codes: string[]; payload: Record<string, unknown>;
}

export interface RuntimeRow {
  symbol: string; timeframe: string;
  cursorBarTime: string | null; activatedAtBarTime: string | null;
  barsSeen: number; bootstrapCount: number;
}

export interface PaperState {
  health: RunnerHealth | null;
  healthStale: boolean;
  cadenceMs: number;
  runtime: RuntimeRow[];
  openPositions: PaperPositionRow[];
  recentTrades: PaperTradeRow[];
  recentEvents: PaperEventRow[];
  summary: {
    trades: number; wins: number; winRate: number;
    totalR: number; expectancyR: number; totalPnlUsd: number;
    abortedExcluded: number;
  };
}

async function fetchPaperState(): Promise<PaperState> {
  const { data, error } = await supabase.functions.invoke("ipo-paper-state", { body: {} });
  if (error) throw new Error(error.message);
  if (!data?.ok) throw new Error(data?.error ?? "paper state unavailable");
  return data as PaperState;
}

const ago = (iso: string | null | undefined) => {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

const clock = (iso: string | null | undefined) =>
  iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") : "—";

/** R drives the colour. Dollars are a view of it, never the other way round. */
const rTone = (r: number | null) =>
  r === null ? "text-muted-foreground"
  : r > 0 ? "text-emerald-600"
  : r < 0 ? "text-destructive" : "text-muted-foreground";

const statusTone = (s: string, stale: boolean) =>
  stale ? "bg-destructive/15 text-destructive border-destructive/40"
  : s === "OK" ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/40"
  : s === "PARTIAL" ? "bg-amber-500/15 text-amber-600 border-amber-500/40"
  : "bg-destructive/15 text-destructive border-destructive/40";

const Field = ({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) => (
  <div className="flex flex-col min-w-0">
    <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</span>
    <span className={`text-[11px] font-mono truncate ${tone ?? ""}`}>{value}</span>
  </div>
);

export function IpoPaperMonitor() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["ipo-paper-state"],
    queryFn: fetchPaperState,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  if (isLoading) return <div className="text-[11px] text-muted-foreground p-2">Loading paper state…</div>;
  if (error) {
    return (
      <div className="text-[11px] text-destructive p-2 font-mono">
        paper state unavailable: {(error as Error).message}
      </div>
    );
  }
  if (!data) return null;

  const h = data.health;
  const stale = data.healthStale;

  return (
    <div className="flex flex-col gap-2 min-w-0">
      {/* ── runner health ─────────────────────────────────────────────────── */}
      <Card className="rounded-none">
        <CardHeader className="py-1.5 px-2 flex-row items-center justify-between space-y-0">
          <CardTitle className="text-[11px] font-bold uppercase tracking-wider">
            Runner health
          </CardTitle>
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" className="text-[9px] rounded-none">PAPER</Badge>
            <Badge
              variant="outline"
              className={`text-[9px] rounded-none ${statusTone(h?.lastStatus ?? "FAILED", stale)}`}
            >
              {!h ? "NO HEARTBEAT" : stale ? "STALE" : h.lastStatus}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="px-2 pb-2 pt-0">
          {!h ? (
            <p className="text-[11px] text-muted-foreground">
              The runner has never recorded a beat. Either it has not run since the
              heartbeat shipped, or the scheduler is not firing.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1.5">
                <Field label="last run" value={`${ago(h.lastRunAt)} · ${clock(h.lastRunAt)}`} />
                <Field
                  label="last success"
                  value={h.lastSuccessAt ? `${ago(h.lastSuccessAt)} · ${clock(h.lastSuccessAt)}` : "never"}
                  tone={h.lastSuccessAt ? "" : "text-destructive"}
                />
                <Field
                  label="consecutive failures"
                  value={h.consecutiveFailures}
                  tone={h.consecutiveFailures > 0 ? "text-destructive" : ""}
                />
                <Field label="duration" value={`${h.durationMs} ms`} />
                <Field label="instruments" value={h.instrumentsChecked} />
                <Field label="bars processed" value={h.barsProcessed} />
                <Field label="events emitted" value={h.eventsEmitted} />
                <Field label="strategy" value={h.strategyVersion} />
              </div>
              {stale && (
                <p className="text-[10px] text-destructive mt-1.5">
                  No run for more than three scheduled intervals. A quiet run writes
                  nothing to the strategy tables, so this is the only place a
                  stopped scheduler shows up.
                </p>
              )}
              {h.bootstrapRequired.length > 0 && (
                <p className="text-[10px] text-amber-600 mt-1.5">
                  BOOTSTRAP_REQUIRED: {h.bootstrapRequired.join(", ")} — run the local
                  bootstrap; the runner will not rebuild on Edge.
                </p>
              )}
              {h.divergent.length > 0 && (
                <p className="text-[10px] text-destructive mt-1.5">
                  DIVERGENCE: {h.divergent.join(", ")} — engine and paper disagree.
                  Nothing was written for those instruments. This is a stop condition.
                </p>
              )}
              {h.errorMessage && (
                <p className="text-[10px] text-destructive mt-1.5 font-mono break-all">
                  {h.errorCode}: {h.errorMessage}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* ── per-instrument state ──────────────────────────────────────────── */}
      <Card className="rounded-none">
        <CardHeader className="py-1.5 px-2">
          <CardTitle className="text-[11px] font-bold uppercase tracking-wider">
            Instrument state
          </CardTitle>
        </CardHeader>
        <CardContent className="px-2 pb-2 pt-0 overflow-x-auto">
          <table className="w-full text-[11px] font-mono">
            <thead className="text-[9px] uppercase tracking-wider text-muted-foreground">
              <tr className="text-left">
                <th className="pr-3 font-normal">instrument</th>
                <th className="pr-3 font-normal">tf</th>
                <th className="pr-3 font-normal">processed through</th>
                <th className="pr-3 font-normal">bars</th>
                <th className="pr-3 font-normal">activated</th>
              </tr>
            </thead>
            <tbody>
              {data.runtime.length === 0 && (
                <tr><td colSpan={5} className="text-muted-foreground py-1">no runtime state</td></tr>
              )}
              {data.runtime.map((r) => (
                <tr key={r.symbol} className="border-t border-border/50">
                  <td className="pr-3 py-0.5">{r.symbol}</td>
                  <td className="pr-3">{r.timeframe}</td>
                  <td className="pr-3">{clock(r.cursorBarTime)}</td>
                  <td className="pr-3">{r.barsSeen}</td>
                  <td className="pr-3 text-muted-foreground">{clock(r.activatedAtBarTime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[9px] text-muted-foreground mt-1">
            Each instrument advances on its own cursor. They are not synchronised, and
            a 30-minute instrument will legitimately sit ahead of an hourly one.
          </p>
        </CardContent>
      </Card>

      {/* ── open positions ────────────────────────────────────────────────── */}
      <Card className="rounded-none">
        <CardHeader className="py-1.5 px-2">
          <CardTitle className="text-[11px] font-bold uppercase tracking-wider">
            Open paper positions ({data.openPositions.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="px-2 pb-2 pt-0">
          {data.openPositions.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">Flat.</p>
          ) : data.openPositions.map((p) => (
            <div key={`${p.symbol}-${p.entry_time}`} className="border-t border-border/50 py-1.5 first:border-t-0">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-[11px] font-mono font-bold">{p.symbol}</span>
                <Badge variant="outline" className="text-[9px] rounded-none uppercase">{p.direction}</Badge>
                <Badge variant="outline" className="text-[9px] rounded-none">{p.volatility_bucket}</Badge>
                {p.status === "data_gap_suspended" && (
                  <Badge variant="outline" className="text-[9px] rounded-none bg-amber-500/15 text-amber-600 border-amber-500/40">
                    SUSPENDED · {p.gap_reason}
                  </Badge>
                )}
                {(p.zone_entry_ordinal ?? 1) > 1 && (
                  <Badge variant="outline" className="text-[9px] rounded-none bg-primary/10 text-primary border-primary/40">
                    RE-ENTRY #{p.zone_entry_ordinal}
                  </Badge>
                )}
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-x-3 gap-y-1">
                <Field label="entry" value={p.entry_price} />
                <Field label="target 2R" value={p.target_price} />
                <Field label="S2" value={p.s2_invalidation_level} />
                <Field label="risk $" value={`$${p.nominal_risk_usd}`} />
                <Field label="MAE" value={`${p.mae_r.toFixed(2)}R`} />
                <Field label="MFE" value={`${p.mfe_r.toFixed(2)}R`} />
                <Field label="IPO candle" value={clock(p.ipo_candle_time)} />
                <Field label="zone ordinal" value={p.zone_entry_ordinal ?? "—"} />
                <Field label="prev zone exit" value={clock(p.zone_previous_exit_time)} />
                <Field label="costR" value={p.cost_r.toFixed(4)} />
                <Field label="opened" value={clock(p.entry_time)} />
                <Field label="mode" value="paper" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* ── closed results ────────────────────────────────────────────────── */}
      <Card className="rounded-none">
        <CardHeader className="py-1.5 px-2 flex-row items-center justify-between space-y-0">
          <CardTitle className="text-[11px] font-bold uppercase tracking-wider">
            Recent paper trades
          </CardTitle>
          <span className="text-[10px] font-mono text-muted-foreground">
            {data.summary.trades} clean · {(data.summary.winRate * 100).toFixed(0)}% win ·{" "}
            <span className={rTone(data.summary.totalR)}>{data.summary.totalR.toFixed(3)}R</span> ·{" "}
            exp {data.summary.expectancyR.toFixed(3)}R · ${data.summary.totalPnlUsd.toFixed(2)}
            {data.summary.abortedExcluded > 0 && ` · ${data.summary.abortedExcluded} excluded`}
          </span>
        </CardHeader>
        <CardContent className="px-2 pb-2 pt-0 overflow-x-auto">
          <table className="w-full text-[11px] font-mono whitespace-nowrap">
            <thead className="text-[9px] uppercase tracking-wider text-muted-foreground">
              <tr className="text-left">
                <th className="pr-3 font-normal">exit</th>
                <th className="pr-3 font-normal">sym</th>
                <th className="pr-3 font-normal">dir</th>
                <th className="pr-3 font-normal">reason</th>
                <th className="pr-3 font-normal text-right">R</th>
                <th className="pr-3 font-normal text-right">P&amp;L</th>
                <th className="pr-3 font-normal text-right">ord</th>
                <th className="pr-3 font-normal">prev exit</th>
                <th className="pr-3 font-normal">IPO candle</th>
                <th className="pr-3 font-normal">vol</th>
                <th className="pr-3 font-normal text-right">MAE</th>
              </tr>
            </thead>
            <tbody>
              {data.recentTrades.length === 0 && (
                <tr><td colSpan={11} className="text-muted-foreground py-1">No closed paper trades yet.</td></tr>
              )}
              {data.recentTrades.map((t, i) => (
                <tr key={`${t.symbol}-${t.exit_time}-${i}`} className="border-t border-border/50">
                  <td className="pr-3 py-0.5">{clock(t.exit_time)}</td>
                  <td className="pr-3">{t.symbol}</td>
                  <td className="pr-3">{t.direction}</td>
                  <td className="pr-3">
                    {t.exit_reason}
                    {t.same_bar_ambiguous && <span className="text-amber-600" title="target and S2 on one bar; resolved stop-first"> ±</span>}
                    {t.excluded_from_stats && <span className="text-muted-foreground" title={t.exclusion_reason ?? ""}> (excluded)</span>}
                  </td>
                  <td className={`pr-3 text-right ${rTone(t.realized_r)}`}>
                    {t.realized_r === null ? "—" : t.realized_r.toFixed(4)}
                  </td>
                  <td className={`pr-3 text-right ${rTone(t.realized_r)}`}>
                    {t.realized_pnl_usd === null ? "—" : `$${t.realized_pnl_usd.toFixed(2)}`}
                  </td>
                  <td className="pr-3 text-right">{t.zone_entry_ordinal ?? "—"}</td>
                  <td className="pr-3 text-muted-foreground">{clock(t.zone_previous_exit_time)}</td>
                  <td className="pr-3 text-muted-foreground">{clock(t.ipo_candle_time)}</td>
                  <td className="pr-3">{t.volatility_bucket}</td>
                  <td className="pr-3 text-right text-muted-foreground">{t.mae_r?.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[9px] text-muted-foreground mt-1">
            R is the strategy result. Dollars are a view of it under the nominal
            sizing stored on each row and are NOT a maximum loss — S2 losses
            routinely exceed 1R. Aborted rows carry no R and are excluded from the
            summary, but are still listed.
          </p>
        </CardContent>
      </Card>

      {/* ── refusals and audit ────────────────────────────────────────────── */}
      <Card className="rounded-none">
        <CardHeader className="py-1.5 px-2">
          <CardTitle className="text-[11px] font-bold uppercase tracking-wider">
            Recent decisions
          </CardTitle>
        </CardHeader>
        <CardContent className="px-2 pb-2 pt-0 overflow-x-auto">
          <table className="w-full text-[11px] font-mono whitespace-nowrap">
            <thead className="text-[9px] uppercase tracking-wider text-muted-foreground">
              <tr className="text-left">
                <th className="pr-3 font-normal">bar</th>
                <th className="pr-3 font-normal">sym</th>
                <th className="pr-3 font-normal">event</th>
                <th className="pr-3 font-normal">strategy</th>
                <th className="pr-3 font-normal">account</th>
                <th className="pr-3 font-normal">detail</th>
              </tr>
            </thead>
            <tbody>
              {data.recentEvents.length === 0 && (
                <tr><td colSpan={6} className="text-muted-foreground py-1">No decisions recorded yet.</td></tr>
              )}
              {data.recentEvents.slice(0, 40).map((e, i) => {
                const costR = e.payload?.costR as number | undefined;
                const block = e.payload?.blockReason as string | undefined;
                return (
                  <tr key={`${e.bar_time}-${e.event_type}-${i}`} className="border-t border-border/50">
                    <td className="pr-3 py-0.5">{clock(e.bar_time)}</td>
                    <td className="pr-3">{e.symbol}</td>
                    <td className="pr-3">{e.event_type}</td>
                    {/* The two verdicts are shown side by side and never collapsed:
                        a blocked execution does not make the signal invalid. */}
                    <td className="pr-3">{e.strategy_decision}</td>
                    <td className="pr-3 text-muted-foreground">{e.account_decision}</td>
                    <td className="pr-3 text-muted-foreground">
                      {block ? <span className="text-amber-600">{block}</span> : e.reason_codes?.join(", ")}
                      {costR !== undefined && ` · costR ${costR.toFixed(4)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-[9px] text-muted-foreground mt-1">
            A REFUSED row still shows strategy WOULD_ENTER: the IPO signal stays
            valid and only execution was blocked, so the cost of that rule stays
            measurable.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

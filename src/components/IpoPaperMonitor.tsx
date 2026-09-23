/**
 * IPO forward-paper dashboard. READ-ONLY.
 *
 * The question this view exists to answer is "is the forward test running, and
 * what has it done" — not "should I trade". There is no order button, no
 * mutation and no broker call anywhere in it, and it calls exactly one endpoint:
 * `ipo-paper-state`, which itself only SELECTs.
 *
 * ORDER OF THE PAGE IS THE POINT. Trader-facing numbers first, then open
 * positions, then the lifecycle and the refusals, and engineering telemetry
 * last. The heartbeat used to lead because a quiet run writes nothing to the
 * strategy tables and a stopped scheduler is otherwise invisible — that reason
 * is still true, so the health SUMMARY sits in the top strip while its detail
 * moved to the bottom. Nothing about it was dropped, only demoted.
 *
 * HEALTHY MUST LOOK HEALTHY. A green run is rendered in muted type, not in
 * warning colours. A dashboard that shouts during normal operation trains the
 * reader to ignore it, which is the state the alarming version was already in.
 *
 * SEPARATE FROM SMC BY CONSTRUCTION. This is its own component tree under the
 * IPO tab. Nothing here reads an SMC table, and IPO results are deliberately NOT
 * merged into the SMC journal or its analytics — the two have different risk
 * models, and pooling them would make both numbers wrong.
 *
 * WHAT IT DOES NOT SHOW, AND WHY. There is no current price, no unrealized R
 * and no live distance-to-target anywhere on this page. No column stores a
 * current price for an IPO position and the read endpoint fetches no candles,
 * by design. `mae_r` / `mfe_r` are stored and updated on every managed bar, so
 * those answer "how has it gone so far" without inventing a feed.
 */

import React, { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import {
  headline, lifecycleStages, explainStatus, planGeometry, gapState,
  bySymbol, byBucket, byOrdinal, exitReasonSplit, filterTrades, filterOptions,
  filterIsActive, NO_FILTERS, SMALL_SAMPLE_MAX, pluralTrades,
  type TradeFilters, type Tone, type Stage, type Group,
} from "@/lib/ipoDashboard";
import { readEvent, ENTRY_PROOF_NOTE, ordinalPhrase } from "@/lib/ipoTradeLinkage";
import { IpoPager } from "@/components/IpoPager";
import { paginate } from "@/lib/paginate";

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
  // Present in the endpoint's `select("*")` since Phase D; declared here so the
  // scanner can prove which IPO owns a trade instead of matching on symbol.
  setup_id?: string | null; intent_id?: string | null;
  entry_time: string; entry_price: number; target_price: number;
  s2_invalidation_level: number; cost_r: number;
  nominal_risk_usd: number; nominal_risk_distance: number;
  ipo_candle_time: string; volatility_bucket: string;
  zone_entry_ordinal: number | null; zone_previous_exit_time: string | null;
  mae_r: number; mfe_r: number;
  gap_reason: string | null; gap_from_bar_time: string | null;
  last_managed_bar_time?: string | null;
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

const ago = (iso: string | null | undefined, now = Date.now()) => {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

const clock = (iso: string | null | undefined) =>
  iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") : "—";

const px = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(2) : n.toFixed(5));

/** R drives the colour. Dollars are a view of it, never the other way round. */
const rTone = (r: number | null) =>
  r === null ? "text-muted-foreground"
  : r > 0 ? "text-emerald-600"
  : r < 0 ? "text-destructive" : "text-muted-foreground";

/**
 * Tone → classes.
 *
 * `good` and `neutral` are deliberately quiet. Only `warn` and `bad` carry
 * colour, so the page is calm when the system is fine.
 */
const toneClass = (t: Tone) =>
  t === "bad" ? "bg-destructive/15 text-destructive border-destructive/40"
  : t === "warn" ? "bg-amber-500/15 text-amber-600 border-amber-500/40"
  : t === "good" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-500 border-emerald-500/30"
  : t === "info" ? "bg-primary/10 text-primary border-primary/30"
  : "bg-muted text-muted-foreground border-border";

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

/** A headline number. Big, because this is what the page is for. */
const Metric = ({ label, value, tone, sub }: {
  label: string; value: React.ReactNode; tone?: string; sub?: React.ReactNode;
}) => (
  <div className="flex flex-col min-w-0 px-2 py-1">
    <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</span>
    <span className={`text-base font-mono font-semibold leading-tight truncate ${tone ?? ""}`}>{value}</span>
    {sub && <span className="text-[9px] text-muted-foreground truncate">{sub}</span>}
  </div>
);

/**
 * Small-sample marker.
 *
 * Rendered wherever an average or a rate is shown over a thin sample, so a
 * 100% win rate over one trade cannot be read as a track record.
 */
export const SmallSampleTag = ({ n }: { n: number }) => (
  <span
    className="text-[9px] uppercase tracking-wider text-amber-600 border border-amber-500/40 bg-amber-500/10 px-1 ml-1 align-middle"
    title={`Fewer than ${SMALL_SAMPLE_MAX} closed trades — not a statistically meaningful sample.`}
  >
    small sample · n={n}
  </span>
);

const StageChip = ({ s }: { s: Stage }) => {
  const cls =
    s.status === "done" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-500 border-emerald-500/30"
    : s.status === "active" ? "bg-primary/15 text-primary border-primary/40"
    : s.status === "not_tracked" ? "bg-muted text-muted-foreground/70 border-dashed border-border"
    : "bg-muted/50 text-muted-foreground border-border";
  return (
    <div className={`flex flex-col border px-2 py-1 min-w-0 flex-1 ${cls}`} title={`${s.key} — ${s.detail}`}>
      <span className="text-[10px] font-semibold uppercase tracking-wider truncate">{s.label}</span>
      <span className="text-[9px] truncate opacity-80">
        {s.status === "not_tracked" ? <em>{s.detail}</em> : s.detail}
      </span>
    </div>
  );
};

const GroupTable = ({ title, rows }: { title: string; rows: Group[] }) => (
  <div className="min-w-0">
    <div className="text-[9px] uppercase tracking-wider text-muted-foreground mb-0.5">{title}</div>
    {rows.length === 0 ? (
      <p className="text-[10px] text-muted-foreground">no closed trades</p>
    ) : (
      <table className="w-full text-[10px] font-mono">
        <thead className="text-[9px] uppercase tracking-wider text-muted-foreground">
          <tr className="text-left">
            <th className="pr-2 font-normal">{title.split(" ").pop()}</th>
            <th className="pr-2 font-normal text-right">n</th>
            <th className="pr-2 font-normal text-right">w/l</th>
            <th className="pr-2 font-normal text-right">R</th>
            <th className="pr-2 font-normal text-right">avg</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => (
            <tr key={g.key} className="border-t border-border/40">
              <td className="pr-2 py-0.5 truncate">{g.key}</td>
              <td className="pr-2 text-right">
                {g.n}{g.smallSample && <span className="text-amber-600" title="thin bucket"> ·</span>}
              </td>
              <td className="pr-2 text-right text-muted-foreground">{g.wins}/{g.losses}</td>
              <td className={`pr-2 text-right ${rTone(g.totalR)}`}>{g.totalR.toFixed(2)}</td>
              <td className={`pr-2 text-right ${rTone(g.avgR)}`}>{g.avgR.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </div>
);

/**
 * Presentational dashboard.
 *
 * Exported separately from the fetching wrapper so it can be rendered in a test
 * with fixture data — a UI contract asserted by grepping the source is a weaker
 * claim than one asserted by mounting it.
 */
export function IpoPaperDashboard({ state, now = Date.now() }: { state: PaperState; now?: number }) {
  const [filters, setFilters] = useState<TradeFilters>(NO_FILTERS);
  const [eventPage, setEventPage] = useState(1);
  const [eventSize, setEventSize] = useState(15);
  const [tradePage, setTradePage] = useState(1);
  const [tradeSize, setTradeSize] = useState(10);
  const set = (k: keyof TradeFilters) => (v: string) => setFilters((f) => ({ ...f, [k]: v }));

  const h = state.health;
  const stale = state.healthStale;
  const m = useMemo(() => headline(state.openPositions, state.recentTrades),
                    [state.openPositions, state.recentTrades]);
  const opts = useMemo(() => filterOptions(state.recentTrades), [state.recentTrades]);
  const shown = useMemo(() => filterTrades(state.recentTrades, filters), [state.recentTrades, filters]);

  const stages = useMemo(() => lifecycleStages({
    validCandidates: state.recentEvents.filter((e) => e.event_type === "INTENT_CREATED").length,
    // No TOUCH event exists on this feed; the Scanner tab observes it directly.
    touched: null,
    openPositions: state.openPositions.length,
    closedAtTarget: state.recentTrades.filter((t) => t.exit_reason === "TARGET_2R").length,
    closedAtS2: state.recentTrades.filter((t) => t.exit_reason === "S2_CLOSE_INVALIDATION").length,
  }), [state.recentEvents, state.openPositions, state.recentTrades]);

  const splits = useMemo(() => exitReasonSplit(state.recentTrades), [state.recentTrades]);

  // Both lists grow without bound as the forward test runs. The decision list
  // used to be truncated at 40 rows with no way to see row 41 at all; paging it
  // shows everything the endpoint returned instead of silently dropping the tail.
  const eventsPage = useMemo(() => paginate(state.recentEvents, eventPage, eventSize),
                             [state.recentEvents, eventPage, eventSize]);
  const tradesPage = useMemo(() => paginate(shown, tradePage, tradeSize),
                             [shown, tradePage, tradeSize]);

  // No clamp-back effect: `paginate` clamps on read and IpoPager steps from the
  // clamped value, so a stale stored page cannot strand anyone. Writing it back
  // would race the filter reset below.
  // A filter change restarts the history at page 1.
  useEffect(() => { setTradePage(1); }, [filters]);

  return (
    <div className="flex flex-col gap-2 min-w-0">
      {/* ── 1. summary strip — trader metrics first ───────────────────────── */}
      <Card className="rounded-none">
        <CardHeader className="py-1.5 px-2 flex-row items-center justify-between space-y-0">
          <CardTitle className="text-[11px] font-bold uppercase tracking-wider">
            IPO forward test
          </CardTitle>
          <div className="flex items-center gap-1.5">
            {/* Always rendered, in every state of the page. Nothing here can trade,
                and the badge is the standing reminder of that. */}
            <Badge variant="outline" className="text-[9px] rounded-none font-semibold">PAPER</Badge>
            <Badge
              variant="outline"
              className={`text-[9px] rounded-none ${statusTone(h?.lastStatus ?? "FAILED", stale)}`}
              title={h ? `last run ${clock(h.lastRunAt)}` : "no heartbeat recorded"}
            >
              {!h ? "NO HEARTBEAT" : stale ? "STALE" : h.lastStatus}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="px-1 pb-2 pt-0">
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 divide-x divide-border/50">
            <Metric label="open" value={m.openPositions} />
            <Metric label="closed" value={m.closedTrades}
                    sub={m.abortedExcluded > 0 ? `${m.abortedExcluded} excluded` : undefined} />
            <Metric label="realized R" value={`${m.totalR >= 0 ? "+" : ""}${m.totalR.toFixed(2)}R`}
                    tone={rTone(m.totalR)} />
            <Metric label="realized P&L" value={`$${m.totalPnlUsd.toFixed(2)}`} tone={rTone(m.totalR)}
                    sub="nominal sizing" />
            <Metric label="win rate" value={`${(m.winRate * 100).toFixed(0)}%`}
                    sub={`${m.wins}W / ${m.losses}L`} />
            <Metric label="avg R" value={`${m.avgR >= 0 ? "+" : ""}${m.avgR.toFixed(2)}R`} tone={rTone(m.avgR)} />
            <Metric label="drawdown" value={`${m.drawdown.currentR.toFixed(2)}R`}
                    tone={m.drawdown.currentR > 0 ? "text-amber-600" : undefined}
                    sub={`max ${m.drawdown.maxR.toFixed(2)}R · ${m.drawdown.window} trades`} />
          </div>
          {m.smallSample && (
            <p className="text-[10px] text-amber-600 mt-1 px-1">
              <SmallSampleTag n={m.closedTrades} /> Win rate, average R and drawdown are
              descriptions of {m.closedTrades} closed {pluralTrades(m.closedTrades)},
              not estimates of future performance.
            </p>
          )}
          <p className="text-[9px] text-muted-foreground mt-1 px-1">
            R is the strategy result. Dollars are a view of it under the nominal sizing
            stored on each row and are NOT a maximum loss — S2 losses routinely exceed 1R.
            Drawdown covers the closed trades this endpoint returns, not all history.
          </p>
        </CardContent>
      </Card>

      {/* ── 2. open positions ─────────────────────────────────────────────── */}
      <Card className="rounded-none">
        <CardHeader className="py-1.5 px-2">
          <CardTitle className="text-[11px] font-bold uppercase tracking-wider">
            Open paper positions ({state.openPositions.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="px-2 pb-2 pt-0">
          {state.openPositions.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">Flat.</p>
          ) : state.openPositions.map((p) => {
            const plan = planGeometry(p);
            const gap = gapState(p);
            return (
              <div key={`${p.symbol}-${p.entry_time}`} className="border-t border-border/50 py-1.5 first:border-t-0">
                <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                  <span className="text-[13px] font-mono font-bold">{p.symbol}</span>
                  <Badge variant="outline"
                         className={`text-[9px] rounded-none uppercase font-semibold ${
                           p.direction === "long" ? "text-emerald-600 border-emerald-500/40"
                                                  : "text-destructive border-destructive/40"}`}>
                    {p.direction}
                  </Badge>
                  <Badge variant="outline" className="text-[9px] rounded-none">{p.volatility_bucket}</Badge>
                  {p.status === "data_gap_suspended" && (
                    <Badge variant="outline" className={`text-[9px] rounded-none ${toneClass(gap.tone)}`}
                           title={`${gap.code} — ${gap.detail}`}>
                      SUSPENDED · {p.gap_reason}
                    </Badge>
                  )}
                  {(p.zone_entry_ordinal ?? 1) > 1 && (
                    <Badge variant="outline" className="text-[9px] rounded-none bg-primary/10 text-primary border-primary/40">
                      RE-ENTRY #{p.zone_entry_ordinal}
                    </Badge>
                  )}
                  <span className="ml-auto text-[10px] text-muted-foreground font-mono">
                    opened {ago(p.entry_time, now)}
                  </span>
                </div>
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-x-3 gap-y-1">
                  <Field label="entry" value={px(p.entry_price)} />
                  <Field label="target 2R" value={px(p.target_price)} tone="text-emerald-600" />
                  <Field label="S2" value={px(p.s2_invalidation_level)} tone="text-destructive" />
                  <Field label="entry→target" value={`${px(plan.toTarget)} · ${plan.toTargetR.toFixed(2)}R`} />
                  <Field label="entry→S2" value={`${px(plan.toS2)} · ${plan.toS2R.toFixed(2)}R`} />
                  <Field label="gap state" value={gap.headline}
                         tone={gap.tone === "good" ? "text-muted-foreground" : "text-amber-600"} />
                  <Field label="best so far" value={`${p.mfe_r.toFixed(2)}R`} tone="text-emerald-600" />
                  <Field label="worst so far" value={`${p.mae_r.toFixed(2)}R`} tone="text-destructive" />
                  <Field label="zone ordinal"
                         value={`${p.zone_entry_ordinal ?? "—"} · ${ordinalPhrase(p.zone_entry_ordinal)}`} />
                  <Field label="prev zone exit" value={clock(p.zone_previous_exit_time)} />
                  <Field label="IPO candle" value={clock(p.ipo_candle_time)} />
                  <Field label="entry time" value={clock(p.entry_time)} />
                  <Field label="risk $" value={`$${p.nominal_risk_usd}`} />
                  <Field label="costR" value={p.cost_r.toFixed(4)} />
                  <Field label="managed through" value={clock(p.last_managed_bar_time)} />
                  <Field label="mode" value="paper" />
                </div>
              </div>
            );
          })}
          <p className="text-[9px] text-muted-foreground mt-1">
            Distances are PLAN geometry measured from entry. There is no current price on
            this page: no column stores one for an IPO position and the read endpoint
            fetches no candles, so unrealized R is not shown rather than guessed.
            Best/worst so far are the stored excursions, updated on every managed bar.
          </p>
        </CardContent>
      </Card>

      {/* ── 3. lifecycle ──────────────────────────────────────────────────── */}
      <Card className="rounded-none">
        <CardHeader className="py-1.5 px-2">
          <CardTitle className="text-[11px] font-bold uppercase tracking-wider">
            Lifecycle
          </CardTitle>
        </CardHeader>
        <CardContent className="px-2 pb-2 pt-0">
          <div className="flex items-stretch gap-1 flex-wrap sm:flex-nowrap">
            {stages.map((s, i) => (
              <React.Fragment key={s.key}>
                {i > 0 && <span className="self-center text-muted-foreground text-[10px]">→</span>}
                <StageChip s={s} />
              </React.Fragment>
            ))}
          </div>
          <p className="text-[9px] text-muted-foreground mt-1">
            Trend is shown as not tracked because the frozen rules do not compute it — it
            belongs to the research state machine. A tick or a cross there would be a
            fabrication. Touch is observed in the Scanner tab; this feed records intents,
            not touches, and inferring one from the other would be a guess.
          </p>
        </CardContent>
      </Card>

      {/* ── 4. why no trade? ──────────────────────────────────────────────── */}
      <Card className="rounded-none">
        <CardHeader className="py-1.5 px-2">
          <CardTitle className="text-[11px] font-bold uppercase tracking-wider">
            Why no trade?
          </CardTitle>
        </CardHeader>
        <CardContent className="px-2 pb-2 pt-0 overflow-x-auto">
          <table className="w-full text-[11px] whitespace-nowrap">
            <thead className="text-[9px] uppercase tracking-wider text-muted-foreground">
              <tr className="text-left">
                <th className="pr-3 font-normal">bar</th>
                <th className="pr-3 font-normal">sym</th>
                <th className="pr-3 font-normal">what happened</th>
                <th className="pr-3 font-normal">what it proves</th>
                <th className="pr-3 font-normal">raw</th>
              </tr>
            </thead>
            <tbody>
              {state.recentEvents.length === 0 && (
                <tr><td colSpan={5} className="text-muted-foreground py-1">No decisions recorded yet.</td></tr>
              )}
              {eventsPage.items.map((e, i) => {
                const costR = e.payload?.costR as number | undefined;
                const block = e.payload?.blockReason as string | undefined;
                // The EXECUTION EVENT decides the headline; the strategy verdict is
                // secondary. Reading it the other way round is what rendered a
                // filled trade as "Strategy would enter".
                const ev = readEvent(e);
                return (
                  <tr key={`${e.bar_time}-${e.event_type}-${i}`} className="border-t border-border/50">
                    <td className="pr-3 py-0.5 font-mono text-muted-foreground">{clock(e.bar_time)}</td>
                    <td className="pr-3 font-mono">{e.symbol}</td>
                    <td className="pr-3">
                      <span className={`px-1 border text-[9px] ${toneClass(ev.tone)}`}>{ev.whatHappened}</span>
                      {/* Never the headline. A verdict is not an entry. */}
                      <div className="text-[9px] text-muted-foreground/80 mt-0.5">{ev.strategyVerdict}</div>
                    </td>
                    <td className="pr-3 text-muted-foreground whitespace-normal max-w-[28rem]">
                      {ev.meaning}
                      {costR !== undefined && ` (costR ${costR.toFixed(4)})`}
                    </td>
                    {/* The raw code is never discarded — this dashboard monitors a system
                        that still needs debugging, and a pretty label alone cannot do it. */}
                    <td className="pr-3 font-mono text-[9px] text-muted-foreground/70"
                        title={`event ${e.event_type} · strategy ${e.strategy_decision} · account ${e.account_decision}` +
                               (e.reason_codes?.length ? ` · ${e.reason_codes.join(", ")}` : "")}>
                      {e.event_type} / {e.strategy_decision} / {e.account_decision}
                      {block && ` / ${block}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {state.recentEvents.length > 0 && (
            <IpoPager page={eventsPage} onPage={setEventPage} size={eventSize}
                      onSize={(n) => { setEventSize(n); setEventPage(1); }}
                      sizes={[15, 30, 60]} label="events" />
          )}
          <p className="text-[9px] text-muted-foreground mt-1">
            <strong>{ENTRY_PROOF_NOTE}</strong> A refused row still shows strategy
            WOULD_ENTER: the IPO signal stays valid and
            only execution was blocked, so the cost of that rule stays measurable. Hover
            the raw column for the full event, both verdicts and every reason code.
          </p>
        </CardContent>
      </Card>

      {/* ── 5. performance ────────────────────────────────────────────────── */}
      <Card className="rounded-none">
        <CardHeader className="py-1.5 px-2 flex-row items-center justify-between space-y-0">
          <CardTitle className="text-[11px] font-bold uppercase tracking-wider">
            Performance
          </CardTitle>
          {m.smallSample && <SmallSampleTag n={m.closedTrades} />}
        </CardHeader>
        <CardContent className="px-2 pb-2 pt-0">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-x-3 gap-y-1 mb-2">
            <Field label="cumulative R" value={`${m.totalR.toFixed(3)}R`} tone={rTone(m.totalR)} />
            <Field label="closed" value={m.closedTrades} />
            <Field label="wins / losses" value={`${m.wins} / ${m.losses}`} />
            <Field label="average R" value={`${m.avgR.toFixed(3)}R`} tone={rTone(m.avgR)} />
            <Field label="max drawdown" value={`${m.drawdown.maxR.toFixed(2)}R`} />
          </div>

          <div className="text-[9px] uppercase tracking-wider text-muted-foreground mb-0.5">exit reasons</div>
          {splits.length === 0 ? (
            <p className="text-[10px] text-muted-foreground mb-2">no closed trades</p>
          ) : (
            <div className="flex flex-wrap gap-1 mb-2">
              {splits.map((s) => {
                const ex = explainStatus(s.reason);
                return (
                  <span key={s.reason} className={`text-[10px] px-1.5 py-0.5 border ${toneClass(ex.tone)}`}
                        title={`${s.reason} — ${ex.detail}`}>
                    {ex.headline} · {s.n} ({(s.share * 100).toFixed(0)}%)
                  </span>
                );
              })}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <GroupTable title="by symbol" rows={bySymbol(state.recentTrades)} />
            <GroupTable title="by volatility bucket" rows={byBucket(state.recentTrades)} />
            <GroupTable title="by re-entry ordinal" rows={byOrdinal(state.recentTrades)} />
          </div>
          <p className="text-[9px] text-muted-foreground mt-1">
            A dot beside a count marks a bucket under {SMALL_SAMPLE_MAX} trades. Data-gap
            aborts carry no R and are excluded from every average here, but are still
            counted in the exit-reason split — a run that keeps aborting should be visible.
          </p>
        </CardContent>
      </Card>

      {/* ── 6. trade history + filters ────────────────────────────────────── */}
      <Card className="rounded-none">
        <CardHeader className="py-1.5 px-2 flex-row items-center justify-between space-y-0 gap-2 flex-wrap">
          <CardTitle className="text-[11px] font-bold uppercase tracking-wider">
            Trade history
            <span className="text-muted-foreground font-normal ml-1">
              ({shown.length}{filterIsActive(filters) ? ` of ${state.recentTrades.length}` : ""})
            </span>
          </CardTitle>
          {/* Client-side only. The state endpoint already returned every row these
              dropdowns choose between, so a filter costs nothing at the backend. */}
          <div className="flex gap-1 flex-wrap items-center">
            <Select value={filters.symbol} onValueChange={set("symbol")}>
              <SelectTrigger className="h-6 w-[110px] text-[10px]" aria-label="Filter by symbol"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All symbols</SelectItem>
                {opts.symbols.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={filters.bucket} onValueChange={set("bucket")}>
              <SelectTrigger className="h-6 w-[110px] text-[10px]" aria-label="Filter by volatility bucket"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All volatility</SelectItem>
                {opts.buckets.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={filters.ordinal} onValueChange={set("ordinal")}>
              <SelectTrigger className="h-6 w-[100px] text-[10px]" aria-label="Filter by entry ordinal"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All ordinals</SelectItem>
                {opts.ordinals.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={filters.exitReason} onValueChange={set("exitReason")}>
              <SelectTrigger className="h-6 w-[140px] text-[10px]" aria-label="Filter by exit reason"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All exits</SelectItem>
                {opts.exitReasons.map((r) => (
                  <SelectItem key={r} value={r}>{explainStatus(r).headline}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <input type="date" value={filters.from} onChange={(e) => set("from")(e.target.value)}
                   aria-label="Filter from date"
                   className="h-6 text-[10px] bg-background border border-input px-1 text-foreground" />
            <input type="date" value={filters.to} onChange={(e) => set("to")(e.target.value)}
                   aria-label="Filter to date"
                   className="h-6 text-[10px] bg-background border border-input px-1 text-foreground" />
            {filterIsActive(filters) && (
              <button onClick={() => setFilters(NO_FILTERS)}
                      className="h-6 text-[10px] px-1.5 border border-input text-muted-foreground hover:text-foreground">
                clear
              </button>
            )}
          </div>
        </CardHeader>
        <CardContent className="px-2 pb-2 pt-0 overflow-x-auto">
          <table className="w-full text-[11px] font-mono whitespace-nowrap">
            <thead className="text-[9px] uppercase tracking-wider text-muted-foreground">
              <tr className="text-left">
                <th className="pr-3 font-normal">exit</th>
                <th className="pr-3 font-normal">sym</th>
                <th className="pr-3 font-normal">side</th>
                <th className="pr-3 font-normal">entry → exit</th>
                <th className="pr-3 font-normal">outcome</th>
                <th className="pr-3 font-normal text-right">R</th>
                <th className="pr-3 font-normal text-right">P&amp;L</th>
                <th className="pr-3 font-normal text-right">ord</th>
                <th className="pr-3 font-normal">prev exit</th>
                <th className="pr-3 font-normal">IPO candle</th>
                <th className="pr-3 font-normal">vol</th>
                <th className="pr-3 font-normal text-right">MAE</th>
                <th className="pr-3 font-normal text-right">MFE</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr><td colSpan={13} className="text-muted-foreground py-1">
                  {state.recentTrades.length === 0
                    ? "No closed paper trades yet."
                    : "No trades match these filters."}
                </td></tr>
              )}
              {tradesPage.items.map((t, i) => {
                const ex = explainStatus(t.exit_reason);
                return (
                  <tr key={`${t.symbol}-${t.exit_time}-${i}`} className="border-t border-border/50">
                    <td className="pr-3 py-0.5">{clock(t.exit_time)}</td>
                    <td className="pr-3">{t.symbol}</td>
                    <td className={`pr-3 ${t.direction === "long" ? "text-emerald-600" : "text-destructive"}`}>
                      {t.direction}
                    </td>
                    <td className="pr-3 text-muted-foreground">
                      {px(t.entry_price)} → {t.exit_price === null ? "—" : px(t.exit_price)}
                    </td>
                    <td className="pr-3" title={`${t.exit_reason} — ${ex.detail}`}>
                      <span className={`px-1 border text-[9px] ${toneClass(ex.tone)}`}>{ex.headline}</span>
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
                    <td className="pr-3 text-right text-muted-foreground">{t.mfe_r?.toFixed(2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {shown.length > 0 && (
            <IpoPager page={tradesPage} onPage={setTradePage} size={tradeSize}
                      onSize={(n) => { setTradeSize(n); setTradePage(1); }}
                      label={pluralTrades(tradeSize)} />
          )}
          <p className="text-[9px] text-muted-foreground mt-1">
            Target and S2 are on each row through the outcome column; hover it for the raw
            exit_reason. Aborted rows carry no R and are excluded from the summary, but are
            still listed.
          </p>
        </CardContent>
      </Card>

      {/* ── 7. health and data status — engineering detail, deliberately last ─ */}
      <Card className="rounded-none border-border/60">
        <CardHeader className="py-1.5 px-2 flex-row items-center justify-between space-y-0">
          <CardTitle className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Runner health &amp; data status
          </CardTitle>
          <Badge variant="outline"
                 className={`text-[9px] rounded-none ${statusTone(h?.lastStatus ?? "FAILED", stale)}`}>
            {!h ? "NO HEARTBEAT" : stale ? "STALE" : h.lastStatus}
          </Badge>
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
                <Field label="last run" value={`${ago(h.lastRunAt, now)} · ${clock(h.lastRunAt)}`} />
                <Field
                  label="last success"
                  value={h.lastSuccessAt ? `${ago(h.lastSuccessAt, now)} · ${clock(h.lastSuccessAt)}` : "never"}
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

          <div className="mt-2 overflow-x-auto">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground mb-0.5">
              Instrument state
            </div>
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
                {state.runtime.length === 0 && (
                  <tr><td colSpan={5} className="text-muted-foreground py-1">no runtime state</td></tr>
                )}
                {state.runtime.map((r) => (
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
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

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
  return <IpoPaperDashboard state={data} />;
}

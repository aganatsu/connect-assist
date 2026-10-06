/**
 * System Reset & Ledger Health — admin card.
 *
 * `SystemResetPanel` is presentational: it renders whatever readiness the
 * server returned and calls back for refresh / dry run / execute. The fetching
 * wrapper is `SystemResetCard` at the bottom of this file.
 *
 * Enabling a button here is a convenience, not a control. The system-reset
 * function re-checks the admin, readiness, the typed phrase, the fingerprint
 * and the server-side execution switch on every execute.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CheckCircle2, XCircle, RefreshCw, ShieldAlert, Lock } from "lucide-react";
import {
  canApprove, CONFIRMATION_PHRASE, phraseMatches, usd, type Readiness, type ResetResult,
} from "@/lib/systemReset";

const ts = (s: string | null | undefined) => (s ? new Date(s).toLocaleString() : "—");

function Metric({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "good" | "bad" | "warn" }) {
  const color = tone === "good" ? "text-emerald-500" : tone === "bad" ? "text-red-500" : tone === "warn" ? "text-amber-500" : "";
  return (
    <div className="rounded-md border p-2" data-testid={`metric-${label}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-sm font-semibold ${color}`}>{value}</div>
    </div>
  );
}

export interface SystemResetPanelProps {
  readiness: Readiness;
  onRefresh?: () => void;
  onDryRun?: () => void;
  onExecute?: (req: { confirmation: string; fingerprint: string; requested_at: string }) => Promise<ResetResult>;
  dryRun?: { plan: { close_at_market: { position_id: string; symbol: string; direction: string; size: number; entry: number; exit: number; pnl: number; missing_rate: string | null }[]; old_period_pnl_from_closes: number } } | null;
  busy?: boolean;
}

export function SystemResetPanel({ readiness: r, onRefresh, onDryRun, onExecute, dryRun, busy }: SystemResetPanelProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [requestedAt, setRequestedAt] = useState<string | null>(null);
  const [result, setResult] = useState<ResetResult | null>(null);
  const [running, setRunning] = useState(false);
  const m = r.metrics;
  const approvable = canApprove(r);

  const openDialog = () => { setTyped(""); setRequestedAt(new Date().toISOString()); setDialogOpen(true); };
  const execute = async () => {
    if (!onExecute || !phraseMatches(typed) || !requestedAt) return;
    setRunning(true);
    try {
      setResult(await onExecute({ confirmation: typed, fingerprint: r.fingerprint, requested_at: requestedAt }));
    } finally {
      setRunning(false);
      setDialogOpen(false);
    }
  };

  return (
    <Card data-testid="system-reset-panel">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5" /> System Reset &amp; Ledger Health
        </CardTitle>
        <div className="flex items-center gap-2">
          <Badge data-testid="readiness-badge" variant={r.ready ? "default" : "destructive"}>
            Reset readiness: {r.ready ? "READY" : "NOT READY"}
          </Badge>
          {onRefresh && (
            <Button size="sm" variant="outline" onClick={onRefresh} disabled={busy}>
              <RefreshCw className="h-4 w-4 mr-1" /> Refresh
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* ── Health ── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <Metric label="Ledger monitor" value={r.monitor.status} tone={r.monitor.status === "PASS" ? "good" : "bad"} />
          <Metric label="24h monitoring window" value={r.window.status} tone={r.window.status === "Complete" ? "good" : "warn"} />
          <Metric label="Monitoring started" value={ts(r.window.started_at)} />
          <Metric label="Monitoring completes" value={ts(r.window.completes_at)} />
          <Metric label="Last successful monitor run" value={ts(r.monitor.last_pass_at)} />
          <Metric label="Reconciliation drift" value={m.drift === null ? "—" : usd(m.drift)} tone={m.drift === 0 ? "good" : "bad"} />
          <Metric label="Unledgered / direct balance writes" value={m.unledgered_writes} tone={m.unledgered_writes === 0 ? "good" : "bad"} />
          <Metric label="Closed trades without settlement" value={m.unsettled_closes} tone={m.unsettled_closes === 0 ? "good" : "bad"} />
          <Metric label="Duplicate settlements" value={m.duplicate_settlements} tone={m.duplicate_settlements === 0 ? "good" : "bad"} />
          <Metric label="Stored balance" value={usd(m.balance)} />
          <Metric label="Equity" value={usd(m.equity)} />
          <Metric label="Open positions" value={m.open_positions} />
          <Metric label="Pending orders" value={m.pending_orders} />
          <Metric label="Watched / armed setups" value={m.active_setups} />
          <Metric label="Direct-write guard" value={m.guard_mode} tone={m.guard_mode === "BLOCKING" ? "good" : "warn"} />
          <Metric label="Reset readiness" value={r.ready ? "READY" : "NOT READY"} tone={r.ready ? "good" : "bad"} />
        </div>

        {/* ── Prerequisites ── */}
        <div>
          <h3 className="text-sm font-semibold mb-2">Reset prerequisites</h3>
          <ul className="space-y-1" data-testid="prerequisites">
            {r.conditions.map((c) => (
              <li key={c.key} className="flex items-start gap-2 text-sm" data-testid={`condition-${c.key}`} data-pass={c.pass}>
                {c.pass ? <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5" /> : <XCircle className="h-4 w-4 text-red-500 mt-0.5" />}
                <span className={c.pass ? "" : "font-medium"}>{c.label}</span>
                <span className="text-muted-foreground">— {c.detail}</span>
              </li>
            ))}
          </ul>
          {!r.ready && (
            <p className="mt-2 text-sm text-red-500" data-testid="blocking-summary">
              Blocking the reset: {r.blocking.map((b) => b.label).join("; ")}
            </p>
          )}
        </div>

        {/* ── Old-period exposure ── */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Old-period exposure — closed / cancelled at reset</h3>
          <Table data-testid="old-positions">
            <TableHeader>
              <TableRow><TableHead>Position</TableHead><TableHead>Symbol</TableHead><TableHead>Side</TableHead><TableHead>Size</TableHead>
                <TableHead>Entry</TableHead><TableHead>Current</TableHead><TableHead>Unrealized</TableHead><TableHead>Opened</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {r.old_period.positions.length === 0 && <TableRow><TableCell colSpan={8} className="text-muted-foreground">No open positions</TableCell></TableRow>}
              {r.old_period.positions.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-mono">{p.position_id}</TableCell><TableCell>{p.symbol}</TableCell><TableCell>{p.direction}</TableCell>
                  <TableCell>{p.size}</TableCell><TableCell>{p.entry_price}</TableCell><TableCell>{p.current_price ?? "—"}</TableCell>
                  <TableCell>{usd(p.unrealized_usd)}</TableCell><TableCell>{ts(p.open_time)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Table data-testid="old-orders">
            <TableHeader>
              <TableRow><TableHead>Order</TableHead><TableHead>Symbol</TableHead><TableHead>Side</TableHead><TableHead>Status</TableHead>
                <TableHead>Entry</TableHead><TableHead>Placed</TableHead><TableHead>Expires</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {r.old_period.pending.length === 0 && <TableRow><TableCell colSpan={7} className="text-muted-foreground">No pending orders</TableCell></TableRow>}
              {r.old_period.pending.map((o) => (
                <TableRow key={o.id}>
                  <TableCell className="font-mono">{o.order_id}</TableCell><TableCell>{o.symbol}</TableCell><TableCell>{o.direction}</TableCell>
                  <TableCell>{o.status}</TableCell><TableCell>{o.entry_price ?? "—"}</TableCell><TableCell>{ts(o.placed_at)}</TableCell><TableCell>{ts(o.expires_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {r.old_period.setups.length > 0 && (
            <p className="text-sm" data-testid="old-setups">
              Watched/armed setups to cancel: {r.old_period.setups.map((s) => `${s.symbol ?? "?"} ${s.direction ?? ""} (${s.status})`).join(", ")}
            </p>
          )}
        </div>

        {/* ── Dry run ── */}
        {onDryRun && (
          <div className="space-y-2">
            <Button size="sm" variant="outline" onClick={onDryRun} disabled={busy}>Preview reset plan (no changes)</Button>
            {dryRun && (
              <div className="text-sm rounded-md border p-2" data-testid="dry-run">
                <div className="font-medium mb-1">If executed now, the reset would close at market:</div>
                <ul>
                  {dryRun.plan.close_at_market.map((p) => (
                    <li key={p.position_id}>{p.symbol} {p.direction} {p.size} @ {p.exit} → {usd(p.pnl)}{p.missing_rate ? ` (missing ${p.missing_rate} — would STOP)` : ""}</li>
                  ))}
                  {dryRun.plan.close_at_market.length === 0 && <li>nothing — no open positions</li>}
                </ul>
                <div>Old-period P/L from these closes: {usd(dryRun.plan.old_period_pnl_from_closes)}</div>
              </div>
            )}
          </div>
        )}

        {/* ── Approval ── */}
        <div className="space-y-2 border-t pt-4">
          {!r.execute_enabled && (
            <p className="flex items-center gap-2 text-sm text-amber-500" data-testid="execute-disabled">
              <Lock className="h-4 w-4" /> The destructive reset is disabled server-side until you approve enabling it.
            </p>
          )}
          <Button variant="destructive" onClick={openDialog} disabled={!approvable || running} data-testid="approve-button">
            Approve Full Demo Reset
          </Button>
          {result && (
            <div className="text-sm rounded-md border p-2" data-testid="reset-result">
              <div className="font-medium">Reset {result.status.toUpperCase()} {result.resetId ? `(${result.resetId})` : ""}</div>
              {result.failedStep && <div className="text-red-500">Stopped at {result.failedStep}: {result.reason} — bot left paused.</div>}
              {result.status === "succeeded" && <div>Trading remains paused and entries locked until the new configuration is approved.</div>}
              {result.error && <div className="text-red-500">{result.error}</div>}
              {result.verification && (
                <ul>{result.verification.map((v) => <li key={v.key}>{v.pass ? "✓" : "✗"} {v.label} ({v.detail})</li>)}</ul>
              )}
            </div>
          )}
        </div>

        {/* ── Audit trail ── */}
        {r.recent_runs && r.recent_runs.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold mb-1">Reset attempts (permanent record)</h3>
            <ul className="text-sm space-y-1" data-testid="recent-runs">
              {r.recent_runs.map((x) => (
                <li key={x.reset_id}><span className="font-mono">{x.reset_id.slice(0, 8)}</span> {x.status} · requested {ts(x.requested_at)}
                  {x.failed_step ? ` · stopped at ${x.failed_step}: ${x.failure_reason}` : ""}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-xs text-muted-foreground">Readiness computed {ts(r.generated_at)} · fingerprint {r.fingerprint.slice(0, 12)}</p>
      </CardContent>

      <AlertDialog open={dialogOpen} onOpenChange={(o) => !running && setDialogOpen(o)}>
        <AlertDialogContent data-testid="confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Approve full demo reset to $100,000</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <div>Current balance: <b>{usd(m.balance)}</b> · Current equity: <b>{usd(m.equity)}</b></div>
                <div>Open positions: <b>{m.open_positions}</b> · Pending orders: <b>{m.pending_orders}</b> · Watched/armed setups: <b>{m.active_setups}</b></div>
                <div className="text-red-500">All old-period positions will be closed at market and settled to the OLD period; all old-period pending orders and setups will be cancelled.</div>
                <div className="text-red-500">Active trading state (balance, equity baseline, daily P/L, drawdown baseline, counters) will be reset.</div>
                <div className="font-medium">Trading will NOT resume after the reset. The account stays paused and new entries stay locked until the simplified configuration is built, verified and separately approved.</div>
                <div>Historical trades, research data, the ledger, the pre-reset snapshots and this audit trail are preserved.</div>
                <div>Type <code className="font-mono">{CONFIRMATION_PHRASE}</code> to enable the final button.</div>
                <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={CONFIRMATION_PHRASE} data-testid="confirm-input" autoComplete="off" />
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={running}>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={execute} disabled={!phraseMatches(typed) || running} data-testid="final-confirm">
              {running ? "Resetting…" : "Execute reset"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// ─── Fetching wrapper ───────────────────────────────────────────────────────

async function callSystemReset<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("system-reset", { body });
  if (error) {
    // Non-2xx (an aborted or failed reset) still carries the run outcome.
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === "function") {
      try { return (await ctx.json()) as T; } catch { /* fall through */ }
    }
    throw error;
  }
  return data as T;
}

export function SystemResetCard() {
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ["system-reset-readiness"],
    queryFn: () => callSystemReset<Readiness>({ action: "readiness" }),
    refetchInterval: 60_000,
  });
  const [dryRun, setDryRun] = useState<SystemResetPanelProps["dryRun"]>(null);

  if (error) {
    return (
      <Card><CardContent className="p-4 text-sm text-red-500">
        System Reset &amp; Ledger Health unavailable: {(error as Error).message}. (Admins only.)
      </CardContent></Card>
    );
  }
  if (!data) return <Card><CardContent className="p-4 text-sm">Loading ledger health…</CardContent></Card>;
  return (
    <SystemResetPanel
      readiness={data}
      busy={isFetching}
      onRefresh={() => refetch()}
      onDryRun={async () => setDryRun(await callSystemReset({ action: "dry_run" }))}
      onExecute={async (req) => {
        const res = await callSystemReset<ResetResult>({ action: "execute", ...req });
        await refetch();
        return res;
      }}
      dryRun={dryRun}
    />
  );
}

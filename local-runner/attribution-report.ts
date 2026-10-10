/**
 * STEP 16-B — dry-run attribution report: raw vs cap-adjusted. READ-ONLY.
 *
 * Reads every hypothetical fill from trade_attribution (SELECT only) and prints
 * the raw per-fill outcomes beside the live-cap model (3 global / 1 per symbol)
 * and the caps + correlation model, with the reason and the blocking
 * signal/order for every blocked fill. Nothing is written anywhere.
 *
 * Usage: deno run --allow-read --allow-net local-runner/attribution-report.ts [--json]
 * (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from local-runner/.env.local)
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildCapBook, type CapBookFill, type CapBookRow, configClassOf, type Totals,
} from "../supabase/functions/_shared/hypotheticalCapBook.ts";

const env: Record<string, string> = {};
for (const l of Deno.readTextFileSync(new URL("./.env.local", import.meta.url)).split("\n")) {
  const i = l.indexOf("=");
  if (i > 0 && !l.startsWith("#")) env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const ms = (s: string | null) => (s ? Date.parse(s) : null);
const num = (x: unknown) => (x == null ? null : Number(x));

const rowsOut: Record<string, unknown>[] = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from("trade_attribution")
    .select("signal_id, order_id, symbol, direction, order_placed_at, filled_at, closed_at, exit_reason, realized_r_gross, realized_r_net, realized_pnl_usd, fill_risk_usd, config_version")
    // bot "smc" only: the Candidate C shadow (bot smc_shadow_zonemid) writes hypothetical fills too
    .eq("fill_kind", "hypothetical").eq("bot_id", "smc").order("filled_at", { ascending: true }).range(from, from + 999);
  if (error) throw new Error(`trade_attribution: ${error.message}`);
  rowsOut.push(...(data ?? []));
  if (!data || data.length < 1000) break;
}

const fills: CapBookFill[] = rowsOut.map((r: any) => ({
  signalId: r.signal_id, orderId: r.order_id ?? null, symbol: r.symbol, direction: r.direction,
  placedAtMs: ms(r.order_placed_at), filledAtMs: Date.parse(r.filled_at), closedAtMs: ms(r.closed_at),
  exitReason: r.exit_reason ?? null, rGross: num(r.realized_r_gross), rNet: num(r.realized_r_net),
  pnlUsd: num(r.realized_pnl_usd), riskUsd: num(r.fill_risk_usd), configVersion: r.config_version ?? null,
}));

const nowMs = Date.now();
const report = buildCapBook(fills, { nowMs });

if (Deno.args.includes("--json")) {
  console.log(JSON.stringify({ generatedAt: new Date(nowMs).toISOString(), ...report }, null, 1));
  Deno.exit(0);
}

const r2 = (x: number) => (Math.round(x * 10000) / 10000).toString();
const usd = (x: number) => `$${x.toFixed(2)}`;
const fmtTotals = (label: string, t: Totals & { blocked?: number }) =>
  `  ${label.padEnd(14)} fills ${t.fills}${t.blocked != null ? ` (blocked ${t.blocked})` : ""}, resolved ${t.resolved}, open ${t.open} | ` +
  `gross R ${r2(t.grossR)} | net R ${r2(t.netR)}${t.missingNet ? ` (${t.missingNet} without net)` : ""} | ` +
  `P/L ${usd(t.pnlUsd)} | net P/L ${usd(t.pnlNetUsd)}`;
const v = (x: CapBookRow["caps"]) =>
  x.status === "admissible" ? "admissible" : `${x.reason} ← ${x.blockedBy.map((b) => `${b.signalId.slice(0, 8)}/${b.orderId ?? "?"}`).join(", ")}`;

console.log(`Dry-run attribution report (${report.version}) — ${new Date(nowMs).toISOString().slice(0, 16)} UTC`);
console.log(`correlation: ${report.correlation}`);
for (const a of report.assumptions) console.log(`  · ${a}`);
console.log("\nPer fill (chronological):");
for (const r of report.rows) {
  const f = r.fill;
  console.log(`  ${f.signalId.slice(0, 8)}/${f.orderId ?? "?"} ${f.symbol} ${f.direction} filled ${new Date(f.filledAtMs).toISOString().slice(0, 16)}` +
    ` ${r.resolved ? `closed ${new Date(f.closedAtMs as number).toISOString().slice(0, 16)} ${f.exitReason} R ${r2(f.rGross ?? NaN)} net ${r2(f.rNet ?? NaN)}` : "open"}` +
    ` [${configClassOf(f.configVersion)}]\n      caps: ${v(r.caps)}\n      caps+correlation: ${v(r.limits)}${r.limits.correlation === "correlation_not_evaluable" ? " (correlation_not_evaluable: no placement time)" : ""}`);
}
for (const [label, t] of Object.entries(report.byClass)) {
  console.log(`\nTotals — ${label}`);
  console.log(fmtTotals("raw", t.raw));
  console.log(fmtTotals("cap-adjusted", t.capAdjusted));
  console.log(fmtTotals("caps+corr", t.limitsAdjusted));
}
if (!report.singleClass) {
  console.log("\nMore than one behaviour class present: no pooled total is printed (see CONFIG_EQUIVALENCE_CLASSES).");
}

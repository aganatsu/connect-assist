/**
 * IPO observation endpoint. READ-ONLY, and WARM-ONLY.
 *
 * Returns what the frozen IPO rules currently see. It places no orders, writes
 * no trading state, and touches no SMC table. Tests assert it cannot reach
 * broker-execute, paper_positions, pending_orders, paper_trade_history or
 * paper_accounts at any depth of its import closure.
 *
 * IT NO LONGER BOOTSTRAPS, AND IT MUST NOT LEARN HOW AGAIN.
 *
 * The first real deployment of this function, 2026-09-21, failed every
 * invocation with WORKER_RESOURCE_LIMIT — a single instrument, 3 to 16 seconds,
 * killed for compute rather than wall clock. A 1,200-bar rebuild costs about 17
 * seconds of CPU and an Edge Function's budget is a few seconds. The gap is
 * roughly an order of magnitude, so it is not something a tighter loop or a
 * shorter history closes. It is the wrong place to do the work.
 *
 * The bootstrap therefore lives off-Edge in `local-runner/ipo-bootstrap.ts`,
 * which writes the D.1 runtime state. This function restores that state and
 * advances it by the few bars that have closed since. Measured in D.1: restore
 * 2.9 ms, one new bar 41 ms, export 4.6 ms.
 *
 * FAIL CLOSED. With no compatible state it returns BOOTSTRAP_REQUIRED and stops.
 * It does not rebuild, and it does not fetch candles first — a fallback would
 * reintroduce exactly the failure above, intermittently, while spending metered
 * provider credits on the way to being killed.
 *
 * CLOSED BARS ONLY. A forming bar would move both the volatility bucket and the
 * S2 test, so the snapshot would describe a state that never existed.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { fetchCandlesWithFallback } from "../_shared/candleSource.ts";
import { setCreditCallerContext } from "../_shared/apiCreditBudget.ts";
import {
  closedBarsOnly, snapshotOf, type IpoObservationSnapshot,
} from "../_shared/ipoObservation.ts";
import {
  IPO_INSTRUMENTS, INCREMENTAL_BARS, engineStateKey, engineConfig, exportMeta,
} from "../_shared/ipoInstruments.ts";
import {
  restoreState, continuityCheck, exportState, serializeState,
  type RebuildReason,
} from "../_shared/ipoEngineState.ts";
import type { Candle } from "../_shared/smcAnalysis.ts";

export interface ObservationRun {
  instrument: string;
  status: "OK" | "BOOTSTRAP_REQUIRED" | "ERROR";
  /** Why state could not be used. Never silent. */
  reason?: RebuildReason;
  detail?: string;
  barsInState?: number;
  barsFetched?: number;
  barsProcessed?: number;
  restoreMs?: number;
  processMs?: number;
  persistMs?: number;
  error?: string;
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    setCreditCallerContext("ipo-observation");
    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    const only = new URL(req.url).searchParams.get("instrument");
    const now = Date.now();
    const snapshots: IpoObservationSnapshot[] = [];
    const runs: ObservationRun[] = [];

    for (const cfg of IPO_INSTRUMENTS) {
      if (only && only !== cfg.instrument) continue;
      const out: ObservationRun = { instrument: cfg.instrument, status: "OK" };
      try {
        const ec = engineConfig(cfg);
        const meta = exportMeta(cfg);

        // ── restore, or stop. No candle is fetched before this succeeds. ─────
        const t0 = Date.now();
        const { data: row } = await db.from("kv_cache").select("value")
          .eq("key", engineStateKey(cfg.instrument)).maybeSingle();
        const restored = restoreState(row?.value ?? null, ec, meta);
        out.restoreMs = Date.now() - t0;

        if (!restored.ok) {
          out.status = "BOOTSTRAP_REQUIRED";
          out.reason = restored.reason;
          out.detail = restored.detail;
          runs.push(out);
          continue;
        }
        out.barsInState = restored.state.barCount;

        // ── only now is a provider request worth making ──────────────────────
        const { candles } = await fetchCandlesWithFallback({
          symbol: cfg.instrument, interval: cfg.timeframe, limit: INCREMENTAL_BARS,
          // READ-ONLY. candleSource otherwise writes a newly discovered symbol
          // mapping back to broker_connections, an SMC-owned table.
          persistSymbolOverrides: false,
        } as Parameters<typeof fetchCandlesWithFallback>[0]);
        out.barsFetched = candles?.length ?? 0;

        const page = closedBarsOnly((candles ?? []) as Candle[], now, cfg.barMs);
        const cont = continuityCheck(restored.state, page);
        if (!cont.ok) {
          // A hole we cannot prove is absent. Re-anchoring is a bootstrap, and
          // a bootstrap is not this function's job.
          out.status = "BOOTSTRAP_REQUIRED";
          out.reason = cont.reason;
          out.detail = cont.detail;
          runs.push(out);
          continue;
        }

        const p0 = Date.now();
        for (const b of cont.append) restored.engine.feed(b);
        out.processMs = Date.now() - p0;
        out.barsProcessed = cont.append.length;

        snapshots.push(snapshotOf(restored.engine, ec));

        // ── persist the advanced state: one row, one upsert ──────────────────
        if (cont.append.length > 0) {
          const w0 = Date.now();
          const next = serializeState(exportState(restored.engine, ec, meta));
          const { error } = await db.from("kv_cache").upsert({
            key: engineStateKey(cfg.instrument),
            value: next,
            expires_at: new Date(now + 365 * 24 * 3_600_000).toISOString(),
            updated_at: new Date(now).toISOString(),
          }, { onConflict: "key" });
          out.persistMs = Date.now() - w0;
          if (error) throw new Error(`state write failed: ${error.message}`);
        }
        runs.push(out);
      } catch (e) {
        out.status = "ERROR";
        out.error = (e as Error).message;
        runs.push(out);
      }
    }

    const needsBootstrap = runs.filter((r) => r.status === "BOOTSTRAP_REQUIRED");
    return respond({
      ok: needsBootstrap.length === 0 && runs.every((r) => r.status !== "ERROR"),
      mode: "OBSERVATION_ONLY",
      note: "No orders, no trading state, no broker. executionEligible is " +
            "informational. This function never bootstraps — run " +
            "local-runner/ipo-bootstrap.ts to create the runtime state.",
      bootstrapRequired: needsBootstrap.map((r) => r.instrument),
      runs, snapshots,
    });
  } catch (e) {
    return respond({ ok: false, error: (e as Error).message }, 500);
  }
}

if (import.meta.main) Deno.serve(handler);

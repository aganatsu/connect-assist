/**
 * IPO observation endpoint. PURE READ. It advances nothing and writes nothing.
 *
 * SINGLE-WRITER OWNERSHIP, AND WHY IT MATTERS MORE THAN IT SOUNDS.
 * This function used to restore the engine, fetch newly closed bars, advance the
 * state and persist it. That made **opening the UI tab a strategy action**: a
 * browser poll decided when the engine moved, two tabs could race to advance the
 * same instrument, and the paper runner could find state that observation had
 * already consumed. Strategy advancement is not a rendering concern.
 *
 * So the runtime now has exactly one normal writer:
 *
 *   local-runner/ipo-bootstrap.ts   cold start only — builds state from scratch
 *   ipo-paper-runner                the sole runtime owner — fetches new closed
 *                                   bars, advances the engine, persists
 *   ipo-observation (this)          reads that state and renders it
 *
 * Observation therefore shows exactly what the paper runner last acted on. A
 * snapshot that is a few bars behind is a true statement about the strategy; a
 * snapshot the UI advanced itself would be a different strategy.
 *
 * WHAT THIS BUYS BEYOND TIDINESS. Dropping the fetch drops `candleSource` from
 * the import closure, and with it the one write this function could transitively
 * reach — `broker_connections.symbol_overrides`. That exception is now gone
 * rather than guarded.
 *
 * IT STILL DOES NOT BOOTSTRAP. With no compatible state it returns
 * BOOTSTRAP_REQUIRED. A 1,200-bar rebuild costs ~17s of CPU against an Edge
 * budget of a few seconds; the first deployment proved that with
 * WORKER_RESOURCE_LIMIT on a single instrument.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { snapshotOf, type IpoObservationSnapshot } from "../_shared/ipoObservation.ts";
import {
  IPO_INSTRUMENTS, engineStateKey, engineConfig, exportMeta,
} from "../_shared/ipoInstruments.ts";
import { restoreState, type RebuildReason } from "../_shared/ipoEngineState.ts";

export interface ObservationRun {
  instrument: string;
  status: "OK" | "BOOTSTRAP_REQUIRED" | "ERROR";
  /** Why state could not be read. Never silent. */
  reason?: RebuildReason;
  detail?: string;
  /** Bars in the persisted state. This function never adds to them. */
  barsInState?: number;
  /** Newest closed bar the PAPER RUNNER has processed, not the newest that exists. */
  stateAsOf?: string;
  restoreMs?: number;
  error?: string;
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    const only = new URL(req.url).searchParams.get("instrument");
    const snapshots: IpoObservationSnapshot[] = [];
    const runs: ObservationRun[] = [];

    for (const cfg of IPO_INSTRUMENTS) {
      if (only && only !== cfg.instrument) continue;
      const out: ObservationRun = { instrument: cfg.instrument, status: "OK" };
      try {
        const ec = engineConfig(cfg);

        const t0 = Date.now();
        const { data: row } = await db.from("kv_cache").select("value")
          .eq("key", engineStateKey(cfg.instrument)).maybeSingle();
        const restored = restoreState(row?.value ?? null, ec, exportMeta(cfg));
        out.restoreMs = Date.now() - t0;

        if (!restored.ok) {
          out.status = "BOOTSTRAP_REQUIRED";
          out.reason = restored.reason;
          out.detail = restored.detail;
          runs.push(out);
          continue;
        }

        out.barsInState = restored.state.barCount;
        out.stateAsOf = restored.state.lastProcessedBarTime;

        // Render, and stop. The engine is advanced by nobody here: no bar is
        // fed, so `restored.engine` is exactly what was persisted and the
        // snapshot is a pure function of it.
        snapshots.push(snapshotOf(restored.engine, ec));
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
      mode: "OBSERVATION_READ_ONLY",
      note: "Pure read. This function advances nothing and writes nothing — it " +
            "renders the state ipo-paper-runner last persisted, so a snapshot " +
            "may trail the newest closed bar. Cold start is " +
            "local-runner/ipo-bootstrap.ts.",
      bootstrapRequired: needsBootstrap.map((r) => r.instrument),
      runs, snapshots,
    });
  } catch (e) {
    return respond({ ok: false, error: (e as Error).message }, 500);
  }
}

if (import.meta.main) Deno.serve(handler);

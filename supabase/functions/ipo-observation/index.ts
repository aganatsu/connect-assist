/**
 * IPO observation endpoint. Phase C. READ-ONLY.
 *
 * Returns what the frozen IPO rules currently see. It places no orders, writes
 * no trading state, and touches no SMC table. Tests assert it cannot reach
 * broker-execute, paper_positions, pending_orders, paper_trade_history or
 * paper_accounts.
 *
 * THE ONLY THING IT WRITES is a short-lived snapshot in `kv_cache`, the generic
 * cache the codebase already uses for FOTSI and daily candles. That choice is
 * deliberate: bootstrapping the engine over ~1,200 bars costs ~30s, which is
 * unacceptable per UI poll, and a new table would be a schema change Phase C
 * does not need. A kv_cache row is a string keyed by name — SMC management
 * cannot read it as a position, and nothing adopts it.
 *
 * CLOSED BARS ONLY. The newest forming bar is dropped before the engine sees
 * it, because an unfinished close would move both the volatility bucket and the
 * S2 test and the snapshot would describe a state that never existed.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { fetchCandlesWithFallback } from "../_shared/candleSource.ts";
import { setCreditCallerContext } from "../_shared/apiCreditBudget.ts";
import { observe, closedBarsOnly, type IpoObservationSnapshot } from "../_shared/ipoObservation.ts";
import type { Candle } from "../_shared/smcAnalysis.ts";

/** The frozen spec §1. Nothing else is observed. */
export const OBSERVED = [
  { instrument: "EUR/USD", timeframe: "1h",    barMs: 3_600_000, highVolOnly: false, costPerSide: (_p: number) => 0.00008 },
  { instrument: "USD/JPY", timeframe: "30min", barMs: 1_800_000, highVolOnly: false, costPerSide: (_p: number) => 0.008 },
  { instrument: "BTC/USD", timeframe: "1h",    barMs: 3_600_000, highVolOnly: true,  costPerSide: (p: number) => p * 0.0015 },
] as const;

/** BTC needs >= 200 closed bars before its volatility bucket resolves at all. */
export const OBSERVATION_BARS = 1200;

const cacheKey = (i: string) => `ipo_observation:${i}`;

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

    const url = new URL(req.url);
    const only = url.searchParams.get("instrument");
    const force = url.searchParams.get("refresh") === "1";
    const now = Date.now();

    const snapshots: IpoObservationSnapshot[] = [];
    const errors: Array<{ instrument: string; error: string }> = [];

    for (const cfg of OBSERVED) {
      if (only && only !== cfg.instrument) continue;
      try {
        if (!force) {
          const { data } = await db.from("kv_cache").select("value, expires_at")
            .eq("key", cacheKey(cfg.instrument)).maybeSingle();
          if (data && new Date(data.expires_at).getTime() > now) {
            snapshots.push(JSON.parse(data.value)); continue;
          }
        }

        const { candles } = await fetchCandlesWithFallback({
          symbol: cfg.instrument, interval: cfg.timeframe, limit: OBSERVATION_BARS,
        } as Parameters<typeof fetchCandlesWithFallback>[0]);

        const closed = closedBarsOnly((candles ?? []) as Candle[], now, cfg.barMs);
        if (closed.length < 250) {
          errors.push({ instrument: cfg.instrument, error: `only ${closed.length} closed bars — below the volatility warmup` });
          continue;
        }

        const snap = observe(closed, {
          instrument: cfg.instrument, timeframe: cfg.timeframe,
          highVolOnly: cfg.highVolOnly, costPerSide: cfg.costPerSide,
        });
        snapshots.push(snap);

        // Cache until the next bar closes, so a UI poll never re-bootstraps.
        await db.from("kv_cache").upsert({
          key: cacheKey(cfg.instrument),
          value: JSON.stringify(snap),
          expires_at: new Date(now + cfg.barMs).toISOString(),
          updated_at: new Date(now).toISOString(),
        }, { onConflict: "key" });
      } catch (e) {
        errors.push({ instrument: cfg.instrument, error: (e as Error).message });
      }
    }

    return respond({
      ok: true,
      mode: "OBSERVATION_ONLY",
      note: "No orders, no trading state, no broker. executionEligible is informational.",
      snapshots, errors,
    });
  } catch (e) {
    return respond({ ok: false, error: (e as Error).message }, 500);
  }
}

if (import.meta.main) Deno.serve(handler);

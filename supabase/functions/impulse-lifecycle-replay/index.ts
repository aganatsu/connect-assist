import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyCronCaller } from "../_shared/cronAuth.ts";
import { resolveAuthenticatedUserId } from "../_shared/callerAuth.ts";
import { fetchCandlesWithFallback } from "../_shared/candleSource.ts";
import { replayImpulseEntryLifecycle } from "../_shared/impulseLifecycleReplay.ts";
import {
  observeImpulseConfirmationLock,
  observeImpulseEntryPrice,
} from "../_shared/impulseEntryLifecycleStore.ts";

import { setCreditCallerContext } from "../_shared/apiCreditBudget.ts";

setCreditCallerContext("impulse-lifecycle-replay");

const BOT_ID = "smc";
const respond = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

async function publishEnforcementCertificate(client: any, userId: string) {
  const { data: summary, error } = await client
    .from("impulse_entry_lifecycle_replay_summary").select("*")
    .eq("user_id", userId).eq("bot_id", BOT_ID)
    .eq("evidence_source", "retrospective_replay").maybeSingle();
  if (error) throw error;
  if (!summary) return null;
  const evidence = {
    contract: "impulse-lifecycle-enforcement.v1",
    replayCount: Number(summary.replay_count || 0),
    resolvedCount: Number(summary.winners || 0) + Number(summary.losers || 0),
    rescuedWinners: Number(summary.rescued_winners || 0),
    addedLosses: Number(summary.added_losses || 0),
    winnersRetained: Number(summary.winners_retained || 0),
    minimumSampleReady: summary.minimum_sample_ready === true,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(evidence));
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((value) => value.toString(16).padStart(2, "0")).join("");
  const status = evidence.minimumSampleReady && evidence.rescuedWinners >= evidence.addedLosses
    ? "eligible" : evidence.minimumSampleReady ? "rejected" : "collecting";
  const { data: current } = await client.from("impulse_lifecycle_enforcement_certificates")
    .select("id,evidence_hash,reviewed,reviewed_at").eq("user_id", userId)
    .eq("bot_id", BOT_ID).eq("is_current", true).maybeSingle();
  if (current?.evidence_hash !== hash) {
    await client.from("impulse_lifecycle_enforcement_certificates")
      .update({ is_current: false }).eq("user_id", userId).eq("bot_id", BOT_ID).eq("is_current", true);
  }
  const { data: certificate, error: certificateError } = await client
    .from("impulse_lifecycle_enforcement_certificates").upsert({
      user_id: userId, bot_id: BOT_ID, evidence_hash: hash, status,
      replay_count: evidence.replayCount, resolved_count: evidence.resolvedCount,
      rescued_winners: evidence.rescuedWinners, added_losses: evidence.addedLosses,
      minimum_sample_ready: evidence.minimumSampleReady, is_current: true, evidence,
      reviewed: current?.evidence_hash === hash ? current.reviewed : false,
      reviewed_at: current?.evidence_hash === hash ? current.reviewed_at : null,
      generated_at: new Date().toISOString(),
    }, { onConflict: "user_id,bot_id,evidence_hash" }).select("*").single();
  if (certificateError) throw certificateError;
  return certificate;
}

async function monitorOrphanedLifecycles(client: any) {
  const { data: lifecycles, error } = await client
    .from("impulse_entry_lifecycles")
    .select("id,user_id,symbol,lifecycle")
    .eq("bot_id", BOT_ID).eq("status", "active").eq("mode", "observe")
    .order("updated_at", { ascending: true }).limit(20);
  if (error) throw error;
  let monitored = 0;
  for (const row of lifecycles || []) {
    const { data: activeOrder } = await client.from("pending_orders").select("id")
      .eq("impulse_entry_lifecycle_id", row.id)
      .in("status", ["pending", "awaiting_confirmation", "reconciliation_required"])
      .limit(1).maybeSingle();
    if (activeOrder) continue;
    const timeframe = row.lifecycle?.confirmation?.timeframe || "5m";
    try {
      const fetched = await fetchCandlesWithFallback({
        symbol: row.symbol, interval: timeframe, limit: 100,
        brokerConn: null, skipBroker: true,
      });
      if (fetched.candles.length < 10) continue;
      const last = fetched.candles.at(-1)!;
      await observeImpulseEntryPrice(client, row.id, last.close, last.datetime);
      await observeImpulseConfirmationLock(client, row.id, fetched.candles);
      monitored++;
    } catch (monitorError) {
      console.warn(`[impulse-monitor] ${row.symbol}: ${String(monitorError)}`);
    }
  }
  return { monitored, eligible: lifecycles?.length || 0 };
}

async function replayUserLifecycles(client: any, userId: string, limit: number) {
  const { data: lifecycles, error } = await client
    .from("impulse_entry_lifecycles")
    .select("id,symbol,created_at")
    .eq("user_id", userId).eq("bot_id", BOT_ID)
    .order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  let replayed = 0;
  let unavailable = 0;
  for (const row of lifecycles || []) {
    const { data: created } = await client
      .from("impulse_entry_lifecycle_transitions")
      .select("lifecycle_snapshot")
      .eq("lifecycle_id", row.id).eq("event_type", "created")
      .order("created_at", { ascending: true }).limit(1).maybeSingle();
    const initial = created?.lifecycle_snapshot;
    if (!initial) { unavailable++; continue; }
    const timeframe = initial.confirmation?.timeframe || "5m";
    const { data: snapshot } = await client.from("scan_candle_snapshots")
      .select("id,candles")
      .eq("user_id", userId).eq("bot_id", BOT_ID)
      .eq("symbol", row.symbol).eq("timeframe", timeframe)
      .order("observed_at", { ascending: false }).limit(1).maybeSingle();
    if (!snapshot || !Array.isArray(snapshot.candles)) { unavailable++; continue; }
    const result = replayImpulseEntryLifecycle({
      lifecycle: initial,
      candles: snapshot.candles,
    });
    const { error: insertError } = await client
      .from("impulse_entry_lifecycle_replays")
      .upsert({
        user_id: userId, bot_id: BOT_ID, lifecycle_id: row.id,
        snapshot_id: snapshot.id, evidence_source: "retrospective_replay",
        contract_version: result.contractVersion, result,
        outcome: result.outcome, entered: result.entered,
        rescued_deeper_entry: result.rescuedDeeperEntry,
        retained_winner: result.retainedWinner,
        mfe: result.mfe, mae: result.mae,
      }, { onConflict: "lifecycle_id,snapshot_id,evidence_source" });
    if (insertError) throw insertError;
    replayed++;
  }
  return { replayed, unavailable, requested: lifecycles?.length || 0 };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const client = createClient(
    Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  try {
    const body = await req.json().catch(() => ({}));
    if (body.action === "monitor") {
      const authError = verifyCronCaller(req);
      if (authError) return authError;
      return respond({ success: true, ...(await monitorOrphanedLifecycles(client)) });
    }
    const userId = await resolveAuthenticatedUserId(req);
    if (!userId) return respond({ error: "Unauthorized" }, 401);
    const replay = await replayUserLifecycles(client, userId, Math.min(100, Number(body.limit) || 100));
    const certificate = await publishEnforcementCertificate(client, userId);
    return respond({ success: true, ...replay, certificate });
  } catch (error) {
    console.error("[impulse-lifecycle-replay]", error);
    return respond({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

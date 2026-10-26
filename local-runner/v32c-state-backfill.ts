/**
 * V3.2c state: FULL-HISTORY backfill and audit (PR3). The hourly v32c-state function only materializes the last 8 days; this tool
 * replays every pair from the epoch, compares EVERY stored snapshot and checkpoint with the replay, and (with --execute) appends
 * the missing ones plus an audit row per repaint / mismatch. DRY-RUN BY DEFAULT. Zero provider calls.
 *
 *   deno run --allow-read --allow-net --allow-env local-runner/v32c-state-backfill.ts [--pair EUR/USD] [--execute]
 *   (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from local-runner/.env.local, or the file named by LOCAL_RUNNER_ENV)
 *
 * Rules: supabase/functions/_shared/structure/v32cState.ts + v32cStateRun.ts (the same code the function runs).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { STRUCTURE_PAIRS } from "../supabase/functions/_shared/structure/canonicalBars.ts";
import { runV3StateForPair } from "../supabase/functions/_shared/structure/v32cStateRun.ts";

const args = Deno.args, EXECUTE = args.includes("--execute");
const pi = args.indexOf("--pair"), ONLY = pi >= 0 ? args[pi + 1] : null;
const env: Record<string, string> = {};
for (const l of Deno.readTextFileSync(Deno.env.get("LOCAL_RUNNER_ENV") ?? new URL("./.env.local", import.meta.url)).split("\n")) {
  const i = l.indexOf("=");
  if (i > 0 && !l.startsWith("#")) env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let bad = 0;
for (const sym of ONLY ? [ONLY] : STRUCTURE_PAIRS) {
  const t0 = performance.now();
  const { plan, ...r } = await runV3StateForPair(db, sym, { nowMs: Date.now(), materializeFrom: -Infinity, dryRun: !EXECUTE });
  console.log(`${sym}: ${JSON.stringify(r.counts)} | latest 1H ${JSON.stringify(r.latest1H)} | ${Math.round(performance.now() - t0)} ms`);
  for (const x of plan.repaints.slice(0, 5)) console.log(`  REPAINT ${x.tf} ${x.known_at} stored ${x.stored_hash} replay ${x.replay_hash}`);
  for (const x of plan.checkpointMismatches.slice(0, 5)) console.log(`  CHECKPOINT MISMATCH ${x.known_at} ${x.field}: stored ${x.stored} replay ${x.replay}`);
  if (!r.ok) bad++;
}
console.log(`${EXECUTE ? "EXECUTED" : "DRY RUN (nothing written)"}; pairs with repaints or mismatches: ${bad}`);

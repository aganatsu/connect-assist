/**
 * IPO bootstrap — off-Edge. Builds the D.1 runtime state the Edge functions
 * restore, and writes it to the one key they read.
 *
 * WHY THIS IS NOT AN EDGE FUNCTION. It was, and it did not work. Deployed
 * 2026-09-21, `ipo-observation` failed every invocation with
 * WORKER_RESOURCE_LIMIT — one instrument, 3 to 16 seconds, killed for compute.
 * A 1,200-bar rebuild costs about 17 seconds of CPU; an Edge Function has a few.
 * The gap is roughly an order of magnitude.
 *
 * The response is not to make the bootstrap cheaper. HISTORY_BARS stays at
 * 1,200: shortening it changes which bars the whole-series functions see and
 * therefore which trades exist, which is a strategy change, and a platform limit
 * is not a reason to make one. The response is to do the work somewhere with a
 * real CPU — which is exactly why `local-runner/` exists.
 *
 * WHAT IT DOES NOT DO. No broker call, no order, no write to any SMC table, no
 * schedule. It reads candles and writes one `kv_cache` row per instrument.
 *
 * IDEMPOTENT BY CONSTRUCTION. The engine is deterministic and `exportState` is a
 * pure function of it, so the same bars in produce a byte-identical payload out.
 * `--verify` proves it on the spot by building twice and comparing, and the
 * written row is compared against what is already there so an unchanged
 * bootstrap is a no-op rather than a rewrite.
 *
 * USAGE
 *   cd local-runner && cp .env.local.example .env.local   # fill in the values
 *   deno run --allow-net --allow-env --allow-read ipo-bootstrap.ts [flags]
 *
 *   --instrument=EUR/USD   just one (default: all three)
 *   --verify               build twice and assert byte-identical, then exit
 *   --dry-run              build and report, write nothing
 *
 * REQUIRED ENV
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   where the state is written
 *   TWELVE_DATA_API_KEY                       the candle source
 *   POLYGON_API_KEY                           optional fallback
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fetchCandlesWithFallback } from "../supabase/functions/_shared/candleSource.ts";
import { setCreditCallerContext } from "../supabase/functions/_shared/apiCreditBudget.ts";
import { closedBarsOnly } from "../supabase/functions/_shared/ipoObservation.ts";
import { IncrementalEngine } from "../supabase/functions/_shared/ipoIncrementalEngine.ts";
import {
  IPO_INSTRUMENTS, HISTORY_BARS, MIN_HISTORY_BARS,
  engineStateKey, engineConfig, exportMeta, type IpoInstrument,
} from "../supabase/functions/_shared/ipoInstruments.ts";
import {
  exportState, serializeState, parseState,
} from "../supabase/functions/_shared/ipoEngineState.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";

const args = new Set(Deno.args);
const flag = (name: string) => [...args].find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const only = flag("instrument");
const verifyOnly = args.has("--verify");
const dryRun = args.has("--dry-run");

const need = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) { console.error(`missing ${k}`); Deno.exit(1); }
  return v;
};

/**
 * Builds state from a fixed bar array.
 *
 * Separated from fetching so `--verify` can run it twice on the SAME bars. Two
 * fetches could legitimately differ — a new bar closes, a provider revises one —
 * and that would look like non-determinism when it is not.
 */
function build(cfg: IpoInstrument, bars: Candle[]): string {
  const engine = new IncrementalEngine(engineConfig(cfg));
  for (const b of bars) engine.feed(b);
  return serializeState(exportState(engine, engineConfig(cfg), exportMeta(cfg)));
}

async function bootstrap(cfg: IpoInstrument) {
  const label = `${cfg.instrument} ${cfg.timeframe}`;
  const t0 = performance.now();

  const { candles } = await fetchCandlesWithFallback({
    symbol: cfg.instrument, interval: cfg.timeframe, limit: HISTORY_BARS,
    // The bootstrap is a reader too. It must not write broker_connections.
    persistSymbolOverrides: false,
  } as Parameters<typeof fetchCandlesWithFallback>[0]);

  const bars = closedBarsOnly((candles ?? []) as Candle[], Date.now(), cfg.barMs);
  const fetchMs = Math.round(performance.now() - t0);

  if (bars.length < MIN_HISTORY_BARS) {
    console.error(`  ${label}: only ${bars.length} closed bars — below the volatility warmup. SKIPPED.`);
    return { ok: false };
  }

  const b0 = performance.now();
  const payload = build(cfg, bars);
  const buildMs = Math.round(performance.now() - b0);

  if (verifyOnly) {
    const again = build(cfg, bars);
    const same = again === payload;
    console.log(`  ${label}: ${bars.length} bars, ${buildMs}ms, ` +
      `${(payload.length / 1024).toFixed(1)}KB — idempotent: ${same ? "YES" : "NO"}`);
    return { ok: same };
  }

  const state = parseState(payload)!;
  console.log(`  ${label}: ${bars.length} bars (fetch ${fetchMs}ms, build ${buildMs}ms), ` +
    `${(payload.length / 1024).toFixed(1)}KB, through ${state.lastProcessedBarTime}`);

  if (dryRun) { console.log("    --dry-run: not written"); return { ok: true }; }

  const db = createClient(need("SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } });
  const key = engineStateKey(cfg.instrument);

  // An unchanged bootstrap should not rewrite the row. Re-running is then
  // provably free rather than merely harmless.
  const { data: existing } = await db.from("kv_cache").select("value").eq("key", key).maybeSingle();
  if (existing?.value === payload) {
    console.log("    identical to the stored state — no write");
    return { ok: true };
  }

  const { error } = await db.from("kv_cache").upsert({
    key,
    value: payload,
    expires_at: new Date(Date.now() + 365 * 24 * 3_600_000).toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: "key" });
  if (error) { console.error(`    write failed: ${error.message}`); return { ok: false }; }

  console.log(`    written to ${key}`);
  return { ok: true };
}

setCreditCallerContext("ipo-bootstrap");

const targets = IPO_INSTRUMENTS.filter((i) => !only || i.instrument === only);
if (targets.length === 0) {
  console.error(`unknown instrument "${only}". Known: ${IPO_INSTRUMENTS.map((i) => i.instrument).join(", ")}`);
  Deno.exit(1);
}

console.log(`IPO bootstrap — ${HISTORY_BARS} bars per instrument` +
  `${verifyOnly ? " (verify only)" : dryRun ? " (dry run)" : ""}`);

let failed = 0;
for (const cfg of targets) {
  try {
    if (!(await bootstrap(cfg)).ok) failed++;
  } catch (e) {
    console.error(`  ${cfg.instrument}: ${(e as Error).message}`);
    failed++;
  }
}

console.log(failed === 0
  ? "\nDone. The Edge functions can now restore this state."
  : `\n${failed} instrument(s) failed.`);
Deno.exit(failed === 0 ? 0 : 1);

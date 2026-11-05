/**
 * SCALPER15_PREREG_V1 — corpus (docs/SCALPER15_PREREG_V1.md). 1m for execution, 5m for
 * confirmation and refinement, 15m for the impulse, 1h for direction and targets. No 4h/1d/1w:
 * this design does not read them.
 *
 * A SEPARATE cache from the #677 corpus (.cache/smc) on purpose: that corpus is frozen at
 * 2026-09-25, and this one runs on through the holdout to 2026-11-04.
 *
 * ~690 requests, mostly 1m (3-day chunks). The key is shared with production, so on top of
 * series()' own 2.3s pacing each call waits a further 4s (~9-10/min, a fraction of the plan).
 *
 *   deno run --allow-net --allow-read --allow-write --allow-env local-runner/scalper15-fetch.ts
 */

import { series } from "./ipo-stock-datacheck.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { SYMBOLS, TO, TF_SPEC, cacheFile } from "./scalper15Corpus.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (import.meta.main) {
  for (const sym of SYMBOLS) {
    for (const { tf, iv, from, chunkDays } of TF_SPEC) {
      const f = cacheFile(sym, tf);
      try { Deno.statSync(f); console.log(`${sym} ${tf}: cached`); continue; } catch { /* fetch */ }
      const out: Candle[] = [];
      let cur = Date.parse(from);
      const end = Date.parse(TO);
      while (cur < end) {
        const a = new Date(cur).toISOString().slice(0, 10);
        const bMs = Math.min(cur + chunkDays * 86_400_000, end);
        const b = new Date(bMs).toISOString().slice(0, 10);
        try { out.push(...await series(sym, iv, a, b)); }
        catch (e) { console.log(`  ${sym} ${tf} ${a}: ${(e as Error).message.slice(0, 90)}`); }
        await sleep(4_000);
        cur = bMs;
      }
      // Same rule as the #677 corpus: a duplicate instant is a revised bar; keep one, never merge.
      const seen = new Set<string>();
      const clean = out
        .filter((c) => !seen.has(c.datetime) && seen.add(c.datetime))
        .sort((x, y) => Date.parse(x.datetime) - Date.parse(y.datetime));
      Deno.writeTextFileSync(f, JSON.stringify(clean));
      console.log(`${sym} ${tf}: ${clean.length} bars (${out.length - clean.length} dupes) ${clean[0]?.datetime.slice(0, 10)}..${clean.at(-1)?.datetime.slice(0, 10)}`);
    }
  }
  console.log("\ncorpus complete");
}

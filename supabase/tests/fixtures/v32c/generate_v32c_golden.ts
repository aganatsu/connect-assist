// Generates golden_v32c.json by running the SYNTHETIC series (./synthetic.ts) through the FROZEN RESEARCH copies of
// V3.2c and its seed dependency — not the vendored repo copies — so the test compares two independent copies.
// No market data is read or written. Run manually (never in CI):
//   V32C_FROZEN_DIR=<research v3.2c-frozen-20261013 dir> V32C_RESEARCH_SMC=<research smcAnalysis.ts (sha 24ce4ac6…)> \
//   deno run --allow-read --allow-write --allow-env supabase/tests/fixtures/v32c/generate_v32c_golden.ts
import { SYNTHETIC_SERIES } from "./synthetic.ts";
const FZ = Deno.env.get("V32C_FROZEN_DIR")!, SMC = Deno.env.get("V32C_RESEARCH_SMC")!;
const E = await import(`${FZ}/engine.ts`), T = await import(`${FZ}/timeframes.ts`), sm = await import(SMC);
const toC = (bars: any[]) => bars.map((b: any) => ({ datetime: "", open: b.o, high: b.h, low: b.l, close: b.c, volume: 0 }));
const cfg = (tf: string) => ({ tf, lookback: 5, depth: 0.5, confirm: "right", swingsAsOf: (bars: any[]) => sm.detectSwingPoints(toC(bars), 5, 0.4).map((s: any) => ({ index: s.index, type: s.type })), atr: (bars: any[]) => sm.calculateATR(toC(bars), 14), atrFilter: 0.4 });
const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const golden: any = { note: "synthetic deterministic series; golden produced by the frozen research V3.2c copy", engine: "v3.2c-frozen-20261013", series: {}, runs: {} };
for (const [name, gen] of Object.entries(SYNTHETIC_SERIES)) {
  const all = gen(); golden.series[name] = { hours: all.length, hoursSha256: await sha(JSON.stringify(all)) };
  const hours = all.filter((b) => T.fxOpen(b.t));
  for (const tf of ["D", "4H", "1H"]) {
    const ag = T.aggregate(tf, hours); let s = E.initState(); const evs: any[] = []; const store = new T.SnapshotStore(tf);
    for (const b of ag.bars) { const r = E.step(cfg(tf), s, b); s = r.state; evs.push(...r.events); store.record(s); }
    const snaps: any[] = []; for (let i = 0; i < store.length; i++) snaps.push(store.at(i));
    golden.runs[`${name}|${tf}`] = { bars: ag.bars.length, skippedBuckets: ag.skipped, events: evs.length, eventsSha256: await sha(JSON.stringify(evs)),
      snapshotsSha256: await sha(JSON.stringify(snaps)), eventTypes: evs.reduce((m: any, e: any) => (m[e.type] = (m[e.type] ?? 0) + 1, m), {}),
      final: { trend: s.trend, P: s.P, F: s.F, stack: s.stack.length, pending: s.pending?.kind ?? null } };
  }
}
const seedBars = SYNTHETIC_SERIES["SYN-A"]().slice(0, 400);
golden.seedSwings = sm.detectSwingPoints(toC(seedBars), 5, 0.4).map((s: any) => [s.index, s.type, s.price]);
golden.seedAtr = sm.calculateATR(toC(seedBars), 14);
Deno.writeTextFileSync(new URL("./golden_v32c.json", import.meta.url), JSON.stringify(golden, null, 1) + "\n");
console.log(Object.entries(golden.runs).map(([k, v]: any) => `${k}: ${v.bars} bars, ${v.events} events, skipped ${v.skippedBuckets.length}`).join("\n"));

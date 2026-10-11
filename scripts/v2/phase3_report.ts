// Phase 3 replay → independent-checker comparison (stop on any disagreement) → frequency gate (§12.1c) → owner review sample (§12.1b)
// → review charts. Local only: reads the immutable dataset, writes results to --out.
//   deno run --allow-read --allow-write scripts/v2/phase3_report.ts --dataset <dir>/dataset.json --measured-start 2026-09-27T21:00:00Z --days 10 --out <dir>
import { runReplay } from "../../supabase/functions/_shared/v2/engine.ts";
import type { Dataset } from "../../supabase/functions/_shared/v2/barStore.ts";
import { fromPoints } from "../../supabase/functions/_shared/v2/barStore.ts";
import { mulberry32, phase3Frequency } from "../../supabase/functions/_shared/v2/v2Evaluation.ts";
import { PAIRS, SPEC_SHA256, SPEC_VERSION } from "../../supabase/functions/_shared/v2/spec.ts";
import { runChecker } from "../../supabase/functions/_shared/v2check/checker.ts";
import { compare } from "../../supabase/functions/_shared/v2check/compare.ts";
import { renderSetup, setupsOf } from "./chart.ts";

const arg = (k: string) => { const i = Deno.args.indexOf(k); return i >= 0 ? Deno.args[i + 1] : undefined; };
const OUT = arg("--out")!;
const M = Date.parse(arg("--measured-start")!);
const DAYS = Number(arg("--days"));
const dsText = await Deno.readTextFile(arg("--dataset")!);
const ds: Dataset = JSON.parse(dsText);
const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(dsText)))].map((b) => b.toString(16).padStart(2, "0")).join("");
await Deno.mkdir(`${OUT}/charts`, { recursive: true });

// 1. replay + independent checker
const res = runReplay(ds, M);
const chk = runChecker({ dataset: ds, news: "REPLAY", measuredStart: M });
const diff = compare(res.events, chk);
await Deno.writeTextFile(`${OUT}/events.json`, JSON.stringify(res.events, null, 1));
await Deno.writeTextFile(`${OUT}/checker-diff.json`, JSON.stringify(diff, null, 1));
console.log(`replay: ${res.events.length} engine events, ${chk.length} checker events; agree ${diff.agree}; engine-only ${diff.onlyEngine.length}; checker-only ${diff.onlyChecker.length}`);
if (diff.onlyEngine.length || diff.onlyChecker.length) {
  console.log("STOP: engine/checker disagreement — no Phase 3 verdict.");
  console.log(diff.onlyEngine.slice(0, 10).join("\n"), "\n---\n", diff.onlyChecker.slice(0, 10).join("\n"));
  Deno.exit(1);
}

// 2. measured-window trades
const inWindow = res.trades.filter((t) => t.entryT > M);
const resolved = inWindow.filter((t) => t.exit !== null).sort((a, b) => a.entryT - b.entryT || PAIRS.indexOf(a.pair) - PAIRS.indexOf(b.pair));
const open = inWindow.filter((t) => t.exit === null);
const freq = phase3Frequency(resolved.length, DAYS);

// 3. terminal reasons inside the window (setups and POIs), for description
const tally = (entity: string) => {
  const m: Record<string, number> = {};
  for (const e of res.events) if (e.entity === entity && e.t > M && e.event !== "QUALIFIED") m[e.event] = (m[e.event] ?? 0) + 1;
  return m;
};
const warmupSpent = res.events.filter((e) => e.event === "SPENT_WARMUP").length;

// 4. owner review sample (§12.1b): mulberry32 seed 20261010, resolved window trades ordered by (entry time, pair order),
//    partial Fisher–Yates without replacement: for i = 0…min(20,n)−1: j = i + floor(next() × (n − i)); swap(i, j); take the first min(20, n).
const pool = [...resolved];
const next = mulberry32(20261010);
const take = Math.min(20, pool.length);
for (let i = 0; i < take; i++) { const j = i + Math.floor(next() * (pool.length - i)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
const sample = pool.slice(0, take);

// 5. charts: every setup armed in the window, with the sample marked
const setups = setupsOf(res).filter((s) => res.events.find((e) => e.id === s.id && e.event === "ARMED" && e.entity === "SETUP")!.t > M);
const chartName = (n: number, pair: string) => `setup-${String(n + 1).padStart(3, "0")}-${pair.replace("/", "")}.html`;
const chartOf = new Map<string, string>();
for (const [n, s] of setups.entries()) {
  const name = chartName(n, s.pair);
  chartOf.set(s.id, name);
  await Deno.writeTextFile(`${OUT}/charts/${name}`, renderSetup(res, s.pair, s.id, s.confirmT));
}
const px = (p: string, v: number) => fromPoints(p as never, v).toFixed(p.endsWith("JPY") ? 3 : 5);
const row = (t: typeof resolved[number]) => `${new Date(t.entryT).toISOString().slice(0, 16)}Z ${t.pair} ${t.dir} entry ${px(t.pair, t.entry)} SL ${px(t.pair, t.sl)} TP ${px(t.pair, t.tp)} ` +
  `${t.lots} lots → ${t.exit ?? "OPEN"}${t.exit ? ` ${new Date(t.exitT!).toISOString().slice(0, 16)}Z net R ${t.netR!.toFixed(3)}` : ""}  [${chartOf.get(t.id.split("@")[0]) ?? "-"}]`;

const lines = [
  `# Phase 3 replay report — spec v${SPEC_VERSION} (sha256 ${SPEC_SHA256.slice(0, 8)}…)`,
  `Labels: PHASE3_FINAL_PROVIDER_BARS, NEWS_GATE_NOT_REPLAYED. Dataset sha256 ${sha}. Measured start M = ${new Date(M).toISOString()}.`,
  ``,
  `## Fidelity`,
  `Engine vs independent checker: ${diff.agree} events, 0 disagreements (100%). Owner review of the sample below pending.`,
  ``,
  `## Frequency gate (§12.1c)`,
  `Complete eligible days: ${DAYS}. Resolved window trades: ${resolved.length}. Projected trades/week = ${resolved.length} / ${DAYS} × 5 = ${freq.perWeek.toFixed(2)} → ${freq.verdict}.`,
  `Open at the cutoff (excluded, reported only): ${open.length}.`,
  ``,
  `## Window activity (descriptive)`,
  `Setup terminal events: ${JSON.stringify(tally("SETUP"))}`,
  `POI terminal events: ${JSON.stringify(tally("POI"))}`,
  `POIs spent during warm-up (SPENT_WARMUP): ${warmupSpent}`,
  ``,
  `## Resolved trades`,
  ...resolved.map(row),
  ``,
  `## Open at cutoff`,
  ...(open.length ? open.map(row) : ["none"]),
  ``,
  `## Owner review sample (mulberry32 seed 20261010, without replacement, ${sample.length} of ${resolved.length})`,
  ...sample.map((t, i) => `${i + 1}. ${row(t)}`),
];
await Deno.writeTextFile(`${OUT}/REPORT.md`, lines.join("\n") + "\n");
await Deno.writeTextFile(`${OUT}/trades.json`, JSON.stringify({ resolved, open, sample: sample.map((t) => t.id) }, null, 1));
console.log(lines.join("\n"));

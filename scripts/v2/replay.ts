// Local V2 replay runner (no network, no database): runs the pure engine and the independent checker on a dataset,
// reports agreement, and writes the event log, trades and one review chart per setup.
//   deno run --allow-read --allow-write scripts/v2/replay.ts --dataset path/to/dataset.json --measured-start 2026-09-27T21:00:00Z --out out/v2
//   deno run --allow-read --allow-write scripts/v2/replay.ts --scenario base [--mirror] --out out/v2
//   deno run --allow-read --allow-write scripts/v2/replay.ts --synthetic 7 --days 28 --out out/v2
import { runReplay } from "../../supabase/functions/_shared/v2/engine.ts";
import type { Dataset } from "../../supabase/functions/_shared/v2/barStore.ts";
import { runChecker } from "../../supabase/functions/_shared/v2check/checker.ts";
import { compare } from "../../supabase/functions/_shared/v2check/compare.ts";
import { renderSetup, setupsOf } from "./chart.ts";
import { baseScenario, build } from "../../supabase/tests/v2/helpers/scenario.ts";
import { generate } from "../../supabase/tests/v2/helpers/gen.ts";

const args = Deno.args;
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const out = arg("--out") ?? "out/v2";
let ds: Dataset;
if (arg("--dataset")) ds = JSON.parse(await Deno.readTextFile(arg("--dataset")!));
else if (arg("--synthetic")) ds = generate({ seed: Number(arg("--synthetic")), start: Date.UTC(2026, 8, 7), days: Number(arg("--days") ?? 28) });
else { const s = baseScenario(); s.mirror = args.includes("--mirror"); ds = build(s); }

const measuredStart = arg("--measured-start") ? Date.parse(arg("--measured-start")!) : undefined;   // §0.12 warm-up before M
const res = runReplay(ds, measuredStart);
const diff = compare(res.events, runChecker({ dataset: ds, news: "REPLAY", measuredStart }));
await Deno.mkdir(out, { recursive: true });
await Deno.writeTextFile(`${out}/events.json`, JSON.stringify(res.events, null, 1));
await Deno.writeTextFile(`${out}/trades.json`, JSON.stringify(res.trades, null, 1));
const setups = setupsOf(res);
for (const [n, s] of setups.entries()) {
  await Deno.writeTextFile(`${out}/setup-${String(n + 1).padStart(3, "0")}-${s.pair.replace("/", "")}.html`, renderSetup(res, s.pair, s.id, s.confirmT));
}
console.log(`events ${res.events.length}, setups ${setups.length}, trades ${res.trades.length}; checker agreement ${diff.agree}, ` +
  `engine-only ${diff.onlyEngine.length}, checker-only ${diff.onlyChecker.length} (labels: NEWS_GATE_NOT_REPLAYED${arg("--dataset") ? ", PHASE3_FINAL_PROVIDER_BARS" : ""})`);
if (diff.onlyEngine.length || diff.onlyChecker.length) Deno.exit(1);

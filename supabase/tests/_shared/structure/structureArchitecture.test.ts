import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Architecture guarantees after PR2 / PR3:
 *   1. The ONLY production entrypoint (supabase/functions/<fn>/index.ts) that reaches the vendored V3.2c module, even transitively,
 *      is the PR3 state service `v32c-state`. In particular bot-scanner does not.
 *   2. The bot-scanner call site of the canonical-bar writer is exactly the default-off, observational block: its
 *      result is only logged and feeds no decision. Changing that wiring must update this test deliberately.
 */
const FN = new URL("../../../functions/", import.meta.url).pathname;
const importsOf = (file: string): string[] =>
  [...Deno.readTextFileSync(file).matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']/g)].map((m) => m[1]);
const resolve = (from: string, spec: string) => new URL(spec, `file://${from}`).pathname;

Deno.test("only v32c-state reaches _shared/structure/v32c (transitive import graph); bot-scanner does not", () => {
  const reachers = new Set<string>();
  let scannerReachesWriter = false;
  for (const e of Deno.readDirSync(FN)) {
    if (!e.isDirectory || e.name.startsWith("_")) continue;
    const entry = `${FN}${e.name}/index.ts`;
    try { Deno.statSync(entry); } catch { continue; }
    const seen = new Set<string>(), stack = [entry];
    while (stack.length) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      if (f.includes("/_shared/structure/v32c/")) { reachers.add(e.name); continue; }
      if (e.name === "bot-scanner" && f.endsWith("/_shared/structure/canonicalBars.ts")) scannerReachesWriter = true;
      if (!f.endsWith(".ts")) continue;
      for (const s of importsOf(f)) stack.push(resolve(f, s));
    }
  }
  assertEquals([...reachers], ["v32c-state"]);
  assert(scannerReachesWriter, "the traversal really follows bot-scanner → structureBarsWriter → canonicalBars");
});

Deno.test("bot-scanner wiring: default-off guard, awaited bounded call, result only logged", () => {
  const src = Deno.readTextFileSync(`${FN}bot-scanner/index.ts`);
  assertEquals(src.match(/writeLiveStructureBars\(/g)?.length, 1, "exactly one call site");
  assert(src.includes("const structureBarsCfg = liveWriterConfig();"));
  assert(src.includes("const structureBarsFetchStartedAt = structureBarsCfg.enabled ? Date.now() : 0;"));
  assert(src.includes(`    if (structureBarsCfg.enabled) {
      const sb = await writeLiveStructureBars(supabase, pair, hourlyCandles, { cfg: structureBarsCfg, fetchStartedAtMs: structureBarsFetchStartedAt });
      console.log(\`[structure-bars] \${pair} \${JSON.stringify(sb)}\`);
    }`), "the call site block is exactly the observational one");
  assertEquals(src.match(/\bsb\b/g)?.length, 2, "the writer result is used only by the log line");
});

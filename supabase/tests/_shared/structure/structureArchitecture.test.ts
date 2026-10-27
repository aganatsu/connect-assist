import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Architecture guarantees after PR2 / PR3 / Impulse-on-V3 step 3:
 *   1. The ONLY production entrypoints (supabase/functions/<fn>/index.ts) that reach the vendored V3.2c module, even transitively,
 *      are the PR3 state service `v32c-state` and the Impulse-on-V3 shadow `iov3-shadow` (it reads the engine version label through
 *      v32cState.ts). bot-scanner reaches neither V3.2c nor the shadow modules (_shared/iov3).
 *   2. The bot-scanner call site of the canonical-bar writer is exactly the default-off, observational block: its
 *      result is only logged and feeds no decision. Changing that wiring must update this test deliberately.
 */
const FN = new URL("../../../functions/", import.meta.url).pathname;
const importsOf = (file: string): string[] =>
  [...Deno.readTextFileSync(file).matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']/g)].map((m) => m[1]);
const resolve = (from: string, spec: string) => new URL(spec, `file://${from}`).pathname;

Deno.test("only v32c-state and iov3-shadow reach _shared/structure/v32c; bot-scanner reaches only the ON module of _shared/iov3", () => {
  const reachers = new Set<string>(), scannerIov3 = new Set<string>();
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
      if (e.name === "bot-scanner" && f.includes("/_shared/iov3/")) scannerIov3.add(f.split("/_shared/iov3/")[1]);
      if (e.name === "bot-scanner" && f.endsWith("/_shared/structure/canonicalBars.ts")) scannerReachesWriter = true;
      if (!f.endsWith(".ts")) continue;
      for (const s of importsOf(f)) stack.push(resolve(f, s));
    }
  }
  assertEquals([...reachers].sort(), ["iov3-shadow", "v32c-state"]);
  // step 4b: bot-scanner imports onMode.ts (ON decisions / V3 cancels); its only other iov3 edge is a type-only import of
  // shadowEngine.ts (followed by this textual graph). It must never reach the shadow runner, the switch writer or the V3 engine.
  for (const f of scannerIov3) assert(["onMode.ts", "shadowEngine.ts", "zones.ts"].includes(f), `bot-scanner reaches _shared/iov3/${f}`);
  assert(scannerIov3.has("onMode.ts"));
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

Deno.test("bot-scanner wiring (5m writer, Impulse-on-V3 option A): default-off guard, scalper 5m only, result only logged", () => {
  const src = Deno.readTextFileSync(`${FN}bot-scanner/index.ts`);
  assertEquals(src.match(/writeLiveStructureBars5m\(/g)?.length, 1, "exactly one call site");
  assert(src.includes("const structureBars5mCfg = liveWriter5mConfig();"));
  assert(src.includes("const structureBars5mFetchStartedAt = structureBars5mCfg.enabled ? Date.now() : 0;"));
  assert(src.includes(`    if (structureBars5mCfg.enabled && entryInterval === "5m") {
      const sb5 = await writeLiveStructureBars5m(supabase, pair, candles, { cfg: structureBars5mCfg, fetchStartedAtMs: structureBars5mFetchStartedAt });
      console.log(\`[structure-bars-5m] \${pair} \${JSON.stringify(sb5)}\`);
    }`), "the call site block is exactly the observational one");
  assertEquals(src.match(/\bsb5\b/g)?.length, 2, "the writer result is used only by the log line");
});

Deno.test("Impulse-on-V3 code: only onSwitch.ts writes trading state (flip cancels + the config marker); onMode.ts only reads", () => {
  const files = [...Deno.readDirSync(`${FN}_shared/iov3`)].map((e) => `${FN}_shared/iov3/${e.name}`)
    .concat([`${FN}iov3-shadow/index.ts`, `${FN}structure-mode/index.ts`]);
  const forbidden = ["pending_orders", "positions", "paper_accounts", "paper_trades", "paper_positions", "trade_history", "paper_trade_history", "broker_connections", "signals"];
  const writesTo = (src: string, t: string) => new RegExp(`from\\("${t}"\\)[^;]*?\\.(insert|update|upsert|delete)\\(`).test(src);
  for (const f of files) {
    const src = Deno.readTextFileSync(f), name = f.replace(FN, "");
    if (name.endsWith("/onSwitch.ts")) continue;                                   // checked below
    if (name.endsWith("/onMode.ts")) {                                            // ON decisions + fallback: reads only
      assert(!/\.(insert|update|upsert|delete)\(/.test(src), "onMode.ts must not write anything");
      continue;
    }
    for (const t of forbidden) assert(!src.includes(`from("${t}")`), `${name} touches ${t}`);
    assert(!writesTo(src, "bot_configs"), `${name} writes bot_configs`);
  }
  const sw = Deno.readTextFileSync(`${FN}_shared/iov3/onSwitch.ts`);
  const written = [...sw.matchAll(/from\("([a-z_]+)"\)[^;]*?\.(insert|update|upsert|delete)\(/g)].map((m) => `${m[1]}.${m[2]}`);
  assertEquals([...new Set(written)].sort(), ["bot_configs.update", "pending_orders.update", "structure_mode.update", "structure_mode_log.insert"]);
  assert(!sw.includes('from("paper_positions")'), "a flip never touches open positions");
});

Deno.test("structure-mode saves the switch with update-or-insert, never an upsert (the service role may update mode / set_at only)", () => {
  const src = Deno.readTextFileSync(`${FN}structure-mode/index.ts`);
  assert(!/from\("structure_mode"\)\s*\.upsert\(/.test(src), "an upsert rewrites user_id / bot_id and is refused by the column grant");
  assert(src.includes(`db.from("structure_mode").update({ mode: to, set_at: at })`));
});

Deno.test("bot-scanner wiring (recorders while full): only in the max-positions branch, result only logged", () => {
  const src = Deno.readTextFileSync(`${FN}bot-scanner/index.ts`);
  assertEquals(src.match(/recordStructureBarsWhileFull\(/g)?.length, 1, "exactly one call site");
  assert(src.includes(`    const fullRec = await recordStructureBarsWhileFull(supabase, config.instruments, (s, i, r) => cachedFetch(s, i, r, "structure_record"),
      { entryInterval: getEntryInterval(config.entryTimeframe), nowMs: Date.now() });
    if (Object.keys(fullRec).length) console.log(\`[structure-bars-while-full] \${JSON.stringify(fullRec)}\`);
    return new Response(JSON.stringify({ ok: true, mode: "management_only"`), "inside the max-positions early return, right before it");
  assertEquals(src.match(/\bfullRec\b/g)?.length, 3, "the result is used only by the log line");
});

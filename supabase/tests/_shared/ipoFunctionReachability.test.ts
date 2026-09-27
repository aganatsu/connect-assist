/**
 * Transitive reachability for the deployable IPO functions.
 *
 * WHY THIS EXISTS. The Phase C and Phase D isolation tests grep the FUNCTION
 * FILE. That proves the file does not name a forbidden thing; it does not prove
 * the function cannot reach one. `ipo-observation` imports `candleSource`, which
 * imports nothing IPO-related and does reach SMC infrastructure — a fact no
 * file-level grep could ever surface. This walks the whole import closure.
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { shouldPersistSymbolOverride } from "../../functions/_shared/candleSource.ts";

async function closure(entry: string): Promise<string[]> {
  const seen = new Set<string>();
  async function walk(f: string) {
    if (seen.has(f)) return;
    seen.add(f);
    let src: string;
    try { src = await Deno.readTextFile(f); } catch { return; }
    for (const m of src.matchAll(/from\s+"(\.[^"]+)"/g)) {
      await walk(new URL(m[1], `file://${f}`).pathname);
    }
  }
  await walk(await Deno.realPath(entry));
  return [...seen].map((f) => f.replace(`${Deno.cwd()}/`, "")).sort();
}

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "")
   .replace(/\bipo_[a-z_]+/g, "");

/** Tables the IPO stack must never write, at any depth. */
const SMC_TRADING_TABLES = [
  "paper_positions", "pending_orders", "paper_trade_history", "paper_accounts",
];

Deno.test("ipo-paper-state reaches only itself, cors and the health parser", async () => {
  // The browser-facing read API. Its closure is the guarantee: it cannot fetch
  // a candle, cannot run an engine, and cannot reach infrastructure at all.
  // `ipoRunnerHealth` was added so the view can show whether the runner is
  // alive; it is pure, and the next assertion pins that rather than trusting it.
  // `ipoCausalOrdering` was added for the forward-evidence boundary constant and
  // `ipoCausalEvidence` for the canonical causal population. Both are pure and
  // the first is IMPORT-FREE, so the read path still cannot reach a candle
  // source, an engine or any infrastructure.
  assertEquals(await closure("supabase/functions/ipo-paper-state/index.ts"), [
    "supabase/functions/_shared/cors.ts",
    "supabase/functions/_shared/ipoCausalEvidence.ts",
    "supabase/functions/_shared/ipoCausalOrdering.ts",
    "supabase/functions/_shared/ipoRunnerHealth.ts",
    "supabase/functions/ipo-paper-state/index.ts",
  ]);
  for (const mod of ["ipoRunnerHealth", "ipoCausalOrdering", "ipoCausalEvidence"]) {
    const src = strip(await Deno.readTextFile(`supabase/functions/_shared/${mod}.ts`));
    for (const impure of ["createClient", "fetch(", "Deno.env", ".from(", "supabase-js"]) {
      assert(!src.includes(impure), `${mod} is not pure: ${impure}`);
    }
  }
  // And it stays import-free, which is what keeps the closure above small.
  const ordering = await Deno.readTextFile("supabase/functions/_shared/ipoCausalOrdering.ts");
  assert(!/^\s*import\s/m.test(ordering),
    "ipoCausalOrdering gained an import — the read path's closure just widened");
});

Deno.test("no IPO function can reach a broker execution path", async () => {
  for (const entry of ["supabase/functions/ipo-observation/index.ts",
                       "supabase/functions/ipo-paper-state/index.ts"]) {
    for (const f of await closure(entry)) {
      const code = strip(await Deno.readTextFile(f));
      for (const banned of ["broker-execute", "placeOrder", "closePosition",
                            "modifyPosition", "createOrder"]) {
        assert(!code.includes(banned), `${entry} reaches ${banned} via ${f}`);
      }
    }
  }
});

Deno.test("no IPO function can write an SMC TRADING table at any depth", async () => {
  for (const entry of ["supabase/functions/ipo-observation/index.ts",
                       "supabase/functions/ipo-paper-state/index.ts"]) {
    for (const f of await closure(entry)) {
      const code = strip(await Deno.readTextFile(f));
      for (const t of SMC_TRADING_TABLES) {
        assert(!code.includes(t), `${entry} reaches SMC trading table ${t} via ${f}`);
      }
    }
  }
});

Deno.test("ipo-observation's closure can write NOTHING", async () => {
  // It was kv_cache plus a guarded broker_connections exception. Both are gone:
  // single-writer ownership removed the fetch, which removed candleSource from
  // the closure entirely. The exception is eliminated rather than guarded.
  const writes = new Set<string>();
  for (const f of await closure("supabase/functions/ipo-observation/index.ts")) {
    const code = strip(await Deno.readTextFile(f));
    for (const m of code.matchAll(/\.from\("([^"]+)"\)[\s\S]{0,80}?\.(insert|upsert|update|delete)\(/g)) {
      writes.add(m[1]);
    }
  }
  assertEquals([...writes], [], "the read surface can reach a write");
});

Deno.test("ipo-observation cannot fetch a candle at any depth", async () => {
  for (const f of await closure("supabase/functions/ipo-observation/index.ts")) {
    const code = strip(await Deno.readTextFile(f));
    assert(!code.includes("fetchCandlesWithFallback"),
      `the read surface reaches the candle source via ${f}`);
    assert(!code.includes("candleSource"), `candleSource is back in the closure via ${f}`);
  }
});

Deno.test("the broker_connections write sits behind exactly one guarded call", async () => {
  const src = await Deno.readTextFile("supabase/functions/_shared/candleSource.ts");
  const code = strip(src);

  // It lives in one function, and that function is called from one place.
  const defs = [...code.matchAll(/async function persistSymbolOverride\(/g)];
  assertEquals(defs.length, 1, "more than one definition");
  const calls = [...code.matchAll(/await persistSymbolOverride\(/g)];
  assertEquals(calls.length, 1, "more than one call site — the guard would be incomplete");

  // And that one call is inside the guard.
  const at = code.indexOf("await persistSymbolOverride(");
  const before = code.slice(Math.max(0, at - 220), at);
  assert(before.includes("shouldPersistSymbolOverride(opts)"),
    "the call site is not guarded by shouldPersistSymbolOverride");

  // No other statement writes that table.
  const brokerWrites = [...code.matchAll(/\.from\("broker_connections"\)[\s\S]{0,80}?\.(insert|upsert|update|delete)\(/g)];
  assertEquals(brokerWrites.length, 1, "a second broker_connections write exists, outside the guard");
});

Deno.test("the default is persist — every existing SMC caller is unaffected", async () => {
  // The guard is `!== false`, so a caller that says nothing keeps writing.
  assertEquals(shouldPersistSymbolOverride({}), true);
  assertEquals(shouldPersistSymbolOverride({ persistSymbolOverrides: undefined }), true);
  assertEquals(shouldPersistSymbolOverride({ persistSymbolOverrides: true }), true);
  assertEquals(shouldPersistSymbolOverride({ persistSymbolOverrides: false }), false);

  // And nothing except ipo-observation sets it, so no SMC behaviour moved.
  const setters: string[] = [];
  for await (const e of Deno.readDir("supabase/functions")) {
    if (!e.isDirectory || e.name === "_shared") continue;
    const src = await Deno.readTextFile(`supabase/functions/${e.name}/index.ts`);
    if (src.includes("persistSymbolOverrides")) setters.push(e.name);
  }
  // The runtime owner is the only fetcher, so it is the only opt-out setter.
  assertEquals(setters, ["ipo-paper-runner"]);
});

Deno.test("every candle fetch in the IPO stack opts out of the override write", async () => {
  // The fetch moved from observation to the paper runner when runtime ownership
  // was corrected. The opt-out has to move with it, so this checks whoever has
  // the fetch rather than a named function.
  for (const f of ["supabase/functions/ipo-paper-runner/index.ts",
                   "supabase/functions/ipo-observation/index.ts",
                   "local-runner/ipo-bootstrap.ts"]) {
    const code = strip(await Deno.readTextFile(f));
    for (const c of code.matchAll(/fetchCandlesWithFallback\(\{[\s\S]*?\}/g)) {
      assert(c[0].includes("persistSymbolOverrides: false"),
        `${f}: a fetch without the opt-out: ${c[0].slice(0, 120)}`);
    }
  }
});

Deno.test("ipo-paper-state writes nothing at all", async () => {
  for (const f of await closure("supabase/functions/ipo-paper-state/index.ts")) {
    const code = strip(await Deno.readTextFile(f));
    for (const verb of [".insert(", ".upsert(", ".update(", ".delete("]) {
      assert(!code.includes(verb), `the read API can ${verb} via ${f}`);
    }
  }
});

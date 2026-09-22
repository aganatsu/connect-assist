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

Deno.test("ipo-paper-state reaches nothing but itself and cors", async () => {
  // The browser-facing read API. Its closure is the guarantee: it cannot fetch
  // a candle, cannot run an engine, and cannot reach infrastructure at all.
  assertEquals(await closure("supabase/functions/ipo-paper-state/index.ts"), [
    "supabase/functions/_shared/cors.ts",
    "supabase/functions/ipo-paper-state/index.ts",
  ]);
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

Deno.test("the ONLY table ipo-observation can write transitively is kv_cache and broker_connections", async () => {
  // DISCLOSED, NOT WAIVED. `candleSource` persists an auto-discovered symbol
  // mapping with
  //     supabase.from("broker_connections").update({ symbol_overrides })
  // so `ipo-observation` inherits a write to an SMC-owned CONFIG table. It is
  // not trading state and not a broker order, and it is the same line the SMC
  // scanner already executes — but it is a write, and the Phase C claim that
  // this function "writes only kv_cache" was therefore narrower than it sounded.
  //
  // Pinned here so the set cannot grow quietly. Shrinking it is the goal;
  // growing it must be a deliberate edit to this list.
  const writes = new Set<string>();
  for (const f of await closure("supabase/functions/ipo-observation/index.ts")) {
    const code = strip(await Deno.readTextFile(f));
    for (const m of code.matchAll(/\.from\("([^"]+)"\)\s*\n?\s*\.(insert|upsert|update|delete)/g)) {
      writes.add(m[1]);
    }
    // multi-line form: .from("x") then a later .update(
    for (const m of code.matchAll(/\.from\("([^"]+)"\)[\s\S]{0,80}?\.(insert|upsert|update|delete)\(/g)) {
      writes.add(m[1]);
    }
  }
  assertEquals([...writes].sort(), ["broker_connections", "kv_cache"]);
});

Deno.test("ipo-paper-state writes nothing at all", async () => {
  for (const f of await closure("supabase/functions/ipo-paper-state/index.ts")) {
    const code = strip(await Deno.readTextFile(f));
    for (const verb of [".insert(", ".upsert(", ".update(", ".delete("]) {
      assert(!code.includes(verb), `the read API can ${verb} via ${f}`);
    }
  }
});

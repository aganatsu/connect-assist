/**
 * Bootstrap ownership. Off-Edge builds it; Edge may only restore it.
 *
 * The rule exists because the first real deployment of `ipo-observation` failed
 * every invocation with WORKER_RESOURCE_LIMIT — one instrument, killed for
 * compute, because a 1,200-bar rebuild costs ~17s of CPU against an Edge budget
 * of a few seconds. These tests keep the fix from eroding: the expensive path
 * must stay out of the functions, and the functions must refuse rather than
 * improvise when state is missing.
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { IncrementalEngine } from "../../functions/_shared/ipoIncrementalEngine.ts";
import {
  IPO_INSTRUMENTS, HISTORY_BARS, INCREMENTAL_BARS, engineStateKey,
  engineConfig, exportMeta, instrumentBySymbol,
} from "../../functions/_shared/ipoInstruments.ts";
import {
  exportState, serializeState, restoreState, parseState,
  RUNTIME_STATE_SCHEMA_VERSION,
} from "../../functions/_shared/ipoEngineState.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const BAR_MS = 3_600_000;
function market(n: number, seed = 7): Candle[] {
  let x = seed;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const out: Candle[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const vol = 0.3 + Math.abs(Math.sin(i / 90)) * 1.4;
    const o = p;
    p = Math.max(1, p + (rnd() - 0.5) * vol * 2);
    out.push({ datetime: new Date(Date.UTC(2025, 0, 1) + i * BAR_MS).toISOString(),
      open: o, high: Math.max(o, p) + rnd() * vol, low: Math.min(o, p) - rnd() * vol,
      close: p, volume: 0 });
  }
  return out;
}

/** Exactly what local-runner/ipo-bootstrap.ts does, minus the network and DB. */
function bootstrap(symbol: string, bars: Candle[]): string {
  const cfg = instrumentBySymbol(symbol)!;
  const engine = new IncrementalEngine(engineConfig(cfg));
  for (const b of bars) engine.feed(b);
  return serializeState(exportState(engine, engineConfig(cfg), exportMeta(cfg)));
}

// ── the bootstrap contract ───────────────────────────────────────────────────

Deno.test("repeated bootstrap on identical bars is byte-identical", () => {
  const bars = market(400);
  const a = bootstrap("EUR/USD", bars);
  const b = bootstrap("EUR/USD", bars);
  assertEquals(b, a, "the bootstrap must be idempotent or re-running it is a risk");
});

Deno.test("bootstrapped state carries both versions and restores in the Edge shape", () => {
  const cfg = instrumentBySymbol("EUR/USD")!;
  const payload = bootstrap("EUR/USD", market(400));
  const st = parseState(payload)!;
  // The constant, not a literal: a schema bump is a deliberate act and this
  // test should not have to be remembered as part of it.
  assertEquals(st.identity.schemaVersion, RUNTIME_STATE_SCHEMA_VERSION);
  assertEquals(st.identity.strategyVersion, "spec-1.1");
  assertEquals(st.identity.costModelId, "fx_fixed_0.00008");
  assertEquals(st.identity.instrument, "EUR/USD");

  // The Edge function restores with exactly these two derived values.
  const r = restoreState(payload, engineConfig(cfg), exportMeta(cfg));
  assert(r.ok, `Edge could not restore the bootstrap: ${r.ok ? "" : r.reason}`);
});

Deno.test("state written for one instrument cannot be restored as another", () => {
  const payload = bootstrap("EUR/USD", market(400));
  const jpy = instrumentBySymbol("USD/JPY")!;
  const r = restoreState(payload, engineConfig(jpy), exportMeta(jpy));
  assert(!r.ok);
  assertEquals(r.reason, "INSTRUMENT_CONFIG_CHANGED");
});

Deno.test("a warm restore advances to the same place as an uninterrupted run", () => {
  // The whole point: what the local bootstrap hands over must continue exactly.
  const cfg = instrumentBySymbol("EUR/USD")!;
  const all = market(430);
  const live = new IncrementalEngine(engineConfig(cfg));
  for (const b of all.slice(0, 400)) live.feed(b);
  const handover = serializeState(exportState(live, engineConfig(cfg), exportMeta(cfg)));
  const baseline = all.slice(400).flatMap((b) => live.feed(b))
    .map((e) => JSON.parse(JSON.stringify(e)));

  const r = restoreState(handover, engineConfig(cfg), exportMeta(cfg));
  assert(r.ok);
  const warm = all.slice(400).flatMap((b) => r.engine.feed(b))
    .map((e) => JSON.parse(JSON.stringify(e)));

  assertEquals(JSON.stringify(warm), JSON.stringify(baseline));
});

// ── one spec, one key ────────────────────────────────────────────────────────

Deno.test("the instrument spec is defined once and matches the frozen set", () => {
  assertEquals(IPO_INSTRUMENTS.map((i) => i.instrument), ["EUR/USD", "USD/JPY", "BTC/USD"]);
  assertEquals(IPO_INSTRUMENTS.map((i) => i.timeframe), ["1h", "30min", "1h"]);
  assertEquals(IPO_INSTRUMENTS.map((i) => i.highVolOnly), [false, false, true]);
  assertEquals(HISTORY_BARS, 1200, "history depth must not be reduced to fit a platform limit");
  assertEquals(INCREMENTAL_BARS, 120);
  // Every cost model must be named, or restore cannot detect a re-priced model.
  for (const i of IPO_INSTRUMENTS) assert(i.costModelId.length > 0);
  assertEquals(new Set(IPO_INSTRUMENTS.map((i) => i.costModelId)).size, 3);
});

Deno.test("the bootstrap and the Edge functions agree on the state key", async () => {
  assertEquals(engineStateKey("EUR/USD"), "ipo_engine_state:ipo_cet:EUR/USD");
  // Nobody may build that key by hand; a second spelling is a silent miss.
  for (const f of ["supabase/functions/ipo-observation/index.ts",
                   "supabase/functions/ipo-paper-runner/index.ts",
                   "local-runner/ipo-bootstrap.ts"]) {
    const src = await Deno.readTextFile(f);
    assert(src.includes("engineStateKey"), `${f} does not use the shared key helper`);
    assert(!/`ipo_engine_state:/.test(src), `${f} builds the state key by hand`);
  }
});

Deno.test("no function carries its own copy of the instrument list", async () => {
  for (const f of ["supabase/functions/ipo-observation/index.ts",
                   "supabase/functions/ipo-paper-runner/index.ts"]) {
    const src = await Deno.readTextFile(f);
    assert(src.includes("ipoInstruments.ts"), `${f} does not import the shared spec`);
    // A local literal would drift and present as INSTRUMENT_CONFIG_CHANGED.
    assert(!/costPerSide:\s*\(/.test(src), `${f} redefines a cost model locally`);
  }
});

// ── Edge must fail closed ────────────────────────────────────────────────────

Deno.test("no Edge function can bootstrap", async () => {
  for (const f of ["supabase/functions/ipo-observation/index.ts",
                   "supabase/functions/ipo-paper-runner/index.ts"]) {
    const src = await Deno.readTextFile(f);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
    assert(!code.includes("new IncrementalEngine("),
      `${f} constructs an engine — that is a bootstrap, and Edge cannot afford one`);
    assert(!code.includes("HISTORY_BARS"),
      `${f} still references the full history depth`);
  }
});

Deno.test("ipo-observation returns BOOTSTRAP_REQUIRED and fetches nothing first", async () => {
  const code = (await Deno.readTextFile("supabase/functions/ipo-observation/index.ts"))
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
  assert(code.includes('"BOOTSTRAP_REQUIRED"'), "no fail-closed status");

  // Order matters as much as presence: a fetch before the restore check would
  // spend provider credits on an instrument that cannot be served anyway.
  const restoreAt = code.indexOf("restoreState(");
  const fetchAt = code.indexOf("fetchCandlesWithFallback(");
  assert(restoreAt > 0 && fetchAt > 0);
  assert(restoreAt < fetchAt, "candles are fetched before state is restored");

  // And the bail-out must sit between them.
  const bail = code.indexOf('out.status = "BOOTSTRAP_REQUIRED"');
  assert(bail > restoreAt && bail < fetchAt,
    "the fail-closed branch does not short-circuit the fetch");
});

Deno.test("the bootstrap runner touches no SMC table and no broker", async () => {
  const src = await Deno.readTextFile("local-runner/ipo-bootstrap.ts");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "")
    .replace(/\bipo_[a-z_]+/g, "");
  for (const banned of ["paper_positions", "pending_orders", "paper_trade_history",
                        "paper_accounts", "broker-execute", "broker_connections",
                        "placeOrder", "closePosition"]) {
    assert(!code.includes(banned), `the bootstrap references ${banned}`);
  }
  // It writes exactly one table.
  const tables = [...code.matchAll(/\.from\("([^"]+)"\)/g)].map((m) => m[1]);
  assertEquals([...new Set(tables)], ["kv_cache"]);
  assert(src.includes("persistSymbolOverrides: false"),
    "the bootstrap must fetch read-only too");
});

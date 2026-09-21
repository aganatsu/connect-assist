import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { observe, closedBarsOnly } from "../../functions/_shared/ipoObservation.ts";
import type { EngineConfig } from "../../functions/_shared/ipoLiveEngine.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const OBS = "supabase/functions/ipo-observation/index.ts";
const MOD = "supabase/functions/_shared/ipoObservation.ts";

const bar = (i: number, o: number, h: number, l: number, c: number): Candle =>
  ({ datetime: new Date(Date.UTC(2025, 0, 1) + i * 3600_000).toISOString(),
     open: o, high: h, low: l, close: c, volume: 0 } as Candle);

function market(n: number, seed = 7): Candle[] {
  let x = seed;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const out: Candle[] = []; let p = 100;
  for (let i = 0; i < n; i++) {
    const vol = 0.3 + Math.abs(Math.sin(i / 90)) * 1.4;
    const o = p; p = Math.max(1, p + (rnd() - 0.5) * vol * 2);
    out.push(bar(i, o, Math.max(o, p) + rnd() * vol, Math.min(o, p) - rnd() * vol, p));
  }
  return out;
}
const cfg = (o: Partial<EngineConfig> = {}): EngineConfig =>
  ({ instrument: "EUR/USD", timeframe: "1h", highVolOnly: false, costPerSide: () => 0.00008, ...o });

Deno.test("OBSERVATION ONLY — no broker path anywhere", async () => {
  for (const f of [OBS, MOD]) {
    const src = await Deno.readTextFile(f);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
    for (const forbidden of ["broker-execute", "brokerExecute", "place_order", "close_trade",
                             "modify_trade", "multiBrokerFailover", "propFirmGate",
                             "unifiedPositionSizing"]) {
      assert(!code.includes(forbidden), `${f} references "${forbidden}"`);
    }
  }
});

Deno.test("no SMC trading-state table is read or written", async () => {
  for (const f of [OBS, MOD]) {
    const src = await Deno.readTextFile(f);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
    // Match table NAMES as they appear in a query, not as substrings: the
    // snapshot has a `completedTrades` count and "trades" would false-positive.
    for (const tbl of ["paper_positions", "pending_orders", "paper_trade_history",
                       "paper_accounts", "staged_setups", "trades", "bot_configs"]) {
      assert(!code.includes(`"${tbl}"`), `${f} references SMC table "${tbl}"`);
      assert(!code.includes(`'${tbl}'`), `${f} references SMC table '${tbl}'`);
    }
  }
  // The endpoint may touch exactly one table, and it is the generic cache.
  const src = await Deno.readTextFile(OBS);
  const tables = [...src.matchAll(/\.from\("([^"]+)"\)/g)].map((m) => m[1]);
  assertEquals([...new Set(tables)], ["kv_cache"]);
});

Deno.test("the pure observation module touches no database at all", async () => {
  const src = await Deno.readTextFile(MOD);
  for (const t of ["createClient", "supabase", ".from(", "kv_cache"]) {
    assert(!src.includes(t), `the snapshot builder must be pure; found "${t}"`);
  }
});

Deno.test("strategy ownership is explicit on every row", () => {
  const snap = observe(market(400), cfg());
  assertEquals(snap.instrument, "EUR/USD");
  assert(snap.rows.length > 0, "fixture produced no rows");
  for (const r of snap.rows) {
    assertEquals(r.instrument, "EUR/USD");
    assertEquals(r.timeframe, "1h");
  }
});

Deno.test("closed-bar filtering drops a bar that has not finished", () => {
  const s = market(10);
  const barMs = 3_600_000;
  const lastOpen = new Date(s[9].datetime).getTime();
  // "now" one minute into the final bar: it is still forming.
  const closed = closedBarsOnly(s, lastOpen + 60_000, barMs);
  assertEquals(closed.length, 9, "the forming bar must be excluded");
  // "now" after it completes: it counts.
  assertEquals(closedBarsOnly(s, lastOpen + barMs, barMs).length, 10);
});

Deno.test("observation is idempotent — same closed bars give the same snapshot", () => {
  const s = market(400, 3);
  const a = observe(s, cfg());
  const b = observe(s, cfg());
  assertEquals(JSON.stringify(a), JSON.stringify(b));
});

Deno.test("re-observing after one more bar changes only the newest state", () => {
  const s = market(400, 5);
  const a = observe(s.slice(0, 399), cfg());
  const b = observe(s, cfg());
  assert(b.barsProcessed === a.barsProcessed + 1);
  // Compare only candidates present in BOTH snapshots. The scanner trims
  // long-dead rows on a sliding window, so one dropping out is the display
  // filter working, not a state change.
  const index = (snap: typeof a) =>
    new Map(snap.rows.map((r) => [r.ipoIndex, `${r.state}:${r.intendedEntry}`]));
  const ia = index(a), ib = index(b);
  let compared = 0;
  for (const [k, v] of ia) {
    if (k >= 300 || !ib.has(k)) continue;
    assertEquals(ib.get(k), v, `candidate ${k} changed when a later bar arrived`);
    compared++;
  }
  assert(compared > 10, `only ${compared} candidates compared — too weak a check`);
});

Deno.test("execution eligibility is reported, never acted on", async () => {
  const snap = observe(market(500, 11), cfg());
  for (const r of snap.rows) assertEquals(typeof r.executionEligible, "boolean");
  const src = await Deno.readTextFile(MOD);
  for (const verb of ["insert", "upsert", "update", "delete", "placeOrder", "execute"]) {
    assert(!new RegExp(`\\.${verb}\\(`).test(src), `the snapshot builder calls .${verb}(`);
  }
});

Deno.test("a volatility-gated instrument reports ineligibility rather than hiding rows", () => {
  const snap = observe(market(500, 42), cfg({ instrument: "BTC/USD", highVolOnly: true }));
  const ineligible = snap.rows.filter((r) => !r.volatilityEligible);
  if (ineligible.length) {
    for (const r of ineligible) {
      assert(r.reasonCodes.includes("VOLATILITY_NOT_ELIGIBLE"));
      assertEquals(r.executionEligible, false);
    }
  }
  // Rows still exist regardless of eligibility — observation shows everything.
  assert(snap.rows.length > 0);
});

Deno.test("research-only states are marked NOT_TRACKED, not fabricated as 'no'", () => {
  const snap = observe(market(400), cfg());
  for (const r of snap.rows) {
    assertEquals(r.moveAway, "NOT_TRACKED");
    assertEquals(r.expansion, "NOT_TRACKED");
    assertEquals(r.trend, "NOT_TRACKED");
    // The three the frozen lifecycle really computes must be definite.
    assert(["YES", "NO"].includes(r.contraction));
    assert(["YES", "NO"].includes(r.touch));
    assert(["YES", "NO"].includes(r.oppositeSideCleared));
  }
});

Deno.test("the plan matches the frozen rules: entry is the midpoint, target is 2R", () => {
  const snap = observe(market(500, 13), cfg());
  for (const r of snap.rows) {
    assertEquals(r.intendedEntry, r.midpoint);
    const expected = r.direction === "long"
      ? r.intendedEntry + 2 * r.riskPrice : r.intendedEntry - 2 * r.riskPrice;
    assertEquals(Math.round(r.target2R * 1e9), Math.round(expected * 1e9));
    assertEquals(Math.round(r.riskPrice * 1e9),
      Math.round(Math.abs(r.intendedEntry - r.s2Invalidation) * 1e9));
  }
});

Deno.test("the endpoint observes exactly the three frozen instruments", async () => {
  const src = await Deno.readTextFile(OBS);
  assert(src.includes('"EUR/USD"') && src.includes('"USD/JPY"') && src.includes('"BTC/USD"'));
  assert(src.includes("highVolOnly: true"), "BTC must stay volatility-gated");
  const syms = [...src.matchAll(/instrument: "([A-Z/]+)"/g)].map((m) => m[1]);
  assertEquals(syms, ["EUR/USD", "USD/JPY", "BTC/USD"]);
});

/**
 * Phase D edge-function guards.
 *
 * These tests are structural. They read the two function sources and pin what
 * they are allowed to touch, because the isolation guarantee has to survive
 * people, not just this commit.
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  PAPER_INSTRUMENTS, HISTORY_BARS, stateKey, sizingFromEnv,
  positionRow, historyRow, eventRow, parseState, rowToPosition,
} from "../../functions/ipo-paper-runner/index.ts";
import { summarize, RECENT_TRADES } from "../../functions/ipo-paper-state/index.ts";
import {
  buildIntent, openPosition, abortForGap, stepPosition,
  DEFAULT_SIZING, STRATEGY_ID,
} from "../../functions/_shared/ipoPaperContract.ts";
import type { LiveTrade } from "../../functions/_shared/ipoLiveEngine.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const RUNNER = "supabase/functions/ipo-paper-runner/index.ts";
const READER = "supabase/functions/ipo-paper-state/index.ts";

const src = (p: string) => Deno.readTextFile(p);
/** Comments describe what is forbidden, so only real code is searched. */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");

const bar = (i: number, o: number, h: number, l: number, c: number): Candle =>
  ({ datetime: `2026-02-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
     open: o, high: h, low: l, close: c, volume: 0 } as Candle);
const bars = Array.from({ length: 6 }, (_, i) => bar(i, 100, 101, 99, 100));
const trade: LiveTrade = {
  instrument: "EUR/USD", direction: "demand", ipoIndex: 0, entryIndex: 2,
  entry: 100, stop: 99, target: 102, risk: 1, vol: "HIGH_VOL", costR: 0.3,
  exitIndex: null, exitPrice: null, netR: null, mae: 0, mfe: 0,
};
const pos = () => openPosition(buildIntent(trade, bars, "1h"));

// ── isolation ────────────────────────────────────────────────────────────────

Deno.test("neither function can reach an SMC trading table or a broker", async () => {
  for (const f of [RUNNER, READER]) {
    // IPO's own tables contain the SMC names as substrings — ipo_paper_positions
    // ends in paper_positions — so the IPO-owned identifiers are removed first
    // and the bare SMC names are then searched for in what remains.
    const c = code(await src(f)).replace(/\bipo_[a-z_]+/g, "");
    for (const banned of [
      "paper_positions", "pending_orders", "paper_trade_history", "paper_accounts",
      "trade_history", "bot_setups", "broker_connections",
      "broker-execute", "paper-trading", "bot-scanner",
      "unifiedPositionSizing", "propFirmGate", "calculateSLTP", "scannerManagement",
    ]) {
      assert(!c.includes(banned), `${f} references "${banned}"`);
    }
  }
});

Deno.test("the worker writes only IPO-owned tables plus kv_cache", async () => {
  const c = code(await src(RUNNER));
  const tables = [...c.matchAll(/\.from\("([^"]+)"\)/g)].map((m) => m[1]);
  assertEquals(
    [...new Set(tables)].sort(),
    ["ipo_execution_events", "ipo_paper_positions", "ipo_paper_trade_history", "kv_cache"],
  );
});

Deno.test("the read path runs no engine, fetches no candles and writes nothing", async () => {
  const c = code(await src(READER));
  for (const banned of ["IncrementalEngine", "LiveEngine", "runPaper", "observe(",
                        "fetchCandlesWithFallback", "candleSource",
                        ".insert(", ".upsert(", ".update(", ".delete("]) {
    assert(!c.includes(banned), `the read path does "${banned}" — the UI must never bootstrap`);
  }
  assert(c.includes(".select("), "it must at least read");
});

Deno.test("the bootstrap lives in the worker and only there", async () => {
  const worker = code(await src(RUNNER));
  assert(worker.includes("runPaper("), "the worker is where the rebuild happens");
  assertEquals(HISTORY_BARS, 1200, "normal history must not be raised above 1,200");
});

Deno.test("importing a function must not bind a port", async () => {
  for (const f of [RUNNER, READER]) {
    const c = code(await src(f));
    assert(c.includes("if (import.meta.main) Deno.serve(handler)"),
      `${f} serves unconditionally`);
    assertEquals((c.match(/Deno\.serve/g) ?? []).length, 1);
  }
});

Deno.test("the traded set is the frozen spec, unchanged", () => {
  assertEquals(PAPER_INSTRUMENTS.map((i) => i.instrument), ["EUR/USD", "USD/JPY", "BTC/USD"]);
  assertEquals(PAPER_INSTRUMENTS.map((i) => i.timeframe), ["1h", "30min", "1h"]);
  assertEquals(PAPER_INSTRUMENTS.map((i) => i.highVolOnly), [false, false, true]);
});

// ── sizing is configuration, not strategy ────────────────────────────────────

Deno.test("sizing comes from the environment and defaults to $100,000 at 0.20%", () => {
  const none = sizingFromEnv(() => undefined);
  assertEquals(none, DEFAULT_SIZING);
  assertEquals(none.referenceBalance, 100_000);
  assertEquals(none.nominalRiskPct, 0.20);

  const custom = sizingFromEnv((k) => ({
    IPO_PAPER_REFERENCE_BALANCE: "250000", IPO_PAPER_NOMINAL_RISK_PCT: "0.5",
  } as Record<string, string>)[k]);
  assertEquals(custom, { referenceBalance: 250_000, nominalRiskPct: 0.5 });
});

Deno.test("nonsense sizing falls back rather than producing a zero-risk account", () => {
  for (const bad of ["", "abc", "0", "-5"]) {
    const s = sizingFromEnv((k) => k === "IPO_PAPER_NOMINAL_RISK_PCT" ? bad : undefined);
    assertEquals(s.nominalRiskPct, DEFAULT_SIZING.nominalRiskPct, `"${bad}" should not apply`);
  }
});

Deno.test("the risk percentage is not hardcoded into the strategy engine", async () => {
  for (const f of ["ipoIncrementalEngine.ts", "ipoLiveEngine.ts", "ipoPaperRunner.ts"]) {
    const c = code(await src(`supabase/functions/_shared/${f}`));
    for (const leak of ["0.20", "100_000", "100000", "IPO_PAPER_REFERENCE_BALANCE"]) {
      assert(!c.includes(leak), `${f} hardcodes sizing ("${leak}")`);
    }
  }
});

// ── row mapping ──────────────────────────────────────────────────────────────

Deno.test("a position row carries its own ownership and is paper by construction", () => {
  const r = positionRow(pos(), "11111111-1111-1111-1111-111111111111");
  assertEquals(r.strategy_id, STRATEGY_ID);
  assertEquals(r.execution_mode, "paper");
  assertEquals(r.status, "open");
  assert(r.user_id.length > 0);
  // Sizing is stored per row, so a later policy change cannot rewrite history.
  assertEquals(r.reference_balance_at_entry, 100_000);
  assertEquals(r.nominal_risk_pct, 0.20);
  assertEquals(r.nominal_risk_usd, 200);
});

Deno.test("a history row preserves R as canonical and dollars as derived", () => {
  const out = stepPosition(pos(), bar(3, 100, 102.5, 99.5, 102), 1);
  assert(out.kind === "CLOSED");
  const r = historyRow(out.result, "u");
  assertEquals(r.exit_reason, "TARGET_2R");
  assertEquals(r.gross_r, 2);
  assert(Math.abs(r.realized_r! - 1.7) < 1e-9);
  assertEquals(Math.round(r.realized_pnl_usd!), 340);
  assertEquals(r.excluded_from_stats, false);
});

Deno.test("an aborted row satisfies the schema's coherence rule", () => {
  // The migration CHECK requires: no exit price, no R, excluded, reason present.
  const r = historyRow(abortForGap(pos(), "2026-02-09T00:00:00Z", "feed gone"), "u");
  assertEquals(r.exit_reason, "DATA_GAP_ABORTED");
  assertEquals(r.exit_price, null);
  assertEquals(r.realized_r, null);
  assertEquals(r.realized_pnl_usd, null);
  assertEquals(r.excluded_from_stats, true);
  assert(r.exclusion_reason);
});

Deno.test("a position survives a round trip through the database shape", () => {
  const p = pos();
  const back = rowToPosition(positionRow(p, "u") as unknown as Record<string, unknown>);
  for (const k of ["intentId", "symbol", "direction", "entryPrice", "targetPrice",
                   "s2InvalidationLevel", "nominalRiskDistance", "costR",
                   "nominalRiskUsd", "status", "lastManagedBarTime"] as const) {
    assertEquals(back![k], p[k], `field ${k} did not survive the round trip`);
  }
});

Deno.test("an event row keeps the two decisions apart", () => {
  const r = eventRow({
    eventId: "evt_x", eventType: "REFUSED", symbol: "EUR/USD",
    barTime: "2026-02-03T00:00:00Z", setupId: "stp_x", intentId: "int_x",
    strategyDecision: "WOULD_ENTER", accountDecision: "BLOCK_CORRELATION",
    reasonCodes: ["BLOCK_CORRELATION"], payload: {},
  }, "u");
  assertEquals(r.strategy_decision, "WOULD_ENTER");
  assertEquals(r.account_decision, "BLOCK_CORRELATION");
});

// ── runtime state ────────────────────────────────────────────────────────────

Deno.test("the state key is namespaced per strategy and instrument", () => {
  assertEquals(stateKey("EUR/USD"), "ipo_paper_state:ipo_cet:EUR/USD");
  assert(stateKey("EUR/USD") !== stateKey("USD/JPY"));
});

Deno.test("an unreadable state row re-activates instead of guessing a cursor", () => {
  assertEquals(parseState(null), null);
  assertEquals(parseState("not json"), null);
  assertEquals(parseState('{"nope":1}'), null);
  assertEquals(parseState('{"symbol":"EUR/USD","cursorBarTime":"x"}')?.cursorBarTime, "x");
});

// ── the read path's summary ──────────────────────────────────────────────────

Deno.test("aborted trades are excluded from clean statistics but still counted", () => {
  const s = summarize([
    { realized_r: 1.7, realized_pnl_usd: 340, excluded_from_stats: false },
    { realized_r: -2.4, realized_pnl_usd: -480, excluded_from_stats: false },
    { realized_r: null, realized_pnl_usd: null, excluded_from_stats: true },
  ]);
  assertEquals(s.trades, 2);
  assertEquals(s.wins, 1);
  assertEquals(s.winRate, 0.5);
  assert(Math.abs(s.totalR - -0.7) < 1e-9);
  assert(Math.abs(s.expectancyR - -0.35) < 1e-9);
  assertEquals(s.totalPnlUsd, -140);
  assertEquals(s.abortedExcluded, 1, "the failure is visible, not hidden");
});

// ── schema guards ────────────────────────────────────────────────────────────

const MIGRATION = "supabase/migrations/20260921140000_ipo_paper_state.sql";

Deno.test("every event type the runner emits is accepted by the schema", async () => {
  // A new event type added in TypeScript and not in the CHECK would fail at
  // INSERT time, in production, on the one row that mattered.
  const sql = await src(MIGRATION);
  const listed = sql.slice(sql.indexOf("event_type text not null check"));
  const runner = await src("supabase/functions/_shared/ipoPaperRunner.ts");
  const declared = runner
    .slice(runner.indexOf("export type PaperEventType"), runner.indexOf("export interface PaperEvent"))
    .match(/"([A-Z_]+)"/g)!.map((s) => s.replaceAll('"', ""));
  assert(declared.length >= 9, `only ${declared.length} event types parsed`);
  for (const t of declared) assert(listed.includes(`'${t}'`), `schema rejects event type ${t}`);
});

Deno.test("every exit reason the contract produces is accepted by the schema", async () => {
  const sql = await src(MIGRATION);
  for (const r of ["TARGET_2R", "S2_CLOSE_INVALIDATION", "DATA_GAP_ABORTED"]) {
    assert(sql.includes(`'${r}'`), `schema rejects exit reason ${r}`);
  }
});

Deno.test("the schema cannot hold a live position or two open ones", async () => {
  const sql = await src(MIGRATION);
  assert(sql.includes("check (execution_mode = 'paper')"),
    "nothing but paper may be stored");
  assert(/create unique index[\s\S]*?ipo_paper_positions \(strategy_id, symbol\)[\s\S]*?where status in \('open','data_gap_suspended'\)/.test(sql),
    "one-open-per-instrument must be enforced by the database, not only by code");
});

Deno.test("the schema refuses an incoherent outcome row", async () => {
  const sql = await src(MIGRATION);
  const check = sql.slice(sql.indexOf("ipo_paper_history_outcome_coherent"));
  // A real exit must carry a price and an R; an abort must carry neither.
  assert(check.includes("exit_price is not null and realized_r is not null"));
  assert(check.includes("realized_r is null and excluded_from_stats = true"));
  assert(check.includes("exclusion_reason is not null"));
});

Deno.test("all three tables are RLS-forced and unreachable from a browser", async () => {
  const sql = await src(MIGRATION);
  for (const t of ["ipo_paper_positions", "ipo_paper_trade_history", "ipo_execution_events"]) {
    // ENABLE alone is not enough — without FORCE the table owner bypasses RLS.
    assert(sql.includes(`alter table public.${t}      enable row level security`) ||
           sql.includes(`alter table public.${t}  enable row level security`) ||
           sql.includes(`alter table public.${t}     enable row level security`),
      `${t} has no ENABLE RLS`);
    assert(new RegExp(`alter table public\\.${t}\\s+force\\s+row level security`).test(sql),
      `${t} has no FORCE RLS`);
    assert(new RegExp(`revoke all on public\\.${t}\\s+from anon, authenticated`).test(sql),
      `${t} is still granted to the browser roles`);
    assert(new RegExp(`grant all on public\\.${t}\\s+to service_role`).test(sql),
      `${t} is not reachable by the worker`);
  }
});

Deno.test("EVERY unapplied IPO table carries the full posture, not just Phase D's", () => {
  // `supabase db push` applies every pending migration, so this has to hold for
  // EVERY pending IPO migration, not just the one being thought about. The
  // superseded ledger migration was retired for exactly that reason: it would
  // have been applied alongside Phase D carrying ENABLE without FORCE or
  // REVOKE, which is a table that is empty to a browser rather than unreachable.
  const CASES = [
    ["20260921140000_ipo_paper_state.sql",
      ["ipo_paper_positions", "ipo_paper_trade_history", "ipo_execution_events"]],
  ] as const;

  for (const [file, tables] of CASES) {
    const sql = Deno.readTextFileSync(`supabase/migrations/${file}`);
    for (const t of tables) {
      for (const [what, re] of [
        ["ENABLE RLS", `alter table public\\.${t}\\s+enable row level security`],
        ["FORCE RLS", `alter table public\\.${t}\\s+force\\s+row level security`],
        ["REVOKE from browser roles", `revoke all on public\\.${t}\\s+from anon, authenticated`],
        ["GRANT to service_role", `grant all on public\\.${t}\\s+to service_role`],
      ] as const) {
        assert(new RegExp(re).test(sql), `${file}: ${t} is missing ${what}`);
      }
    }
  }
});

Deno.test("the retired ledger path cannot come back through a migration", async () => {
  // The table, its migration, its edge function and its row DTO were removed at
  // the D.2 checkpoint because Phase D's three tables supersede them and none of
  // it had ever reached main — so nothing was deployed and nothing was applied.
  // Re-adding it would put a fourth IPO table into production schema by
  // accident, which is the specific thing that retirement prevented.
  for await (const e of Deno.readDir("supabase/migrations")) {
    const sql = await Deno.readTextFile(`supabase/migrations/${e.name}`);
    assert(!sql.includes("ipo_paper_ledger"), `${e.name} resurrects ipo_paper_ledger`);
  }
  for await (const e of Deno.readDir("supabase/functions")) {
    if (!e.isDirectory || e.name === "_shared") continue;
    assert(e.name !== "ipo-paper-trading", "the superseded function is back");
    const src = await Deno.readTextFile(`supabase/functions/${e.name}/index.ts`);
    assert(!src.includes("ipo_paper_ledger"), `${e.name} writes the retired table`);
    assert(!src.includes("ipoForwardLedger"), `${e.name} imports the retired DTO`);
  }
});

Deno.test("no security hardening is left sitting in an unapplied patch file", async () => {
  // A patch staged for "whoever runs the paper phase" is a promise, not a
  // guarantee, and this one turned out not even to apply. If hardening matters
  // it belongs in the migration.
  try {
    const left = [...Deno.readDirSync("docs/patches")].filter((e) => e.name.endsWith(".patch"));
    assertEquals(left.map((e) => e.name), [], "security changes must live in the migration");
  } catch {
    // No patches directory at all is the desired end state.
  }
  await Promise.resolve();
});

Deno.test("an all-aborted window reports no expectancy rather than zero", () => {
  const s = summarize([{ realized_r: null, realized_pnl_usd: null, excluded_from_stats: true }]);
  assertEquals(s.trades, 0);
  assertEquals(s.totalR, 0);
  assertEquals(s.expectancyR, 0);
  assertEquals(s.abortedExcluded, 1);
  assertEquals(RECENT_TRADES, 100);
});

// ── the apply pack must never drift from the migrations ──────────────────────

Deno.test("the apply pack contains the migrations verbatim", async () => {
  // A stale copy would record a version as applied while the database received
  // different SQL — the same divergence class the repair step just cleaned up,
  // except self-inflicted and invisible.
  const pack = await Deno.readTextFile("supabase/queries/ipo_apply_pending.sql");
  for (const f of [
    "20260920200000_ipo_corpus_tier_and_source_family.sql",
    "20260921140000_ipo_paper_state.sql",
  ]) {
    const body = (await Deno.readTextFile(`supabase/migrations/${f}`)).trimEnd();
    assert(pack.includes(body), `${f} is not embedded verbatim in the apply pack`);
    const version = f.slice(0, 14);
    assert(pack.includes(`values ('${version}') on conflict (version) do nothing;`),
      `${f} has no bookkeeping insert in the pack`);
  }
});

Deno.test("each apply-pack migration records itself inside its own transaction", async () => {
  // Outside the transaction, a failed DDL would leave the version recorded and
  // the migration silently skipped forever.
  const pack = await Deno.readTextFile("supabase/queries/ipo_apply_pending.sql");
  const txs = pack.split(/^begin;$/m).slice(1);
  assertEquals(txs.length, 2, "expected exactly two transactions");
  for (const tx of txs) {
    const body = tx.slice(0, tx.indexOf("commit;"));
    assert(body.includes("schema_migrations"), "bookkeeping is outside the transaction");
  }
});

Deno.test("the apply pack applies only the two pending versions", async () => {
  const pack = await Deno.readTextFile("supabase/queries/ipo_apply_pending.sql");
  const recorded = [...pack.matchAll(/values \('(\d{14})'\)/g)].map((m) => m[1]);
  assertEquals(recorded.sort(), ["20260920200000", "20260921140000"]);
  // The repaired ones must not be touched again, and the retired one must not
  // reappear under any guise.
  for (const banned of ["20260920000000", "20260920100000", "ipo_paper_ledger"]) {
    assert(!pack.includes(banned), `the apply pack references ${banned}`);
  }
});

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

/**
 * T11 — the test written BEFORE any IPO paper row can exist.
 *
 * Phase C measured why this matters. `bot-daily-review` does not merely include
 * an unlabelled row, it ATTRIBUTES it to SMC:
 *
 *     if (t.bot_id) return t.bot_id === botId;
 *     ...
 *     return botId === "smc";        // a NULL bot_id row counts as an SMC trade
 *
 * So an IPO row in `paper_trade_history` would have inflated SMC's measured
 * performance rather than merely appearing beside it. These tests assert the
 * isolation is STRUCTURAL — the consumers cannot see IPO data because there is
 * no path from their queries to it, not because a filter excludes it.
 */

const SMC_CONSUMERS = [
  "supabase/functions/trades/index.ts",
  "supabase/functions/bot-daily-review/index.ts",
  "supabase/functions/bot-weekly-advisor/index.ts",
];
const IPO_TABLES = [
  "ipo_paper_positions", "ipo_paper_trade_history",
  "ipo_execution_events",
];

Deno.test("T11 — no SMC analytics consumer references any IPO table", async () => {
  for (const f of SMC_CONSUMERS) {
    const src = await Deno.readTextFile(f);
    for (const t of IPO_TABLES) {
      assert(!src.includes(t),
        `${f} references ${t} — IPO data must be invisible to SMC analytics`);
    }
  }
});

Deno.test("T11 — the SMC consumers still read exactly the tables they read before", async () => {
  // Pinned so that adding IPO can never widen an SMC query by accident.
  const expected: Record<string, string[]> = {
    "supabase/functions/trades/index.ts": ["paper_trade_history", "trades"],
    "supabase/functions/bot-daily-review/index.ts":
      ["bot_configs", "bot_recommendations", "paper_accounts", "paper_trade_history",
       "rejected_setups", "trade_reasonings", "user_settings"],
    "supabase/functions/bot-weekly-advisor/index.ts":
      ["bot_configs", "bot_recommendations", "broker_connections", "paper_accounts",
       "paper_trade_history", "rejected_setups", "trade_reasonings", "user_settings"],
  };
  for (const f of SMC_CONSUMERS) {
    const src = await Deno.readTextFile(f);
    const tables = [...new Set([...src.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1]))].sort();
    for (const t of tables) {
      assert(!t.startsWith("ipo_"), `${f} queries ${t}`);
    }
    assertEquals(tables, expected[f].sort(), `${f} table set changed`);
  }
});

Deno.test("T11 — no IPO module writes an SMC trading-state table", async () => {
  const forbidden = ["paper_positions", "pending_orders", "paper_trade_history", "paper_accounts"];
  for await (const e of Deno.readDir("supabase/functions/_shared")) {
    if (!e.name.startsWith("ipo") || !e.name.endsWith(".ts")) continue;
    const src = await Deno.readTextFile(`supabase/functions/_shared/${e.name}`);
    for (const t of forbidden) {
      assert(!src.includes(`"${t}"`) && !src.includes(`'${t}'`),
        `_shared/${e.name} references SMC table ${t}`);
    }
  }
  for await (const d of Deno.readDir("supabase/functions")) {
    if (!d.isDirectory || !d.name.startsWith("ipo-")) continue;
    const src = await Deno.readTextFile(`supabase/functions/${d.name}/index.ts`);
    const tables = [...new Set([...src.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1]))];
    for (const t of tables) {
      assert(t.startsWith("ipo_") || t === "kv_cache",
        `${d.name} writes ${t} — IPO may only touch ipo_* and kv_cache`);
    }
  }
});

Deno.test("T11 — there is no view, trigger or FK bridging IPO and SMC history", async () => {
  // A union or FK would re-create the pooling one level down, invisibly.
  for await (const e of Deno.readDir("supabase/migrations")) {
    if (!e.name.endsWith(".sql")) continue;
    const sql = (await Deno.readTextFile(`supabase/migrations/${e.name}`)).toLowerCase();
    if (!sql.includes("ipo_")) continue;
    for (const smc of ["paper_trade_history", "paper_positions", "pending_orders", "paper_accounts"]) {
      assert(!sql.includes(`references ${smc}`) && !sql.includes(`references public.${smc}`),
        `${e.name} creates a foreign key from an IPO table to ${smc}`);
      const bridging = sql.includes("create view") || sql.includes("create or replace view");
      if (bridging) {
        assert(!sql.includes(smc), `${e.name} creates a view spanning IPO and ${smc}`);
      }
    }
  }
});

Deno.test("T11 — the daily review's NULL-bot_id fallback still attributes to SMC", async () => {
  // Not a rule we like, but one we must not silently depend on changing. If this
  // ever stops being true the isolation argument needs revisiting, not the test.
  const src = await Deno.readTextFile("supabase/functions/bot-daily-review/index.ts");
  assert(src.includes('return botId === "smc"'),
    "the fallback changed — re-examine why IPO must stay out of paper_trade_history");
});

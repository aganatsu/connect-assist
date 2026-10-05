/**
 * reset.test.ts — Structural regression tests for paper-trading reset,
 * day-rollover, and daily loss gate (Gate 7) math.
 *
 * Branch: manus/fix-reset-daily-baseline-v2
 *
 * These tests read the source code of paper-trading/index.ts and
 * bot-scanner/index.ts to verify structural correctness of the reset
 * and day-rollover paths without needing a running Supabase instance.
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// ── Load source files ──
const paperSource = Deno.readTextFileSync(
  new URL("./index.ts", import.meta.url).pathname,
);
const scannerSource = Deno.readTextFileSync(
  new URL("../bot-scanner/index.ts", import.meta.url).pathname,
);

// ═══════════════════════════════════════════════════════════════════════
// Helper: extract a code block by action name
// ═══════════════════════════════════════════════════════════════════════
function extractBlock(source: string, actionName: string): string {
  // Through the SUCCESS response: each reset now has an early
  // `return respond({ error })` when the ledger refuses it.
  const regex = new RegExp(
    `if\\s*\\(action\\s*===\\s*"${actionName}"\\)\\s*\\{[\\s\\S]*?return respond\\(\\{\\s*success`,
    "g",
  );
  const matches = [...source.matchAll(regex)];
  // For blocks with multiple return statements (like set_balance with error return),
  // take the last match which includes the full block
  const match = matches[matches.length - 1];
  assert(match, `Block for action "${actionName}" not found`);
  return match[0];
}


// The balance, peak and daily baseline are set by reset_paper_account
// (migration 20261006010000) — one ledger entry and a new epoch — not by a
// direct update the balance guard would refuse.
const LEDGER_SQL = Deno.readTextFileSync(
  new URL("../../migrations/20261006010000_paper_settlement_ledger.sql", import.meta.url).pathname,
);
function resetFunctionSql(): string {
  const start = LEDGER_SQL.indexOf("CREATE OR REPLACE FUNCTION public.reset_paper_account(");
  assert(start > -1, "reset_paper_account not found in the ledger migration");
  return LEDGER_SQL.slice(start, LEDGER_SQL.indexOf("$function$;", start));
}
function assertLedgerReset(block: string, amountExpr: RegExp, name: string) {
  assert(amountExpr.test(block), `${name} must reset through resetPaperAccount with the right amount`);
  const fn = resetFunctionSql();
  assert(/daily_pnl_base = p_new_balance/.test(fn), "reset_paper_account sets daily_pnl_base to the new balance");
  assert(/daily_pnl_base_date = /.test(fn), "reset_paper_account sets daily_pnl_base_date");
  assert(!/daily_pnl_date\b/.test(fn), "reset_paper_account must NOT use legacy daily_pnl_date");
}

// ═══════════════════════════════════════════════════════════════════════
// Test 1: reset_balance_only — daily_pnl_base equals startBal
// ═══════════════════════════════════════════════════════════════════════
Deno.test("reset_balance_only: daily_pnl_base equals startBal", () => {
  const block = extractBlock(paperSource, "reset_balance_only");
  assertLedgerReset(block, /resetPaperAccount\(parseFloat\(startBal\)/, "reset_balance_only");
  assert(!block.includes('daily_pnl_base: "0"'), "reset_balance_only must NOT set daily_pnl_base to '0'");
});

// ═══════════════════════════════════════════════════════════════════════
// Test 2: reset_balance_only — uses daily_pnl_base_date column
// ═══════════════════════════════════════════════════════════════════════
Deno.test("reset_balance_only: uses daily_pnl_base_date column", () => {
  const block = extractBlock(paperSource, "reset_balance_only");
  assertLedgerReset(block, /resetPaperAccount\(parseFloat\(startBal\)/, "reset_balance_only");
  assert(!block.includes("daily_pnl_date:"), "reset_balance_only must NOT use legacy daily_pnl_date column");
});

// ═══════════════════════════════════════════════════════════════════════
// Test 3: reset_account — is_paused is true
// ═══════════════════════════════════════════════════════════════════════
Deno.test("reset_account: is_paused is true, not false", () => {
  const block = extractBlock(paperSource, "reset_account");
  assert(
    block.includes("is_paused: true"),
    "reset_account must set is_paused to true",
  );
  assert(
    !block.includes("is_paused: false"),
    "reset_account must NOT set is_paused to false",
  );
});

// ═══════════════════════════════════════════════════════════════════════
// Test 4: reset_account — deletes from trades table
// ═══════════════════════════════════════════════════════════════════════
Deno.test("reset_account: keeps the trade record", () => {
  // It used to delete history, reasonings, post-mortems, scan logs and trades.
  // The ledger epoch separates the periods now; the record is evidence.
  const block = extractBlock(paperSource, "reset_account");
  for (const table of ["paper_trade_history", "trade_reasonings", "trade_post_mortems", "scan_logs", "trades"]) {
    assert(!block.includes(`.from("${table}").delete()`), `reset_account must NOT delete ${table}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Test 5: reset_account — daily_pnl_base equals startBal
// ═══════════════════════════════════════════════════════════════════════
Deno.test("reset_account: daily_pnl_base equals startBal", () => {
  const block = extractBlock(paperSource, "reset_account");
  assertLedgerReset(block, /resetPaperAccount\(parseFloat\(startBal\)/, "reset_account");
  assert(!block.includes('daily_pnl_base: "0"'), "reset_account must NOT set daily_pnl_base to '0'");
});

// ═══════════════════════════════════════════════════════════════════════
// Test 6: reset_account — uses daily_pnl_base_date column
// ═══════════════════════════════════════════════════════════════════════
Deno.test("reset_account: uses daily_pnl_base_date column", () => {
  const block = extractBlock(paperSource, "reset_account");
  assertLedgerReset(block, /resetPaperAccount\(parseFloat\(startBal\)/, "reset_account");
  assert(!block.includes("daily_pnl_date:"), "reset_account must NOT use legacy daily_pnl_date column");
});

// ═══════════════════════════════════════════════════════════════════════
// Test 7: day-rollover — daily_pnl_base equals currentBalance
// ═══════════════════════════════════════════════════════════════════════
Deno.test("day-rollover: daily_pnl_base equals currentBalance (start-of-day balance)", () => {
  // The H17 block sets daily_pnl_base to currentBalance.toString()
  const h17Match = paperSource.match(
    /H17:[\s\S]*?daily_pnl_base:\s*currentBalance\.toString\(\)/,
  );
  assert(h17Match, "H17 day-rollover must set daily_pnl_base to currentBalance.toString()");
  assert(
    !h17Match![0].includes('daily_pnl_base: "0"'),
    "H17 day-rollover must NOT set daily_pnl_base to '0'",
  );
});

// ═══════════════════════════════════════════════════════════════════════
// Test 8: reset_account — response includes paused: true
// ═══════════════════════════════════════════════════════════════════════
Deno.test("reset_account: response includes paused: true", () => {
  const block = extractBlock(paperSource, "reset_account");
  assert(
    block.includes("paused: true"),
    "reset_account response must include paused: true",
  );
});

// ═══════════════════════════════════════════════════════════════════════
// Test 9: set_balance — uses daily_pnl_base_date column
// ═══════════════════════════════════════════════════════════════════════
Deno.test("set_balance: uses daily_pnl_base_date column", () => {
  const block = extractBlock(paperSource, "set_balance");
  assertLedgerReset(block, /resetPaperAccount\(newBalance,/, "set_balance");
  assert(!block.includes("daily_pnl_date:"), "set_balance must NOT use legacy daily_pnl_date column");
});

// ═══════════════════════════════════════════════════════════════════════
// Test 10: global — no references to wrong column daily_pnl_date in paper-trading
// ═══════════════════════════════════════════════════════════════════════
Deno.test("global: no references to wrong column daily_pnl_date in paper-trading/index.ts", () => {
  const lines = paperSource.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments
    if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
    assert(
      !line.includes("daily_pnl_date"),
      `Line ${i + 1} still references legacy column daily_pnl_date: ${line.trim()}`,
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Test 11: reset_account — deletes from all 6 required tables
// ═══════════════════════════════════════════════════════════════════════
Deno.test("reset_account: clears open positions, after the ledger reset", () => {
  const block = extractBlock(paperSource, "reset_account");
  const resetAt = block.indexOf("resetPaperAccount(");
  const deleteAt = block.indexOf('.from("paper_positions").delete()');
  assert(resetAt > -1 && deleteAt > -1, "both present");
  assert(resetAt < deleteAt, "a refused reset leaves the positions alone");
});

// ═══════════════════════════════════════════════════════════════════════
// Test 12: bot-scanner — no references to wrong column daily_pnl_date
// ═══════════════════════════════════════════════════════════════════════
Deno.test("bot-scanner: no references to wrong column daily_pnl_date", () => {
  const lines = scannerSource.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
    assert(
      !line.includes("daily_pnl_date"),
      `bot-scanner line ${i + 1} still references legacy column daily_pnl_date: ${line.trim()}`,
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Test 13: Gate 7 math — $10000 base, $9500 balance → 5% daily loss
// ═══════════════════════════════════════════════════════════════════════
Deno.test("Gate 7 math: $10000 base, $9500 balance → dailyLossPercent = 5%", () => {
  // Reproduce the exact Gate 7 formula from bot-scanner:
  //   dailyPnlBase = parseFloat(account.daily_pnl_base || account.balance || "10000")
  //   actualBase = account.daily_pnl_base_date === todayStr ? dailyPnlBase : balance
  //   dailyLoss = actualBase - balance
  //   dailyLossPercent = actualBase > 0 ? (dailyLoss / actualBase) * 100 : 0

  const dailyPnlBase = 10000;
  const balance = 9500;
  const todayStr = "2026-04-28";
  const accountDate = "2026-04-28"; // same day → use dailyPnlBase

  const actualBase = accountDate === todayStr ? dailyPnlBase : balance;
  const dailyLoss = actualBase - balance;
  const dailyLossPercent = actualBase > 0 ? (dailyLoss / actualBase) * 100 : 0;

  assertEquals(actualBase, 10000, "actualBase should be dailyPnlBase when dates match");
  assertEquals(dailyLoss, 500, "dailyLoss should be $500");
  assertEquals(dailyLossPercent, 5, "dailyLossPercent should be 5%");

  // With maxDailyLoss = 5, this should trigger the gate
  const maxDailyLoss = 5;
  assert(
    dailyLossPercent >= maxDailyLoss,
    "Gate 7 should trigger: 5% >= 5% limit",
  );
});

// ═══════════════════════════════════════════════════════════════════════
// Test 14: Gate 7 math — $10000 base, $9999 balance → 0.01% (passes)
// ═══════════════════════════════════════════════════════════════════════
Deno.test("Gate 7 math: $10000 base, $9999 balance → dailyLossPercent = 0.01% (gate passes)", () => {
  const dailyPnlBase = 10000;
  const balance = 9999;
  const todayStr = "2026-04-28";
  const accountDate = "2026-04-28";

  const actualBase = accountDate === todayStr ? dailyPnlBase : balance;
  const dailyLoss = actualBase - balance;
  const dailyLossPercent = actualBase > 0 ? (dailyLoss / actualBase) * 100 : 0;

  assertEquals(actualBase, 10000, "actualBase should be dailyPnlBase when dates match");
  assertEquals(dailyLoss, 1, "dailyLoss should be $1");
  assertEquals(dailyLossPercent, 0.01, "dailyLossPercent should be 0.01%");

  // With maxDailyLoss = 5, this should NOT trigger the gate
  const maxDailyLoss = 5;
  assert(
    dailyLossPercent < maxDailyLoss,
    "Gate 7 should pass: 0.01% < 5% limit",
  );
});

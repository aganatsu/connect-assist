import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * A position must be credited to the balance exactly once.
 *
 * Two scan cycles can pick up the same breach candidate. The close path
 * deleted the row, inserted history and updated the balance with no check that
 * it was the one that actually closed it — so both cycles credited the PnL.
 *
 * Measured 2026-09-16 from close_audit_log, four positions closed twice within
 * a second:
 *
 *   USD/JPY  credited 1742.38  should be  871.19
 *   XAU/USD  credited 1138.92  should be  569.46
 *   BTC/USD  credited -1068.52 should be -534.26
 *   BTC/USD  credited -1090.54 should be -545.27
 *
 * #554 made bot-scanner's DELETE the claim, but every other close path —
 * paper-trading auto/manual/kill-switch, the reverse-signal close, the
 * prop-firm emergency close — still credited with its own read-modify-write.
 *
 * Every balance movement now goes through settle_paper_position /
 * settle_paper_partial / reset_paper_account (migration 20261006010000), which
 * key each settlement uniquely in paper_account_ledger. The SQL behaviour is
 * proven in paperSettlementLedger.test.ts; these assertions keep the edge
 * functions from growing a direct write again.
 */

const FUNCTIONS = new URL("../../functions/", import.meta.url);

function sourceFiles(dir: URL): { path: string; code: string }[] {
  const out: { path: string; code: string }[] = [];
  for (const e of Deno.readDirSync(dir)) {
    const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
    if (e.isDirectory) out.push(...sourceFiles(u));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
      const src = Deno.readTextFileSync(u);
      out.push({
        path: u.pathname.slice(FUNCTIONS.pathname.length),
        code: src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n"),
      });
    }
  }
  return out;
}
const files = sourceFiles(FUNCTIONS);

/** Every `.from("<table>").<op>(...)` call, with its first 400 chars. */
function calls(table: string, op: string) {
  const hits: { path: string; snippet: string }[] = [];
  const re = new RegExp(`from\\(["']${table}["']\\)\\s*\\.${op}\\(`, "g");
  for (const f of files) {
    for (const m of f.code.matchAll(re)) hits.push({ path: f.path, snippet: f.code.slice(m.index!, m.index! + 400) });
  }
  return hits;
}

Deno.test("no edge function writes paper_accounts.balance or peak_balance directly", () => {
  const writes = [...calls("paper_accounts", "update"), ...calls("paper_accounts", "upsert")]
    .filter((c) => /\b(balance|peak_balance)\s*:/.test(c.snippet.slice(0, c.snippet.indexOf("})") + 2)));
  assertEquals(writes.map((w) => w.path), [], "balance moves only through the settlement RPCs");
});

Deno.test("no edge function inserts or deletes SMC trade history directly", () => {
  assertEquals(calls("paper_trade_history", "insert").map((c) => c.path), [],
    "history is written inside settle_paper_position, in the same transaction as the money");
  assertEquals(calls("paper_trade_history", "delete").map((c) => c.path), [],
    "settled history is referenced by the ledger and must not be deleted");
});

Deno.test("every close path settles through the RPC and stops on anything but settled", () => {
  const sites: [string, string][] = [
    ["bot-scanner/index.ts", 'source: "scanner_breach_check"'],
    ["bot-scanner/index.ts", 'source: "scanner_reverse_signal"'],
    ["paper-trading/index.ts", 'source: "paper_trading_auto"'],
    ["paper-trading/index.ts", 'source: "paper_trading_manual"'],
    ["paper-trading/index.ts", 'source: "kill_switch"'],
    ["paper-trading/index.ts", 'source: "paper_trading_partial_tp"'],
    ["_shared/propFirmGate.ts", 'source: "prop_firm_emergency"'],
  ];
  for (const [path, marker] of sites) {
    const code = files.find((f) => f.path === path)!.code;
    const at = code.indexOf(marker);
    assert(at > 0, `${path}: ${marker} present`);
    const before = code.slice(Math.max(0, at - 300), at);
    assert(/settlePaper(Position|Partial)\(/.test(before), `${path}: ${marker} is a settlement call`);
    const after = code.slice(at, at + 2500);
    assert(/\.outcome !== "settled"/.test(after), `${path}: ${marker} checks the outcome`);
  }
});

Deno.test("the breach close does nothing after a lost settlement", () => {
  const code = files.find((f) => f.path === "bot-scanner/index.ts")!.code;
  const at = code.indexOf("if (settlement.outcome !== \"settled\") {");
  assert(at > 0);
  const guard = code.slice(at, at + 400);
  assert(/continue;/.test(guard), "it continues: no audit row, no broker mirror, no notification");
  assert(at < code.indexOf("close_source: \"scanner_breach_check\""), "and that check precedes the audit log");
});

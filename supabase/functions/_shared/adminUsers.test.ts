import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildUserRows, isNewAccount, orphanAccounts, type ActivityFacts, type AuthUserFacts, type PaperAccountFacts } from "./adminUsers.ts";

const now = new Date("2026-10-30T12:00:00Z");
const user = (id: string, created: string): AuthUserFacts =>
  ({ id, email: `${id}@x.com`, created_at: created, last_sign_in_at: null, email_confirmed_at: created, provider: "email" });
const account = (id: string, user_id: string, is_running: boolean, is_paused = false): PaperAccountFacts =>
  ({ id, user_id, bot_id: "smc", balance: 10000, peak_balance: 10000, is_running, is_paused, execution_mode: "live", created_at: "2026-10-01T00:00:00Z" });

Deno.test("isNewAccount: inside vs outside 7 days", () => {
  assertEquals(isNewAccount("2026-10-27T00:00:00Z", now), true);
  assertEquals(isNewAccount("2026-10-20T00:00:00Z", now), false);
  assertEquals(isNewAccount("not a date", now), false);
});

Deno.test("buildUserRows: newest non-admin first, admin last, activity defaults to zero", () => {
  const users = [user("owner", "2026-04-15T00:00:00Z"), user("old", "2026-09-01T00:00:00Z"), user("new", "2026-10-29T00:00:00Z")];
  const act = new Map<string, ActivityFacts>([["new", { scans: 5, last_scan_at: "2026-10-30T11:00:00Z", closed_trades: 1, realized_pnl: 13.91, last_trade_at: null, open_positions: 1, backtests: 0, has_bot_config: false, broker_connections: 0, enabled_tasks: 8 }]]);
  const rows = buildUserRows(users, [account("a1", "new", true)], act, new Set(["owner"]), now);
  assertEquals(rows.map((r) => r.id), ["new", "old", "owner"]);
  assertEquals(rows[0].is_new, true);
  assertEquals(rows[0].scans, 5);
  assertEquals(rows[1].scans, 0);
  assertEquals(rows[2].is_admin, true);
});

Deno.test("buildUserRows: bot_running needs a running, unpaused account", () => {
  const users = [user("u", "2026-10-29T00:00:00Z")];
  assertEquals(buildUserRows(users, [account("a", "u", true)], new Map(), new Set(), now)[0].bot_running, true);
  assertEquals(buildUserRows(users, [account("a", "u", true, true)], new Map(), new Set(), now)[0].bot_running, false);
  assertEquals(buildUserRows(users, [account("a", "u", false)], new Map(), new Set(), now)[0].bot_running, false);
  assertEquals(buildUserRows(users, [], new Map(), new Set(), now)[0].bot_running, false);
});

Deno.test("orphanAccounts: accounts whose user is gone", () => {
  const users = [user("u", "2026-10-29T00:00:00Z")];
  assertEquals(orphanAccounts(users, [account("a", "u", false), account("b", "deleted", false)]).map((a) => a.id), ["b"]);
});

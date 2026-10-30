// Admin users overview — the pure part: turns raw per-user facts into the rows
// the Admin page shows. Kept free of Supabase calls so it can be unit-tested.

export interface AuthUserFacts {
  id: string;
  email: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  email_confirmed_at: string | null;
  provider: string | null;
}

export interface PaperAccountFacts {
  id: string;
  user_id: string;
  bot_id: string | null;
  balance: number | null;
  peak_balance: number | null;
  is_running: boolean | null;
  is_paused: boolean | null;
  execution_mode: string | null;
  created_at: string;
}

export interface ActivityFacts {
  scans: number;
  last_scan_at: string | null;
  closed_trades: number;
  realized_pnl: number;
  last_trade_at: string | null;
  open_positions: number;
  backtests: number;
  has_bot_config: boolean;
  broker_connections: number;
  enabled_tasks: number;
}

export interface AdminUserRow extends AuthUserFacts, ActivityFacts {
  is_admin: boolean;
  is_new: boolean;            // signed up in the last 7 days
  paper_accounts: PaperAccountFacts[];
  bot_running: boolean;       // any paper account running and not paused
}

const NEW_ACCOUNT_DAYS = 7;

export function isNewAccount(createdAt: string, now: Date): boolean {
  const t = Date.parse(createdAt);
  return Number.isFinite(t) && now.getTime() - t < NEW_ACCOUNT_DAYS * 86_400_000;
}

/** One row per auth user: newest sign-ups first, admins last (you already know about yourself). */
export function buildUserRows(
  users: AuthUserFacts[],
  accounts: PaperAccountFacts[],
  activity: Map<string, ActivityFacts>,
  adminIds: Set<string>,
  now: Date,
): AdminUserRow[] {
  const empty: ActivityFacts = {
    scans: 0, last_scan_at: null, closed_trades: 0, realized_pnl: 0, last_trade_at: null,
    open_positions: 0, backtests: 0, has_bot_config: false, broker_connections: 0, enabled_tasks: 0,
  };
  return users
    .map((u) => {
      const acc = accounts.filter((a) => a.user_id === u.id);
      return {
        ...u,
        ...(activity.get(u.id) ?? empty),
        is_admin: adminIds.has(u.id),
        is_new: isNewAccount(u.created_at, now),
        paper_accounts: acc,
        bot_running: acc.some((a) => a.is_running === true && a.is_paused !== true),
      };
    })
    .sort((a, b) => Number(a.is_admin) - Number(b.is_admin) || Date.parse(b.created_at) - Date.parse(a.created_at));
}

/** Paper accounts whose user no longer exists (e.g. a deleted sign-up whose ledger rows are append-only). */
export function orphanAccounts(users: AuthUserFacts[], accounts: PaperAccountFacts[]): PaperAccountFacts[] {
  const ids = new Set(users.map((u) => u.id));
  return accounts.filter((a) => !ids.has(a.user_id));
}

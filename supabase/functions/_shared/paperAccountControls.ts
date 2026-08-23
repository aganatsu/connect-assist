export type PaperAccountControlState = {
  id: string;
  is_running: boolean;
  is_paused: boolean;
  kill_switch_active: boolean;
  balance: string | number;
  peak_balance: string | number;
  daily_pnl_base: string | number;
  daily_pnl_base_date: string | null;
  scan_count: number;
  signal_count: number;
  rejected_count: number;
  execution_mode: "paper" | "live";
  started_at: string | null;
};

export class PaperAccountControlError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "PaperAccountControlError";
  }
}

const ACCOUNT_CONTROL_COLUMNS =
  "id, is_running, is_paused, kill_switch_active, balance, peak_balance, daily_pnl_base, daily_pnl_base_date, scan_count, signal_count, rejected_count, execution_mode, started_at";

function persistedValueMatches(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (
    (typeof actual === "number" || typeof actual === "string") &&
    (typeof expected === "number" || typeof expected === "string")
  ) {
    const actualNumber = Number(actual);
    const expectedNumber = Number(expected);
    return Number.isFinite(actualNumber) &&
      Number.isFinite(expectedNumber) &&
      actualNumber === expectedNumber;
  }
  return false;
}

function persistenceError(
  operation: string,
  error: { message?: string } | null | undefined,
): PaperAccountControlError {
  return new PaperAccountControlError(
    "account_control_write_failed",
    500,
    `${operation} failed: ${error?.message || "database error"}`,
  );
}

export async function ensurePaperAccount(
  supabase: any,
  userId: string,
): Promise<PaperAccountControlState> {
  const { data: existing, error: readError } = await supabase
    .from("paper_accounts")
    .select(ACCOUNT_CONTROL_COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();

  if (readError) {
    throw new PaperAccountControlError(
      "account_read_failed",
      500,
      `Could not read trading account: ${
        readError.message || "database error"
      }`,
    );
  }
  if (existing) return existing as PaperAccountControlState;

  const { data: created, error: insertError } = await supabase
    .from("paper_accounts")
    .insert({
      user_id: userId,
      balance: "10000",
      peak_balance: "10000",
      daily_pnl_base: "10000",
    })
    .select(ACCOUNT_CONTROL_COLUMNS)
    .maybeSingle();

  if (insertError) {
    if (insertError.code === "23505") {
      const { data: concurrentAccount, error: rereadError } = await supabase
        .from("paper_accounts")
        .select(ACCOUNT_CONTROL_COLUMNS)
        .eq("user_id", userId)
        .maybeSingle();
      if (rereadError) {
        throw new PaperAccountControlError(
          "account_read_failed",
          500,
          `Could not read concurrently created trading account: ${
            rereadError.message || "database error"
          }`,
        );
      }
      if (concurrentAccount) {
        return concurrentAccount as PaperAccountControlState;
      }
    }
    throw new PaperAccountControlError(
      "account_create_failed",
      500,
      `Could not create trading account: ${
        insertError.message || "database error"
      }`,
    );
  }
  if (!created) {
    throw new PaperAccountControlError(
      "account_create_not_persisted",
      500,
      "Trading account creation returned no saved account",
    );
  }
  return created as PaperAccountControlState;
}

export async function updatePaperAccountState(
  supabase: any,
  userId: string,
  patch: Record<string, unknown>,
  expected: Partial<PaperAccountControlState>,
  operation: string,
  requireKillSwitchInactive = false,
): Promise<PaperAccountControlState> {
  let query = supabase
    .from("paper_accounts")
    .update(patch)
    .eq("user_id", userId);
  if (requireKillSwitchInactive) {
    query = query.eq("kill_switch_active", false);
  }

  const { data: persisted, error } = await query
    .select(ACCOUNT_CONTROL_COLUMNS)
    .maybeSingle();
  if (error) throw persistenceError(operation, error);

  if (!persisted) {
    if (requireKillSwitchInactive) {
      const { data: current, error: readError } = await supabase
        .from("paper_accounts")
        .select(ACCOUNT_CONTROL_COLUMNS)
        .eq("user_id", userId)
        .maybeSingle();
      if (readError) {
        throw new PaperAccountControlError(
          "account_read_failed",
          500,
          `Could not verify trading account: ${
            readError.message || "database error"
          }`,
        );
      }
      if (current?.kill_switch_active === true) {
        throw new PaperAccountControlError(
          "kill_switch_active",
          409,
          "Release the kill switch before starting the trading engine",
        );
      }
    }
    throw new PaperAccountControlError(
      "account_missing",
      404,
      `${operation} did not affect a trading account`,
    );
  }

  for (const [key, value] of Object.entries(expected)) {
    if (!persistedValueMatches(persisted[key], value)) {
      throw new PaperAccountControlError(
        "account_control_verification_failed",
        409,
        `${operation} verification failed for ${key}`,
      );
    }
  }
  return persisted as PaperAccountControlState;
}

export async function startPaperEngine(
  supabase: any,
  userId: string,
  startedAt: string,
): Promise<PaperAccountControlState> {
  const account = await ensurePaperAccount(supabase, userId);
  if (account.kill_switch_active === true) {
    throw new PaperAccountControlError(
      "kill_switch_active",
      409,
      "Release the kill switch before starting the trading engine",
    );
  }
  return await updatePaperAccountState(
    supabase,
    userId,
    { is_running: true, is_paused: false, started_at: startedAt },
    { is_running: true, is_paused: false, kill_switch_active: false },
    "Starting trading engine",
    true,
  );
}

export async function pausePaperEngine(
  supabase: any,
  userId: string,
): Promise<PaperAccountControlState> {
  return await updatePaperAccountState(
    supabase,
    userId,
    { is_paused: true },
    { is_paused: true },
    "Pausing trading engine",
  );
}

export async function stopPaperEngine(
  supabase: any,
  userId: string,
): Promise<PaperAccountControlState> {
  return await updatePaperAccountState(
    supabase,
    userId,
    { is_running: false, is_paused: false },
    { is_running: false, is_paused: false },
    "Stopping trading engine",
  );
}

export function requireKillSwitchState(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new PaperAccountControlError(
      "invalid_kill_switch_state",
      400,
      "Kill switch active must be a boolean",
    );
  }
  return value;
}

export async function setPaperKillSwitch(
  supabase: any,
  userId: string,
  active: boolean,
): Promise<PaperAccountControlState> {
  return await updatePaperAccountState(
    supabase,
    userId,
    active
      ? { kill_switch_active: true, is_running: false, is_paused: false }
      : { kill_switch_active: false },
    active
      ? { kill_switch_active: true, is_running: false, is_paused: false }
      : { kill_switch_active: false },
    active ? "Arming kill switch" : "Releasing kill switch",
  );
}

import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ensurePaperAccount,
  PaperAccountControlError,
  pausePaperEngine,
  requireKillSwitchState,
  setPaperKillSwitch,
  startPaperEngine,
  stopPaperEngine,
  updatePaperAccountState,
} from "../../functions/_shared/paperAccountControls.ts";

type QueryResult = { data: any; error: any };
type MockCall = {
  table: string;
  method: "select" | "insert" | "update";
  payload?: any;
  columns?: string;
  filters: Array<[string, unknown]>;
};

function createMockSupabase(results: QueryResult[]) {
  const calls: MockCall[] = [];
  const remaining = [...results];

  function query(call: MockCall): any {
    calls.push(call);
    const chain: any = {
      eq(column: string, value: unknown) {
        call.filters.push([column, value]);
        return chain;
      },
      select(columns: string) {
        call.columns = columns;
        return chain;
      },
      maybeSingle() {
        const result = remaining.shift();
        if (!result) throw new Error(`No mock result for ${call.method}`);
        return Promise.resolve(result);
      },
    };
    return chain;
  }

  return {
    calls,
    supabase: {
      from(table: string) {
        return {
          select(columns: string) {
            return query({ table, method: "select", columns, filters: [] });
          },
          insert(payload: any) {
            return query({ table, method: "insert", payload, filters: [] });
          },
          update(payload: any) {
            return query({ table, method: "update", payload, filters: [] });
          },
        };
      },
    },
  };
}

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: "account-1",
    is_running: false,
    is_paused: false,
    kill_switch_active: false,
    ...overrides,
  };
}

async function expectControlError(
  fn: () => Promise<unknown>,
  code: string,
  status: number,
): Promise<void> {
  const error = await assertRejects(fn, PaperAccountControlError);
  assertEquals(error.code, code);
  assertEquals(error.status, status);
}

Deno.test("account controls: ensure surfaces a resolved PostgREST select error", async () => {
  const { supabase, calls } = createMockSupabase([
    { data: null, error: { message: "select denied" } },
  ]);

  await expectControlError(
    () => ensurePaperAccount(supabase, "user-1"),
    "account_read_failed",
    500,
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "select");
});

Deno.test("account controls: ensure surfaces a resolved PostgREST insert error", async () => {
  const { supabase, calls } = createMockSupabase([
    { data: null, error: null },
    { data: null, error: { message: "insert denied" } },
  ]);

  await expectControlError(
    () => ensurePaperAccount(supabase, "user-1"),
    "account_create_failed",
    500,
  );
  assertEquals(calls.map((call) => call.method), ["select", "insert"]);
  assert(calls[1].columns?.includes("kill_switch_active"));
});

Deno.test("account controls: a concurrent create conflict re-reads the saved account", async () => {
  const { supabase, calls } = createMockSupabase([
    { data: null, error: null },
    {
      data: null,
      error: { code: "23505", message: "duplicate key" },
    },
    { data: account(), error: null },
  ]);

  const persisted = await ensurePaperAccount(supabase, "user-1");
  assertEquals(persisted.id, "account-1");
  assertEquals(
    calls.map((call) => call.method),
    ["select", "insert", "select"],
  );
  assertEquals(calls.filter((call) => call.method === "update").length, 0);
});

Deno.test("account controls: numeric reset fields are persisted and verified", async () => {
  const persistedAccount = account({
    balance: 10000,
    peak_balance: 10000,
    daily_pnl_base: 10000,
    daily_pnl_base_date: "2026-08-23",
    scan_count: 0,
    signal_count: 0,
    rejected_count: 0,
  });
  const { supabase, calls } = createMockSupabase([
    { data: persistedAccount, error: null },
  ]);

  const persisted = await updatePaperAccountState(
    supabase,
    "user-1",
    {
      balance: "10000.00",
      peak_balance: "10000.00",
      daily_pnl_base: "10000.00",
      daily_pnl_base_date: "2026-08-23",
      scan_count: 0,
      signal_count: 0,
      rejected_count: 0,
    },
    {
      balance: "10000.00",
      peak_balance: "10000.00",
      daily_pnl_base: "10000.00",
      daily_pnl_base_date: "2026-08-23",
      scan_count: 0,
      signal_count: 0,
      rejected_count: 0,
    },
    "Resetting account balance",
  );

  assertEquals(Number(persisted.balance), 10000);
  assert(calls[0].columns?.includes("daily_pnl_base_date"));
  assertEquals(calls[0].payload.scan_count, 0);
});

Deno.test("account controls: an update error cannot report success", async () => {
  const { supabase } = createMockSupabase([
    { data: null, error: { message: "write denied" } },
  ]);

  await expectControlError(
    () => stopPaperEngine(supabase, "user-1"),
    "account_control_write_failed",
    500,
  );
});

Deno.test("account controls: a zero-row update reports the missing account", async () => {
  const { supabase, calls } = createMockSupabase([
    { data: null, error: null },
  ]);

  await expectControlError(
    () => pausePaperEngine(supabase, "missing-user"),
    "account_missing",
    404,
  );
  assert(calls[0].columns?.includes("is_paused"));
});

Deno.test("account controls: a zero-row kill-switch write cannot report success", async () => {
  const { supabase } = createMockSupabase([
    { data: null, error: null },
  ]);

  await expectControlError(
    () => setPaperKillSwitch(supabase, "missing-user", true),
    "account_missing",
    404,
  );
});

Deno.test("account controls: returned state must match the requested state", async () => {
  const { supabase } = createMockSupabase([
    { data: account({ is_running: true, is_paused: true }), error: null },
  ]);

  await expectControlError(
    () => stopPaperEngine(supabase, "user-1"),
    "account_control_verification_failed",
    409,
  );
});

Deno.test("account controls: malformed kill-switch active is rejected before a write", () => {
  for (const value of [undefined, null, 0, 1, "false", {}, []]) {
    const error = assertThrows(
      () => requireKillSwitchState(value),
      PaperAccountControlError,
    );
    assertEquals(error.code, "invalid_kill_switch_state");
    assertEquals(error.status, 400);
  }
  assertEquals(requireKillSwitchState(true), true);
  assertEquals(requireKillSwitchState(false), false);
});

Deno.test("account controls: start is blocked while the kill switch is armed", async () => {
  const { supabase, calls } = createMockSupabase([
    { data: account({ kill_switch_active: true }), error: null },
  ]);

  await expectControlError(
    () => startPaperEngine(supabase, "user-1", "2026-08-23T12:00:00.000Z"),
    "kill_switch_active",
    409,
  );
  assertEquals(
    calls.length,
    1,
    "start must not attempt an update while killed",
  );
  assertEquals(calls[0].method, "select");
});

Deno.test("account controls: start is conditionally persisted and verified", async () => {
  const { supabase, calls } = createMockSupabase([
    { data: account(), error: null },
    {
      data: account({ is_running: true, is_paused: false }),
      error: null,
    },
  ]);

  const persisted = await startPaperEngine(
    supabase,
    "user-1",
    "2026-08-23T12:00:00.000Z",
  );
  assertEquals(persisted.is_running, true);
  assertEquals(calls[1].filters, [
    ["user_id", "user-1"],
    ["kill_switch_active", false],
  ]);
});

Deno.test("account controls: kill-switch arm and release verify returned rows", async () => {
  const armedMock = createMockSupabase([
    {
      data: account({
        is_running: false,
        is_paused: false,
        kill_switch_active: true,
      }),
      error: null,
    },
  ]);
  const armed = await setPaperKillSwitch(armedMock.supabase, "user-1", true);
  assertEquals(armed.kill_switch_active, true);
  assertEquals(armedMock.calls[0].payload, {
    kill_switch_active: true,
    is_running: false,
    is_paused: false,
  });

  const releasedMock = createMockSupabase([
    { data: account({ kill_switch_active: false }), error: null },
  ]);
  const released = await setPaperKillSwitch(
    releasedMock.supabase,
    "user-1",
    false,
  );
  assertEquals(released.kill_switch_active, false);
});

Deno.test("paper-trading arms and verifies the kill switch before reporting success", async () => {
  const source = await Deno.readTextFile(
    new URL("../../functions/paper-trading/index.ts", import.meta.url).pathname,
  );
  const start = source.indexOf('if (action === "kill_switch")');
  const end = source.indexOf(
    "// Helper: read configured starting balance",
    start,
  );
  assert(start >= 0 && end > start, "kill-switch action block must exist");
  const block = source.slice(start, end);
  const arm = block.indexOf("setPaperKillSwitch(supabase, user.id, true)");
  const positionsRead = block.indexOf('.from("paper_positions")');
  assert(
    arm >= 0 && arm < positionsRead,
    "kill switch must persist before positions are read",
  );
  assert(
    block.includes("positionsReadError"),
    "positions read errors must be handled",
  );
  assert(
    block.includes("closeVerificationError"),
    "close-all must be verified with a final read",
  );
  assert(
    block.includes("kill_switch_close_incomplete"),
    "remaining positions must return a named failure",
  );
});

Deno.test("paper-trading reset routes use the verified account-state owner", async () => {
  const source = await Deno.readTextFile(
    new URL("../../functions/paper-trading/index.ts", import.meta.url).pathname,
  );
  const actions = ["set_balance", "reset_balance_only", "reset_account"];
  for (let index = 0; index < actions.length; index++) {
    const action = actions[index];
    const start = source.indexOf(`if (action === "${action}")`);
    const nextStart = index + 1 < actions.length
      ? source.indexOf(`if (action === "${actions[index + 1]}")`, start)
      : source.indexOf('if (action === "set_execution_mode")', start);
    assert(
      start >= 0 && nextStart > start,
      `${action} action block must exist`,
    );
    const block = source.slice(start, nextStart);
    assert(
      block.includes("updatePaperAccountState("),
      `${action} must use the verified account-state owner`,
    );
    assert(
      !block.includes('.from("paper_accounts").update('),
      `${action} must not write account state directly`,
    );
  }
});

Deno.test("BotView reports account-control mutation failures", async () => {
  const source = await Deno.readTextFile(
    new URL("../../../src/pages/BotView.tsx", import.meta.url).pathname,
  );
  const handlerCount = source.split("onError: accountControlError(").length - 1;
  assertEquals(handlerCount, 7);
  for (
    const fallback of [
      "Failed to start engine",
      "Failed to pause engine",
      "Failed to stop engine",
      "Failed to activate kill switch",
      "Failed to deactivate kill switch",
      "Failed to reset account",
      "Failed to reset balance",
    ]
  ) {
    assert(source.includes(`accountControlError("${fallback}")`));
  }
});

Deno.test("paper-trading routes account controls through verified helpers", async () => {
  const source = await Deno.readTextFile(
    new URL("../../functions/paper-trading/index.ts", import.meta.url).pathname,
  );
  for (
    const call of [
      "startPaperEngine(",
      "pausePaperEngine(",
      "stopPaperEngine(",
      "requireKillSwitchState(payload.active)",
      "setPaperKillSwitch(",
      "updatePaperAccountState(",
    ]
  ) {
    assert(source.includes(call), `paper-trading must call ${call}`);
  }
  assert(
    source.includes("error instanceof PaperAccountControlError"),
    "paper-trading must map typed control failures to HTTP errors",
  );
  assert(
    source.includes("success: false"),
    "paper-trading must not label control failures as successful",
  );
});

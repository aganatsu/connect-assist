import {
  claimScannerLock,
  publishCandleSourceAlerts,
  recordScannerAuthorizationFailure,
  releaseScannerLock,
  runTaskKey,
  type ScannerRuntimeRun,
  taskKey,
} from "../../functions/_shared/scannerRuntime.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("taskKey maps scheduled scan and management tasks to runtime operations", () => {
  assertEquals(taskKey("bot-scanner", "scan"), "bot-scanner:scan");
  assertEquals(taskKey("bot-scanner", "cron"), "bot-scanner:scan");
  assertEquals(taskKey("bot-scanner", "manage"), "bot-scanner:manage");
});

Deno.test("taskKey maps zone confirmation to its durable operation name", () => {
  assertEquals(
    taskKey("zone-confirmation-scanner", "scan"),
    "zone-confirmation-scanner:zone_confirmation",
  );
});

Deno.test("runTaskKey matches the scheduled task key", () => {
  const run = {
    function_name: "bot-scanner",
    operation: "scan",
  } as ScannerRuntimeRun;
  assertEquals(runTaskKey(run), taskKey("bot-scanner", "scan"));
});

Deno.test("claimScannerLock scopes the lease by user, bot, and run", async () => {
  let rpcName = "";
  let rpcArgs: Record<string, unknown> = {};
  const supabase = {
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcName = name;
      rpcArgs = args;
      return Promise.resolve({ data: true, error: null });
    },
  };

  const result = await claimScannerLock(supabase, {
    userId: "11111111-1111-1111-1111-111111111111",
    botId: "smc",
    runId: "22222222-2222-2222-2222-222222222222",
  });

  assertEquals(rpcName, "claim_scanner_runtime_lock");
  assertEquals(rpcArgs.p_user_id, "11111111-1111-1111-1111-111111111111");
  assertEquals(rpcArgs.p_bot_id, "smc");
  assertEquals(rpcArgs.p_lock_scope, "full_scan");
  assertEquals(rpcArgs.p_run_id, "22222222-2222-2222-2222-222222222222");
  assertEquals(result.acquired, true);
});

Deno.test("releaseScannerLock only releases the caller's lease token", async () => {
  let rpcArgs: Record<string, unknown> = {};
  const supabase = {
    rpc: (_name: string, args: Record<string, unknown>) => {
      rpcArgs = args;
      return Promise.resolve({ data: true, error: null });
    },
  };

  const released = await releaseScannerLock(supabase, {
    userId: "11111111-1111-1111-1111-111111111111",
    botId: "smc",
    token: "33333333-3333-3333-3333-333333333333",
  });

  assertEquals(rpcArgs.p_user_id, "11111111-1111-1111-1111-111111111111");
  assertEquals(rpcArgs.p_bot_id, "smc");
  assertEquals(rpcArgs.p_lease_token, "33333333-3333-3333-3333-333333333333");
  assertEquals(released, true);
});

Deno.test("bot scanner no longer force-clears a valid manual scan lock", async () => {
  const source = await Deno.readTextFile(
    new URL("../bot-scanner/index.ts", import.meta.url),
  );
  assertEquals(source.includes(".update({ scan_lock_until: null })"), false);
  assertEquals(source.includes("claimScannerLock"), true);
  assertEquals(source.includes("releaseScannerLock"), true);
});

Deno.test("candle exhaustion creates one durable critical alert", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const supabase = {
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return Promise.resolve({ data: crypto.randomUUID(), error: null });
    },
  };

  await publishCandleSourceAlerts(supabase, {
    userId: "11111111-1111-1111-1111-111111111111",
    botId: "smc",
    runId: "22222222-2222-2222-2222-222222222222",
    metaapiAttempted: false,
    issues: [{
      code: "candle_source_exhaustion",
      provider: "all",
      symbol: "GBP/USD",
      interval: "1d",
      message: "All candle sources failed",
    }],
  });

  assertEquals(calls.length, 1);
  assertEquals(calls[0].name, "upsert_scanner_operational_alert");
  assertEquals(calls[0].args.p_alert_type, "candle_source_exhaustion");
  assertEquals(calls[0].args.p_dedupe_key, "all_sources");
  assertEquals(calls[0].args.p_severity, "critical");
});

Deno.test("healthy evaluated candle sources resolve prior alerts", async () => {
  const calls: string[] = [];
  const supabase = {
    rpc: (name: string, _args: Record<string, unknown>) => {
      calls.push(name);
      return Promise.resolve({ data: 1, error: null });
    },
  };

  await publishCandleSourceAlerts(supabase, {
    userId: "11111111-1111-1111-1111-111111111111",
    botId: "smc",
    metaapiAttempted: true,
    issues: [],
  });

  assertEquals(calls.length, 3);
  assertEquals(
    calls.every((name) => name === "resolve_scanner_operational_alert"),
    true,
  );
});

Deno.test("authorization failures persist sanitized request metadata", async () => {
  let tableName = "";
  let inserted: Record<string, unknown> = {};
  const supabase = {
    from: (name: string) => {
      tableName = name;
      return {
        insert: (value: Record<string, unknown>) => {
          inserted = value;
          return Promise.resolve({ error: null });
        },
      };
    },
  };

  await recordScannerAuthorizationFailure(
    supabase,
    "bot-scanner",
    "Missing or invalid cron authorization",
    { has_cron_header: true, has_authorization: true },
  );

  assertEquals(tableName, "scanner_authorization_failures");
  assertEquals(inserted.function_name, "bot-scanner");
  assertEquals(
    JSON.stringify(inserted).includes("Bearer "),
    false,
  );
});

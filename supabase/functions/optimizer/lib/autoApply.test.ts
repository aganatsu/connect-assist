/**
 * autoApply.test.ts — Gate 0: Live-account hard block
 *
 * Tests that autoApplyResult() refuses to apply optimized configs when
 * ANY account for the user is in live mode, regardless of how good
 * the optimization result is.
 *
 * Also verifies:
 * - Paper-only users can still auto-apply (Gate 0 passes through)
 * - Mixed (paper + live) accounts are still blocked
 * - Gate 0 runs BEFORE walk-forward/improvement gates (order proof)
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { autoApplyResult, type ApplyConfig, type ApplyResult } from "./autoApply.ts";
import type { OptimizationResult, TrialResult } from "./optimizationLoop.ts";

// ─── Test Fixtures ──────────────────────────────────────────────────────────

/** A "perfect" optimization result that would pass all other gates */
function makeRobustResult(improvementPercent = 25): OptimizationResult {
  const bestTrial: TrialResult = {
    trial: { id: 1, params: { minConfluence: 5, riskPerTrade: 0.01, fw_trend: 3 }, score: 10, timestamp: Date.now() },
    backtest: {
      totalTrades: 120,
      winRate: 0.62,
      profitFactor: 1.8,
      expectancy: 3.5,
      maxDrawdownPercent: 8.2,
      netPnlPips: 420,
      walkForward: {
        consistencyScore: 0.85,
        verdict: "robust",
        foldCount: 5,
        winRateStdDev: 0.04,
        pnlStdDev: 12,
      },
    },
    compositeScore: 10,
    violations: [],
    walkForwardPassed: true,
  };

  return {
    trials: [bestTrial],
    bestTrial,
    baseline: { ...bestTrial, compositeScore: 8 },
    autoApplied: true,
    improvementPercent,
    durationMs: 60000,
  };
}

/** Current config that would pass validation (has required fields) */
const VALID_CURRENT_CONFIG = {
  config_json: {
    factorWeights: { trend: 3, structure: 2 },
    minConfluence: 4,
    riskPerTrade: 0.01,
  },
};

const BASE_APPLY_CONFIG: ApplyConfig = {
  supabaseUrl: "http://mock-supabase.test",
  supabaseKey: "mock-key",
  userId: "user-123",
  configId: "config-456",
  telegramChatIds: ["chat-789"], // Skip real Telegram lookup
};

// ─── Mock fetch infrastructure ──────────────────────────────────────────────

type MockRoute = {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => Response;
};

let mockRoutes: MockRoute[] = [];
let fetchCalls: { url: string; init?: RequestInit }[] = [];

function installMockFetch() {
  fetchCalls = [];
  // @ts-ignore — overriding global fetch for testing
  globalThis.fetch = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    fetchCalls.push({ url: urlStr, init });
    for (const route of mockRoutes) {
      if (route.match(urlStr, init)) {
        return Promise.resolve(route.respond(urlStr, init));
      }
    }
    // Default: 404 for unmatched routes
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  };
}

function mockPaperAccounts(accounts: { execution_mode: string }[]) {
  mockRoutes.push({
    match: (url) => url.includes("/rest/v1/paper_accounts"),
    respond: () => new Response(JSON.stringify(accounts), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  });
}

function mockPaperAccountsError(status = 500) {
  mockRoutes.push({
    match: (url) => url.includes("/rest/v1/paper_accounts"),
    respond: () => new Response("Internal Server Error", { status }),
  });
}

function mockConfigBackup() {
  mockRoutes.push({
    match: (url, init) => url.includes("/rest/v1/config_backups") && init?.method === "POST",
    respond: () => new Response("", { status: 201 }),
  });
}

function mockConfigWrite() {
  mockRoutes.push({
    match: (url, init) => url.includes("/rest/v1/bot_configs") && init?.method === "PATCH",
    respond: () => new Response(null, { status: 204 }),
  });
}

function mockTelegramNotify() {
  mockRoutes.push({
    match: (url) => url.includes("/functions/v1/telegram-notify"),
    respond: () => new Response("", { status: 200 }),
  });
}

function resetMocks() {
  mockRoutes = [];
  fetchCalls = [];
}

/** Check if any fetch call wrote to bot_configs */
function didWriteConfig(): boolean {
  return fetchCalls.some(c => c.url.includes("/rest/v1/bot_configs") && c.init?.method === "PATCH");
}

/** Check if the paper_accounts check happened before any config write */
function gate0RanBeforeConfigWrite(): boolean {
  const liveCheckIdx = fetchCalls.findIndex(c => c.url.includes("/rest/v1/paper_accounts"));
  const configWriteIdx = fetchCalls.findIndex(c => c.url.includes("/rest/v1/bot_configs") && c.init?.method === "PATCH");
  if (liveCheckIdx === -1) return false; // Gate 0 didn't run
  if (configWriteIdx === -1) return true; // Gate 0 ran, no config write (blocked)
  return liveCheckIdx < configWriteIdx;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

Deno.test("Gate 0: blocks auto-apply when user has a live account", async () => {
  resetMocks();
  installMockFetch();
  mockPaperAccounts([{ execution_mode: "live" }]);
  mockTelegramNotify();

  const result = await autoApplyResult(makeRobustResult(), VALID_CURRENT_CONFIG, BASE_APPLY_CONFIG);

  assertEquals(result.applied, false);
  assertStringIncludes(result.reason, "live-mode account");
  assertStringIncludes(result.reason, "manual review");
  assertEquals(didWriteConfig(), false, "Must NOT write to bot_configs when live account exists");
});

Deno.test("Gate 0: allows auto-apply when user has only paper accounts", async () => {
  resetMocks();
  installMockFetch();
  mockPaperAccounts([{ execution_mode: "paper" }, { execution_mode: "paper" }]);
  mockTelegramNotify();
  mockConfigBackup();
  mockConfigWrite();

  const result = await autoApplyResult(makeRobustResult(), VALID_CURRENT_CONFIG, BASE_APPLY_CONFIG);

  assertEquals(result.applied, true);
  assertStringIncludes(result.reason, "Applied");
  assertEquals(didWriteConfig(), true, "Should write config for paper-only user");
});

Deno.test("Gate 0: blocks when user has BOTH paper AND live accounts", async () => {
  resetMocks();
  installMockFetch();
  mockPaperAccounts([{ execution_mode: "paper" }, { execution_mode: "live" }]);
  mockTelegramNotify();

  const result = await autoApplyResult(makeRobustResult(), VALID_CURRENT_CONFIG, BASE_APPLY_CONFIG);

  assertEquals(result.applied, false);
  assertStringIncludes(result.reason, "live-mode account");
  assertEquals(didWriteConfig(), false, "Must NOT write when ANY account is live");
});

Deno.test("Gate 0: runs BEFORE walk-forward/improvement gates (order proof)", async () => {
  resetMocks();
  installMockFetch();
  // User has live account — Gate 0 should block
  mockPaperAccounts([{ execution_mode: "live" }]);
  mockTelegramNotify();

  // Even with a terrible result (would fail Gate 1/2 anyway), Gate 0 blocks first
  const badResult = makeRobustResult();
  badResult.autoApplied = false; // Would trigger Gate 1
  badResult.rejectReason = "Improvement too low";

  const result = await autoApplyResult(badResult, VALID_CURRENT_CONFIG, BASE_APPLY_CONFIG);

  assertEquals(result.applied, false);
  // The reason should be the Gate 0 reason, NOT the Gate 1 reason
  assertStringIncludes(result.reason, "live-mode account");
  assertEquals(result.reason.includes("Improvement too low"), false,
    "Gate 0 must block BEFORE Gate 1 runs — reason should be about live account, not improvement");
  assertEquals(gate0RanBeforeConfigWrite(), true, "Gate 0 fetch must precede any config write");
});

Deno.test("Gate 0: blocks live account even with excellent 50% improvement", async () => {
  resetMocks();
  installMockFetch();
  mockPaperAccounts([{ execution_mode: "live" }]);
  mockTelegramNotify();

  // 50% improvement, robust walk-forward — still blocked
  const result = await autoApplyResult(makeRobustResult(50), VALID_CURRENT_CONFIG, BASE_APPLY_CONFIG);

  assertEquals(result.applied, false);
  assertStringIncludes(result.reason, "live-mode account");
  assertEquals(didWriteConfig(), false);
});

Deno.test("Gate 0: fail-closed when paper_accounts query errors", async () => {
  resetMocks();
  installMockFetch();
  mockPaperAccountsError(500); // Simulate DB error
  mockTelegramNotify();

  const result = await autoApplyResult(makeRobustResult(), VALID_CURRENT_CONFIG, BASE_APPLY_CONFIG);

  assertEquals(result.applied, false);
  assertStringIncludes(result.reason, "unable to verify");
  assertStringIncludes(result.reason, "fail-closed");
  assertEquals(didWriteConfig(), false, "Must NOT write when account status is unknown");
});

Deno.test("Gate 0: sends notification when blocking live account", async () => {
  resetMocks();
  installMockFetch();
  mockPaperAccounts([{ execution_mode: "live" }]);
  mockTelegramNotify();

  await autoApplyResult(makeRobustResult(), VALID_CURRENT_CONFIG, BASE_APPLY_CONFIG);

  const notifyCalls = fetchCalls.filter(c => c.url.includes("/functions/v1/telegram-notify"));
  assertEquals(notifyCalls.length > 0, true, "Should send Telegram notification when blocking");
});

Deno.test("Gate 0: SDK client sends Authorization Bearer header (RLS bypass proof)", async () => {
  // This test proves the FIX for the original bug: raw fetch() only sent
  // 'apikey' header without 'Authorization', causing PostgREST to resolve
  // as anon role (RLS-restricted, zero rows returned for all users).
  // The SDK client sends BOTH 'apikey' AND 'Authorization: Bearer <key>',
  // which PostgREST needs to recognize the service_role and bypass RLS.
  resetMocks();
  installMockFetch();
  mockPaperAccounts([{ execution_mode: "paper" }]);
  mockTelegramNotify();
  mockConfigBackup();
  mockConfigWrite();

  await autoApplyResult(makeRobustResult(), VALID_CURRENT_CONFIG, BASE_APPLY_CONFIG);

  // Find the paper_accounts request
  const gate0Call = fetchCalls.find(c => c.url.includes("/rest/v1/paper_accounts"));
  assertEquals(gate0Call !== undefined, true, "Gate 0 must query paper_accounts");

  // The SDK client sets Authorization header with the service role key.
  // The SDK uses a Headers instance (not a plain object), so we extract it properly.
  const rawHeaders = gate0Call!.init?.headers;
  let authHeader = "";
  if (rawHeaders instanceof Headers) {
    authHeader = rawHeaders.get("authorization") || rawHeaders.get("Authorization") || "";
  } else if (rawHeaders && typeof rawHeaders === "object") {
    const h = rawHeaders as Record<string, string>;
    authHeader = h["Authorization"] || h["authorization"] || "";
  }
  assertStringIncludes(authHeader, "Bearer ",
    "SDK client must send Authorization: Bearer <key> for RLS bypass. " +
    "Without this, PostgREST resolves as anon and RLS policy " +
    "(auth.uid() = user_id) returns zero rows for every user.");
  assertStringIncludes(authHeader, BASE_APPLY_CONFIG.supabaseKey,
    "Authorization header must contain the service role key");
});

Deno.test("Gate 0: SDK query includes correct user_id filter", async () => {
  // Proves the query filters by user_id (not fetching all accounts globally)
  resetMocks();
  installMockFetch();
  mockPaperAccounts([{ execution_mode: "paper" }]);
  mockTelegramNotify();
  mockConfigBackup();
  mockConfigWrite();

  await autoApplyResult(makeRobustResult(), VALID_CURRENT_CONFIG, BASE_APPLY_CONFIG);

  const gate0Call = fetchCalls.find(c => c.url.includes("/rest/v1/paper_accounts"));
  assertEquals(gate0Call !== undefined, true);
  // URL must contain user_id filter
  assertStringIncludes(gate0Call!.url, `user_id=eq.${BASE_APPLY_CONFIG.userId}`,
    "Query must filter by the specific user's ID");
  // URL must select execution_mode
  assertStringIncludes(gate0Call!.url, "select=execution_mode",
    "Query must select execution_mode column");
});

// ─── Integration test (requires real credentials) ───────────────────────────
// Run with: SUPABASE_URL=https://... SUPABASE_SERVICE_ROLE_KEY=eyJ... deno test --allow-env --allow-net --allow-read this_file.ts
// This test is skipped when credentials aren't available (CI/sandbox).

const HAS_REAL_CREDENTIALS = !!Deno.env.get("SUPABASE_URL") && !!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

Deno.test({
  name: "Gate 0 INTEGRATION: real SDK query returns paper_accounts rows",
  ignore: !HAS_REAL_CREDENTIALS,
  async fn() {
    // This test uses the REAL Supabase project to confirm:
    // 1. The table exists and is queryable with service role
    // 2. The SDK client bypasses RLS (returns rows without user auth context)
    // 3. execution_mode field is present in the response
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.103.2");
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const client = createClient(url, key);
    const { data, error } = await client
      .from("paper_accounts")
      .select("execution_mode")
      .limit(10);

    assertEquals(error, null, `Query must not error: ${error?.message}`);
    assertEquals(Array.isArray(data), true, "Must return an array");
    // Every row must have execution_mode field
    for (const row of data!) {
      assertEquals(typeof row.execution_mode, "string",
        "execution_mode must be a string (paper|live)");
      assertEquals(
        ["paper", "live"].includes(row.execution_mode), true,
        `execution_mode must be 'paper' or 'live', got: ${row.execution_mode}`,
      );
    }
    console.log(`  ✓ Real query returned ${data!.length} rows from paper_accounts`);
    console.log(`  ✓ Modes found: ${[...new Set(data!.map(r => r.execution_mode))].join(", ")}`);
  },
});

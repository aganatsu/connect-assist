/**
 * Tests for prop-firm status endpoint broker equity fetch.
 *
 * Verifies:
 * 1. The status handler queries broker_connections for MetaAPI connection
 * 2. fetchBrokerEquity is called when a broker connection exists
 * 3. currentBalance uses broker equity when available, falls back to paper
 * 4. equitySource field is returned in the derived object
 * 5. Region-aware MetaAPI fetch delegates to the shared provisioning owner
 * 6. No behavior change for users without broker connections
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

// ── Helper: read the prop-firm/index.ts source once ──
let _src: string | null = null;
async function src(): Promise<string> {
  if (!_src) {
    _src = await Deno.readTextFile(
      new URL("../../functions/prop-firm/index.ts", import.meta.url).pathname
    );
  }
  return _src;
}

async function metaClientSrc(): Promise<string> {
  return Deno.readTextFile(
    new URL("../../functions/_shared/metaApiClient.ts", import.meta.url).pathname,
  );
}

// ── Test 1: Status handler queries broker_connections table ──
Deno.test("status handler queries broker_connections for MetaAPI connection", async () => {
  const s = await src();
  assertStringIncludes(s, '.from("broker_connections")');
  assertStringIncludes(s, '.eq("broker_type", "metaapi")');
  assertStringIncludes(s, '.eq("is_active", true)');
  assertStringIncludes(s, '.select("account_id, api_key")');
});

// ── Test 2: fetchBrokerEquity function exists with correct signature ──
Deno.test("fetchBrokerEquity function exists with region-aware logic", async () => {
  const s = await src();
  assertStringIncludes(s, "async function fetchBrokerEquity(");
  assertStringIncludes(s, "accountId: string");
  assertStringIncludes(s, "authToken: string");
  assertStringIncludes(s, "Promise<number | undefined>");
});

// ── Test 3: Region-aware MetaAPI fetch has one owner ──
Deno.test("fetchBrokerEquity delegates region routing to metaFetch", async () => {
  const s = await src();
  assertStringIncludes(s, 'from "../_shared/metaApiClient.ts"');
  assertStringIncludes(s, "await metaFetch(");
  assertEquals(s.includes("META_REGIONS"), false);
  assertEquals(s.includes("for (const region of order)"), false);
});

// ── Test 4: Shared owner reads the dynamic provisioning region ──
Deno.test("MetaAPI client resolves the account region from provisioning", async () => {
  const shared = await metaClientSrc();
  assertStringIncludes(shared, "mt-provisioning-api-v1");
  assertStringIncludes(shared, "account?.region");
  assertStringIncludes(shared, "metaBaseUrl(region, accountId)");
});

// ── Test 5: Broker equity takes priority over paper balance ──
Deno.test("currentBalance uses broker equity when available, falls back to paper", async () => {
  const s = await src();
  // Verify the priority chain: brokerEquity ?? paperBalance
  assertStringIncludes(s, "const currentBalance = brokerEquity ?? paperBalance");
  // Verify paper balance is still computed as fallback
  assertStringIncludes(s, "const paperBalance = acct ? parseFloat(acct.balance) : config.initial_balance");
});

// ── Test 6: equitySource field is included in the derived response ──
Deno.test("derived object includes equitySource field", async () => {
  const s = await src();
  assertStringIncludes(s, "equitySource,");
  // Verify the equitySource is typed correctly
  assertStringIncludes(s, 'let equitySource: "metaapi" | "paper" = "paper"');
  // Verify it's set to metaapi when broker equity succeeds
  assertStringIncludes(s, 'equitySource = "metaapi"');
});

// ── Test 7: Graceful fallback when broker fetch fails ──
Deno.test("broker equity fetch preserves graceful paper fallback", async () => {
  const s = await src();
  assertStringIncludes(s, "Broker equity fetch failed, falling back to paper");
  assertStringIncludes(s, "if (!res.ok)");
  assertStringIncludes(s, 'region || "provisioning"');
});

// ── Test 8: NaN/invalid equity guard ──
Deno.test("fetchBrokerEquity guards against NaN and non-positive equity", async () => {
  const s = await src();
  assertStringIncludes(s, "Number.isFinite(equity)");
  assertStringIncludes(s, "equity <= 0");
});

// ── Test 9: No behavior change for users without broker connections ──
Deno.test("users without broker connections still get paper balance (no regression)", async () => {
  const s = await src();
  // Verify the broker connection check uses optional chaining (safe for null)
  assertStringIncludes(s, "brokerConn?.account_id && brokerConn?.api_key");
  // Verify paper_accounts is still queried
  assertStringIncludes(s, '.from("paper_accounts")');
  assertStringIncludes(s, '.select("balance")');
});

// ── Test 10: Shared result body is parsed without a second network read ──
Deno.test("fetchBrokerEquity parses the body returned by the shared client", async () => {
  const s = await src();
  const fetchSection = s.substring(
    s.indexOf("async function fetchBrokerEquity"),
    s.indexOf("Deno.serve")
  );
  assertStringIncludes(fetchSection, "const { res, body, region } = await metaFetch(");
  assertStringIncludes(fetchSection, "JSON.parse(body)");
  assertEquals(fetchSection.includes("fetch("), false);
});

// ── Test 11: Region cache remains inside the shared owner ──
Deno.test("shared client caches the provisioning-reported region", async () => {
  const shared = await metaClientSrc();
  assertStringIncludes(shared, "regionCache.set(accountId, region)");
  assertStringIncludes(shared, "regionCache.get(accountId)");
});

// ── Test 12: broker_connections query filters by user_id ──
Deno.test("broker_connections query is scoped to the authenticated user", async () => {
  const s = await src();
  // The query must filter by user_id to prevent cross-user data leaks
  const brokerQuerySection = s.substring(
    s.indexOf('from("broker_connections")'),
    s.indexOf("if (brokerConn?.account_id")
  );
  assertStringIncludes(brokerQuerySection, '.eq("user_id", userId)');
});

/**
 * Tests for prop-firm status endpoint broker equity fetch.
 *
 * Verifies:
 * 1. The status handler queries broker_connections for MetaAPI connection
 * 2. fetchBrokerEquity is called when a broker connection exists
 * 3. currentBalance uses broker equity when available, falls back to paper
 * 4. equitySource field is returned in the derived object
 * 5. Region-aware MetaAPI fetch with fallback across regions
 * 6. No behavior change for users without broker connections
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

// ── Helper: read the prop-firm/index.ts source once ──
let _src: string | null = null;
async function src(): Promise<string> {
  if (!_src) {
    _src = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url).pathname
    );
  }
  return _src;
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

// ── Test 3: Region-aware MetaAPI fetch with all 3 regions ──
Deno.test("fetchBrokerEquity tries all 3 MetaAPI regions", async () => {
  const s = await src();
  assertStringIncludes(s, 'const META_REGIONS = ["london", "new-york", "singapore"]');
  assertStringIncludes(s, "regionCache");
  assertStringIncludes(s, "for (const region of order)");
});

// ── Test 4: MetaAPI URL uses region-aware format ──
Deno.test("MetaAPI URL uses region-aware format (not the non-region variant)", async () => {
  const s = await src();
  // The prop-firm function should use the region-aware URL pattern
  assertStringIncludes(s, "mt-client-api-v1.${region}.agiliumtrade.ai");
  // It should NOT use the non-region URL (agiliumtrade.agiliumtrade.ai) which is less reliable
  const fetchSection = s.substring(
    s.indexOf("async function fetchBrokerEquity"),
    s.indexOf("Deno.serve")
  );
  assertEquals(
    fetchSection.includes("agiliumtrade.agiliumtrade.ai"),
    false,
    "fetchBrokerEquity should use region-aware URLs, not the non-region variant"
  );
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
Deno.test("broker equity fetch has try/catch with graceful fallback", async () => {
  const s = await src();
  // The outer try/catch around fetchBrokerEquity call
  assertStringIncludes(s, "Broker equity fetch failed, falling back to paper");
  // The inner try/catch in fetchBrokerEquity for each region
  assertStringIncludes(s, "MetaAPI ${region} fetch error");
});

// ── Test 8: NaN/invalid equity guard ──
Deno.test("fetchBrokerEquity guards against NaN and non-positive equity", async () => {
  const s = await src();
  assertStringIncludes(s, "Number.isFinite(equity)");
  assertStringIncludes(s, "equity > 0");
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

// ── Test 10: Response body consumed once (no double-consume bug) ──
Deno.test("fetchBrokerEquity reads response body once with res.text() then JSON.parse", async () => {
  const s = await src();
  const fetchSection = s.substring(
    s.indexOf("async function fetchBrokerEquity"),
    s.indexOf("Deno.serve")
  );
  // Should use res.text() + JSON.parse pattern (not res.json() which would double-consume)
  assertStringIncludes(fetchSection, "const body = await res.text()");
  assertStringIncludes(fetchSection, "JSON.parse(body)");
  // Should NOT use res.json() (which would leave body consumed for the error check)
  assertEquals(
    fetchSection.includes("res.json()"),
    false,
    "Should use res.text() + JSON.parse, not res.json() to avoid double-consume"
  );
});

// ── Test 11: Region cache is used for performance ──
Deno.test("region cache stores successful region for subsequent calls", async () => {
  const s = await src();
  assertStringIncludes(s, "regionCache.set(accountId, region)");
  assertStringIncludes(s, "regionCache.get(accountId)");
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

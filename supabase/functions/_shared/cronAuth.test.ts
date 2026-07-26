/**
 * Tests for cronAuth.ts — caller verification for edge functions.
 *
 * Tests both:
 * 1. verifyCronCaller (cron-only functions)
 * 2. verifyCronOrUserCaller (dual-path functions)
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { verifyCronCaller, verifyCronOrUserCaller } from "./cronAuth.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/functions/v1/test", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({}),
  });
}

function withCronSecret(secret: string): Record<string, string> {
  return { "x-cron-secret": secret };
}

function withUserJWT(token: string): Record<string, string> {
  return { "Authorization": `Bearer ${token}` };
}

// ─── Setup/Teardown ───────────────────────────────────────────────────────────

const REAL_SECRET = "test-cron-secret-abc123-very-long-random-value";
const WRONG_SECRET = "wrong-secret-xyz";
const USER_JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEyMyIsInJvbGUiOiJhdXRoZW50aWNhdGVkIn0.fake";
const SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.fake-service-key";

function setupEnv() {
  Deno.env.set("CRON_SECRET", REAL_SECRET);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
}

function teardownEnv() {
  Deno.env.delete("CRON_SECRET");
  Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
}

// ═══════════════════════════════════════════════════════════════════════════════
// verifyCronCaller tests (cron-only functions)
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("verifyCronCaller: returns null (authorized) with correct secret", () => {
  setupEnv();
  try {
    const result = verifyCronCaller(makeRequest(withCronSecret(REAL_SECRET)));
    assertEquals(result, null, "Should return null when secret matches");
  } finally {
    teardownEnv();
  }
});

Deno.test("verifyCronCaller: returns 401 with no header", async () => {
  setupEnv();
  try {
    const result = verifyCronCaller(makeRequest());
    assertEquals(result instanceof Response, true);
    assertEquals(result!.status, 401);
    const body = await result!.json();
    assertEquals(body.error, "Unauthorized");
    assertStringIncludes(body.reason, "Invalid or missing x-cron-secret");
  } finally {
    teardownEnv();
  }
});

Deno.test("verifyCronCaller: returns 401 with wrong secret", async () => {
  setupEnv();
  try {
    const result = verifyCronCaller(makeRequest(withCronSecret(WRONG_SECRET)));
    assertEquals(result instanceof Response, true);
    assertEquals(result!.status, 401);
    const body = await result!.json();
    assertEquals(body.error, "Unauthorized");
  } finally {
    teardownEnv();
  }
});

Deno.test("verifyCronCaller: returns 401 with user JWT (cron-only rejects user path)", async () => {
  setupEnv();
  try {
    // Even a valid user JWT should be rejected by the cron-only guard
    const result = verifyCronCaller(makeRequest(withUserJWT(USER_JWT)));
    assertEquals(result instanceof Response, true);
    assertEquals(result!.status, 401);
  } finally {
    teardownEnv();
  }
});

Deno.test("verifyCronCaller: fail-closed when CRON_SECRET not configured", async () => {
  // Don't set CRON_SECRET at all
  Deno.env.delete("CRON_SECRET");
  try {
    const result = verifyCronCaller(makeRequest(withCronSecret("anything")));
    assertEquals(result instanceof Response, true);
    assertEquals(result!.status, 401);
    const body = await result!.json();
    assertStringIncludes(body.reason, "CRON_SECRET not configured");
  } finally {
    teardownEnv();
  }
});

Deno.test("verifyCronCaller: returns 401 with empty string secret", async () => {
  setupEnv();
  try {
    const result = verifyCronCaller(makeRequest(withCronSecret("")));
    assertEquals(result instanceof Response, true);
    assertEquals(result!.status, 401);
  } finally {
    teardownEnv();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// verifyCronOrUserCaller tests (dual-path functions)
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("verifyCronOrUserCaller: authorized via cron-secret path", () => {
  setupEnv();
  try {
    const result = verifyCronOrUserCaller(makeRequest(withCronSecret(REAL_SECRET)));
    assertEquals(result, null, "Should return null when cron secret matches");
  } finally {
    teardownEnv();
  }
});

Deno.test("verifyCronOrUserCaller: authorized via user JWT path", () => {
  setupEnv();
  try {
    const result = verifyCronOrUserCaller(makeRequest(withUserJWT(USER_JWT)));
    assertEquals(result, null, "Should return null for valid user JWT");
  } finally {
    teardownEnv();
  }
});

Deno.test("verifyCronOrUserCaller: rejects service role key on user path", async () => {
  setupEnv();
  try {
    // The service role key should NOT be accepted on the user path —
    // it must use x-cron-secret instead
    const result = verifyCronOrUserCaller(makeRequest(withUserJWT(SERVICE_ROLE_KEY)));
    assertEquals(result instanceof Response, true);
    assertEquals(result!.status, 401);
    const body = await result!.json();
    assertStringIncludes(body.reason, "Service role key is not accepted");
  } finally {
    teardownEnv();
  }
});

Deno.test("verifyCronOrUserCaller: returns 401 with no headers at all", async () => {
  setupEnv();
  try {
    const result = verifyCronOrUserCaller(makeRequest());
    assertEquals(result instanceof Response, true);
    assertEquals(result!.status, 401);
    const body = await result!.json();
    assertStringIncludes(body.reason, "Requires either x-cron-secret");
  } finally {
    teardownEnv();
  }
});

Deno.test("verifyCronOrUserCaller: returns 401 with wrong cron secret and no JWT", async () => {
  setupEnv();
  try {
    const result = verifyCronOrUserCaller(makeRequest(withCronSecret(WRONG_SECRET)));
    assertEquals(result instanceof Response, true);
    assertEquals(result!.status, 401);
  } finally {
    teardownEnv();
  }
});

Deno.test("verifyCronOrUserCaller: cron path works even without SUPABASE_SERVICE_ROLE_KEY set", () => {
  Deno.env.set("CRON_SECRET", REAL_SECRET);
  Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
  try {
    const result = verifyCronOrUserCaller(makeRequest(withCronSecret(REAL_SECRET)));
    assertEquals(result, null, "Cron path should work independently of service role key");
  } finally {
    teardownEnv();
  }
});

Deno.test("verifyCronOrUserCaller: user JWT path works even without CRON_SECRET set", () => {
  Deno.env.delete("CRON_SECRET");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  try {
    const result = verifyCronOrUserCaller(makeRequest(withUserJWT(USER_JWT)));
    assertEquals(result, null, "User path should work independently of cron secret");
  } finally {
    teardownEnv();
  }
});

Deno.test("verifyCronOrUserCaller: both paths missing returns 401", async () => {
  Deno.env.delete("CRON_SECRET");
  Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
  try {
    const result = verifyCronOrUserCaller(makeRequest());
    assertEquals(result instanceof Response, true);
    assertEquals(result!.status, 401);
  } finally {
    teardownEnv();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("verifyCronCaller: timing-safe comparison (secret must match exactly)", async () => {
  setupEnv();
  try {
    // Almost-right secret (off by one char)
    const almostRight = REAL_SECRET.slice(0, -1) + "X";
    const result = verifyCronCaller(makeRequest(withCronSecret(almostRight)));
    assertEquals(result instanceof Response, true);
    assertEquals(result!.status, 401);
  } finally {
    teardownEnv();
  }
});

Deno.test("verifyCronOrUserCaller: Bearer prefix required (raw token without Bearer rejected)", async () => {
  setupEnv();
  try {
    // Authorization header without "Bearer " prefix
    const result = verifyCronOrUserCaller(makeRequest({ "Authorization": USER_JWT }));
    assertEquals(result instanceof Response, true);
    assertEquals(result!.status, 401);
  } finally {
    teardownEnv();
  }
});

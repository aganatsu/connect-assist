/**
 * Tests for cronAuth.ts — caller verification for edge functions.
 *
 * 1. verifyCronCaller (cron-only functions) — exact x-cron-secret required.
 * 2. verifyCronOrUserCaller (dual-path) — exact cron secret OR a
 *    cryptographically validated user JWT. A bare Bearer token is NOT enough.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { verifyCronCaller, verifyCronOrUserCaller } from "../../functions/_shared/cronAuth.ts";
import type { ClaimsVerifier } from "../../functions/_shared/callerAuth.ts";

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/functions/v1/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({}),
  });
}

const REAL_SECRET = "test-cron-secret-abc123-very-long-random-value";
const WRONG_SECRET = "wrong-secret-xyz";
const VALID_JWT = "valid.user.jwt";
const FORGED_JWT = "forged.user.jwt";
const SERVICE_ROLE_KEY = "service-role-key-value";

/** Only VALID_JWT verifies — everything else fails signature validation. */
const verifier: ClaimsVerifier = (token) =>
  Promise.resolve(token === VALID_JWT ? { sub: "user-123", role: "authenticated" } : null);

function setupEnv() {
  Deno.env.set("CRON_SECRET", REAL_SECRET);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
}
function teardownEnv() {
  Deno.env.delete("CRON_SECRET");
  Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
}

// ── verifyCronCaller ───────────────────────────────────────────────────────

Deno.test("verifyCronCaller: authorized with the exact secret (cron keeps working)", () => {
  setupEnv();
  try {
    assertEquals(verifyCronCaller(makeRequest({ "x-cron-secret": REAL_SECRET })), null);
  } finally { teardownEnv(); }
});

Deno.test("verifyCronCaller: 401 with no header", async () => {
  setupEnv();
  try {
    const res = verifyCronCaller(makeRequest())!;
    assertEquals(res.status, 401);
    assertStringIncludes((await res.json()).reason, "x-cron-secret");
  } finally { teardownEnv(); }
});

Deno.test("verifyCronCaller: 401 with wrong secret", () => {
  setupEnv();
  try {
    assertEquals(verifyCronCaller(makeRequest({ "x-cron-secret": WRONG_SECRET }))!.status, 401);
  } finally { teardownEnv(); }
});

Deno.test("verifyCronCaller: 401 with a prefix of the real secret", () => {
  setupEnv();
  try {
    const partial = REAL_SECRET.slice(0, 10);
    assertEquals(verifyCronCaller(makeRequest({ "x-cron-secret": partial }))!.status, 401);
  } finally { teardownEnv(); }
});

Deno.test("verifyCronCaller: 401 for a user JWT (cron-only rejects user path)", () => {
  setupEnv();
  try {
    assertEquals(
      verifyCronCaller(makeRequest({ Authorization: `Bearer ${VALID_JWT}` }))!.status,
      401,
    );
  } finally { teardownEnv(); }
});

Deno.test("verifyCronCaller: fail-closed when CRON_SECRET not configured", async () => {
  Deno.env.delete("CRON_SECRET");
  try {
    const res = verifyCronCaller(makeRequest({ "x-cron-secret": "anything" }))!;
    assertEquals(res.status, 401);
    assertStringIncludes((await res.json()).reason, "CRON_SECRET not configured");
  } finally { teardownEnv(); }
});

// ── verifyCronOrUserCaller ─────────────────────────────────────────────────

Deno.test("verifyCronOrUserCaller: authorized via cron secret", async () => {
  setupEnv();
  try {
    assertEquals(
      await verifyCronOrUserCaller(makeRequest({ "x-cron-secret": REAL_SECRET }), verifier),
      null,
    );
  } finally { teardownEnv(); }
});

Deno.test("verifyCronOrUserCaller: authorized via cryptographically valid user JWT", async () => {
  setupEnv();
  try {
    assertEquals(
      await verifyCronOrUserCaller(makeRequest({ Authorization: `Bearer ${VALID_JWT}` }), verifier),
      null,
    );
  } finally { teardownEnv(); }
});

Deno.test("verifyCronOrUserCaller: 401 for a forged/unverifiable Bearer token", async () => {
  setupEnv();
  try {
    const res = await verifyCronOrUserCaller(
      makeRequest({ Authorization: `Bearer ${FORGED_JWT}` }),
      verifier,
    );
    assertEquals(res!.status, 401);
  } finally { teardownEnv(); }
});

Deno.test("verifyCronOrUserCaller: 401 with no credentials at all", async () => {
  setupEnv();
  try {
    assertEquals((await verifyCronOrUserCaller(makeRequest(), verifier))!.status, 401);
  } finally { teardownEnv(); }
});

Deno.test("verifyCronOrUserCaller: service-role key is rejected on the user path", async () => {
  setupEnv();
  try {
    const res = await verifyCronOrUserCaller(
      makeRequest({ Authorization: `Bearer ${SERVICE_ROLE_KEY}` }),
      verifier,
    );
    assertEquals(res!.status, 401);
  } finally { teardownEnv(); }
});

Deno.test("verifyCronOrUserCaller: 401 for wrong cron secret without a JWT", async () => {
  setupEnv();
  try {
    const res = await verifyCronOrUserCaller(
      makeRequest({ "x-cron-secret": WRONG_SECRET }),
      verifier,
    );
    assertEquals(res!.status, 401);
  } finally { teardownEnv(); }
});

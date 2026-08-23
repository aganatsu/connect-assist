/**
 * Tests for callerAuth.ts — service-role identification and validated user JWTs.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  authorizeScopedCaller,
  bearerToken,
  type ClaimsVerifier,
  isServiceRoleCaller,
  resolveAuthenticatedUserId,
  resolveCallerScopedUserId,
  secretsMatch,
} from "../../functions/_shared/callerAuth.ts";

const SERVICE_ROLE_KEY = "service-role-key-value";
const VALID_JWT = "valid.user.jwt";

const verifier: ClaimsVerifier = (token) =>
  Promise.resolve(token === VALID_JWT ? { sub: "user-abc", role: "authenticated" } : null);

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/functions/v1/test", { method: "POST", headers });
}

function setup() { Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY); }
function teardown() { Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY"); }

Deno.test("secretsMatch: exact match only", () => {
  assertEquals(secretsMatch("abc", "abc"), true);
  assertEquals(secretsMatch("abc", "abd"), false);
  assertEquals(secretsMatch("abc", "ab"), false);
  assertEquals(secretsMatch("", ""), false);
  assertEquals(secretsMatch(null, "abc"), false);
});

Deno.test("bearerToken: extracts only well-formed Bearer tokens", () => {
  assertEquals(bearerToken(req({ Authorization: "Bearer tok" })), "tok");
  assertEquals(bearerToken(req({ Authorization: "Basic tok" })), null);
  assertEquals(bearerToken(req()), null);
});

Deno.test("isServiceRoleCaller: true for apikey or Bearer service-role key", () => {
  setup();
  try {
    assertEquals(isServiceRoleCaller(req({ apikey: SERVICE_ROLE_KEY })), true);
    assertEquals(isServiceRoleCaller(req({ Authorization: `Bearer ${SERVICE_ROLE_KEY}` })), true);
    assertEquals(isServiceRoleCaller(req({ apikey: "nope" })), false);
    assertEquals(isServiceRoleCaller(req()), false);
  } finally { teardown(); }
});

Deno.test("resolveAuthenticatedUserId: only a validated user JWT resolves", async () => {
  setup();
  try {
    assertEquals(await resolveAuthenticatedUserId(req({ Authorization: `Bearer ${VALID_JWT}` }), verifier), "user-abc");
    assertEquals(await resolveAuthenticatedUserId(req({ Authorization: "Bearer forged" }), verifier), null);
    assertEquals(await resolveAuthenticatedUserId(req(), verifier), null);
  } finally { teardown(); }
});

Deno.test("resolveAuthenticatedUserId: service-role key is not a user identity", async () => {
  setup();
  try {
    const serviceVerifier: ClaimsVerifier = () => Promise.resolve({ sub: "x", role: "service_role" });
    assertEquals(
      await resolveAuthenticatedUserId(req({ Authorization: `Bearer ${SERVICE_ROLE_KEY}` }), serviceVerifier),
      null,
    );
  } finally { teardown(); }
});

Deno.test("resolveAuthenticatedUserId: anon-role claims are rejected", async () => {
  setup();
  try {
    const anonVerifier: ClaimsVerifier = () => Promise.resolve({ sub: "anon-sub", role: "anon" });
    assertEquals(await resolveAuthenticatedUserId(req({ Authorization: "Bearer anon" }), anonVerifier), null);
  } finally { teardown(); }
});

Deno.test("resolveCallerScopedUserId: a user is always scoped to their JWT identity", () => {
  assertEquals(
    resolveCallerScopedUserId("user-abc", undefined),
    { userId: "user-abc", forbidden: false },
  );
  assertEquals(
    resolveCallerScopedUserId("user-abc", "user-abc"),
    { userId: "user-abc", forbidden: false },
  );
  assertEquals(
    resolveCallerScopedUserId("user-abc", "other-user"),
    { userId: null, forbidden: true },
  );
});

Deno.test("resolveCallerScopedUserId: a trusted server caller keeps its explicit target", () => {
  assertEquals(
    resolveCallerScopedUserId(null, "scheduled-user"),
    { userId: "scheduled-user", forbidden: false },
  );
  assertEquals(
    resolveCallerScopedUserId(null, undefined),
    { userId: null, forbidden: false },
  );
});

Deno.test("authorizeScopedCaller: exact service caller is scoped to its explicit user", async () => {
  setup();
  try {
    assertEquals(
      await authorizeScopedCaller(
        req({ Authorization: `Bearer ${SERVICE_ROLE_KEY}` }),
        "scheduled-user",
      ),
      {
        authorized: true,
        userId: "scheduled-user",
        serviceRole: true,
      },
    );
    assertEquals(
      await authorizeScopedCaller(
        req({ Authorization: `Bearer ${SERVICE_ROLE_KEY}` }),
        undefined,
      ),
      {
        authorized: false,
        status: 400,
        error: "Service caller must provide userId",
      },
    );
  } finally {
    teardown();
  }
});

Deno.test("authorizeScopedCaller: user JWT cannot select another user", async () => {
  setup();
  try {
    assertEquals(
      await authorizeScopedCaller(
        req({ Authorization: `Bearer ${VALID_JWT}` }),
        "other-user",
        verifier,
      ),
      {
        authorized: false,
        status: 403,
        error: "Cannot operate another user's broker connection",
      },
    );
    assertEquals(
      await authorizeScopedCaller(
        req({ Authorization: `Bearer ${VALID_JWT}` }),
        undefined,
        verifier,
      ),
      {
        authorized: true,
        userId: "user-abc",
        serviceRole: false,
      },
    );
  } finally {
    teardown();
  }
});

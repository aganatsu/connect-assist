/**
 * Tests for callerAuth.ts — service-role identification and validated user JWTs.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  bearerToken,
  type ClaimsVerifier,
  isServiceRoleCaller,
  resolveAuthenticatedUserId,
  secretsMatch,
} from "./callerAuth.ts";

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

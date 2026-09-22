import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  checkResearchKey,
  constantTimeEquals,
  RESEARCH_KEY_ENV,
  RESEARCH_KEY_HEADER,
} from "../../functions/_shared/ipoResearchAuth.ts";

/**
 * The research key is the ONLY thing between a caller and a service-role client
 * that bypasses RLS on the canonical corpus. These tests pin that: wrong keys
 * are refused, a missing deployment secret is distinguishable from a bad
 * credential, and no response ever quotes the secret.
 */

const orig = Deno.env.get(RESEARCH_KEY_ENV);
const withKey = (v: string | null, fn: () => Promise<void>) => async () => {
  if (v === null) Deno.env.delete(RESEARCH_KEY_ENV);
  else Deno.env.set(RESEARCH_KEY_ENV, v);
  try { await fn(); } finally {
    if (orig === undefined) Deno.env.delete(RESEARCH_KEY_ENV);
    else Deno.env.set(RESEARCH_KEY_ENV, orig);
  }
};
const reqWith = (headers: Record<string, string> = {}) =>
  new Request("https://example.test/smc-analysis", { method: "POST", headers });

const SECRET = "s3cr3t-research-token-abcdefghijklmnop";

Deno.test("the correct key is accepted", withKey(SECRET, async () => {
  const r = await checkResearchKey(reqWith({ [RESEARCH_KEY_HEADER]: SECRET }));
  assertEquals(r.ok, true);
}));

Deno.test("header matching is case-insensitive, as the Headers spec requires", withKey(SECRET, async () => {
  const r = await checkResearchKey(reqWith({ "x-ipo-research-key": SECRET }));
  assertEquals(r.ok, true);
}));

Deno.test("a missing, empty, wrong or near-miss key is refused with 401", withKey(SECRET, async () => {
  for (const [label, headers] of [
    ["no header", {}],
    ["empty", { [RESEARCH_KEY_HEADER]: "" }],
    ["wrong", { [RESEARCH_KEY_HEADER]: "not-the-token" }],
    ["prefix", { [RESEARCH_KEY_HEADER]: SECRET.slice(0, -1) }],
    ["suffix added", { [RESEARCH_KEY_HEADER]: SECRET + "x" }],
    ["case changed", { [RESEARCH_KEY_HEADER]: SECRET.toUpperCase() }],
  ] as Array<[string, Record<string, string>]>) {
    const r = await checkResearchKey(reqWith(headers));
    assertEquals(r.ok, false, `${label} must be refused`);
    assertEquals((r as any).status, 401, label);
  }
}));

Deno.test("an Authorization bearer token is NOT a substitute for the research key", withKey(SECRET, async () => {
  // The corpus is project data. A signed-in user, or the publishable key, must
  // not reach it just by being a valid JWT.
  const r = await checkResearchKey(reqWith({ Authorization: `Bearer ${SECRET}` }));
  assertEquals(r.ok, false);
  assertEquals((r as any).status, 401);
}));

Deno.test("a deployment with no secret returns 503, not 401", withKey(null, async () => {
  // Different operational facts. 401 says fix your request; 503 says nothing
  // you send will ever work. Collapsing them sends someone hunting for a
  // credential problem that is really a deployment problem.
  const r = await checkResearchKey(reqWith({ [RESEARCH_KEY_HEADER]: "anything" }));
  assertEquals(r.ok, false);
  assertEquals((r as any).status, 503);
  assert((r as any).error.includes(RESEARCH_KEY_ENV));
}));

Deno.test("an empty server secret cannot be satisfied by an empty header", withKey("", async () => {
  const r = await checkResearchKey(reqWith({ [RESEARCH_KEY_HEADER]: "" }));
  assertEquals(r.ok, false);
  assertEquals((r as any).status, 503, "an unset secret must never authorise anyone");
}));

Deno.test("no error message ever quotes the secret", withKey(SECRET, async () => {
  for (const headers of [{}, { [RESEARCH_KEY_HEADER]: "wrong-value-here" }]) {
    const r = await checkResearchKey(reqWith(headers)) as any;
    assert(!r.error.includes(SECRET), "the expected token must never be echoed");
    assert(!r.error.includes("wrong-value-here"), "nor the supplied one");
  }
}));

Deno.test("comparison is constant-time and length-independent", async () => {
  assertEquals(await constantTimeEquals("abc", "abc"), true);
  assertEquals(await constantTimeEquals("abc", "abd"), false);
  assertEquals(await constantTimeEquals("abc", "abcdef"), false);
  assertEquals(await constantTimeEquals("", ""), true);
  // Hashing both sides first means the loop length does not depend on either
  // input, so a length check — itself a timing signal — is unnecessary.
  assertEquals(await constantTimeEquals("a", "a".repeat(5000)), false);
});

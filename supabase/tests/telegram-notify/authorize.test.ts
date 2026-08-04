/**
 * Tests for the telegram-notify relay authorization.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { authorizeTelegramSend, chatIdsFromPreferences } from "./authorize.ts";
import type { ClaimsVerifier } from "../_shared/callerAuth.ts";

const VALID_JWT = "valid.user.jwt";
const verifier: ClaimsVerifier = (token) =>
  Promise.resolve(token === VALID_JWT ? { sub: "user-1", role: "authenticated" } : null);

const OWN_CHATS: Record<string, string[]> = { "user-1": ["111", "222"] };
const loadUserChatIds = (userId: string) => Promise.resolve(OWN_CHATS[userId] ?? []);

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/functions/v1/telegram-notify", { method: "POST", headers });
}

Deno.test("chatIdsFromPreferences: supports list, object entries and legacy field", () => {
  assertEquals(
    chatIdsFromPreferences({ telegramChatIds: ["1", { id: "2" }], telegramChatId: "3" }),
    ["1", "2", "3"],
  );
  assertEquals(chatIdsFromPreferences(null), []);
});

Deno.test("service-role caller may notify any chat (scanner/advisor flows keep working)", async () => {
  const decision = await authorizeTelegramSend(req(), "999", {
    loadUserChatIds,
    verifier,
    serviceCaller: () => true,
  });
  assertEquals(decision, { allowed: true, caller: "service" });
});

Deno.test("authenticated user may notify their own chat (Settings test message)", async () => {
  const decision = await authorizeTelegramSend(
    req({ Authorization: `Bearer ${VALID_JWT}` }),
    "111",
    { loadUserChatIds, verifier, serviceCaller: () => false },
  );
  assertEquals(decision, { allowed: true, caller: "user", userId: "user-1" });
});

Deno.test("authenticated user cannot notify an arbitrary chat id", async () => {
  const decision = await authorizeTelegramSend(
    req({ Authorization: `Bearer ${VALID_JWT}` }),
    "999",
    { loadUserChatIds, verifier, serviceCaller: () => false },
  );
  assertEquals(decision.allowed, false);
  assertEquals((decision as { status: number }).status, 403);
});

Deno.test("unauthenticated caller is rejected with 401", async () => {
  const decision = await authorizeTelegramSend(req(), "111", {
    loadUserChatIds,
    verifier,
    serviceCaller: () => false,
  });
  assertEquals(decision.allowed, false);
  assertEquals((decision as { status: number }).status, 401);
});

Deno.test("forged Bearer token is rejected with 401", async () => {
  const decision = await authorizeTelegramSend(req({ Authorization: "Bearer forged" }), "111", {
    loadUserChatIds,
    verifier,
    serviceCaller: () => false,
  });
  assertEquals(decision.allowed, false);
  assertEquals((decision as { status: number }).status, 401);
});

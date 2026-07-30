/**
 * Authorization for the telegram-notify relay.
 *
 * Rules:
 *  - Trusted server callers (service-role key) may notify any chat id. This
 *    preserves the scanner, zone-confirmation, advisor, outcome-tracker and
 *    optimizer notification flows, which run server-side.
 *  - Authenticated frontend users (validated Supabase JWT) may notify only the
 *    chat ids saved in their own settings — this keeps the Settings "send test
 *    message" button working.
 *  - Everything else is rejected.
 */

import {
  type ClaimsVerifier,
  defaultClaimsVerifier,
  isServiceRoleCaller,
  resolveAuthenticatedUserId,
} from "../_shared/callerAuth.ts";

export type TelegramAuthDecision =
  | { allowed: true; caller: "service" | "user"; userId?: string }
  | { allowed: false; status: 401 | 403; error: string };

export function chatIdsFromPreferences(prefs: unknown): string[] {
  const p = (prefs ?? {}) as Record<string, unknown>;
  const list = Array.isArray(p.telegramChatIds) ? p.telegramChatIds : [];
  const ids = list
    .map((entry) => {
      if (entry && typeof entry === "object") {
        return String((entry as Record<string, unknown>).id ?? "");
      }
      return String(entry ?? "");
    })
    .filter((id) => id.length > 0);
  if (p.telegramChatId) ids.push(String(p.telegramChatId));
  return [...new Set(ids)];
}

export interface TelegramAuthDeps {
  /** Returns the chat ids stored in the given user's settings. */
  loadUserChatIds: (userId: string) => Promise<string[]>;
  verifier?: ClaimsVerifier;
  /** Overridable for tests. */
  serviceCaller?: (req: Request) => boolean;
}

export async function authorizeTelegramSend(
  req: Request,
  chatId: string,
  deps: TelegramAuthDeps,
): Promise<TelegramAuthDecision> {
  const isService = (deps.serviceCaller ?? isServiceRoleCaller)(req);
  if (isService) return { allowed: true, caller: "service" };

  const userId = await resolveAuthenticatedUserId(
    req,
    deps.verifier ?? defaultClaimsVerifier,
  );
  if (!userId) {
    return { allowed: false, status: 401, error: "Unauthorized" };
  }

  const ownChatIds = await deps.loadUserChatIds(userId);
  if (!ownChatIds.includes(String(chatId))) {
    return {
      allowed: false,
      status: 403,
      error: "chat_id is not registered in your settings",
    };
  }
  return { allowed: true, caller: "user", userId };
}

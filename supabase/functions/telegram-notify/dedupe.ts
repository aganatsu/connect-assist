export interface NotificationClaimStore {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{
    data: boolean | null;
    error: { code?: string } | null;
  }>;
}

const localClaims = new Map<string, number>();

export function buildClaimKey(chatId: string, dedupeKey: string): string {
  return `${chatId}:${dedupeKey}`;
}

export async function claimNotification(
  store: NotificationClaimStore,
  chatId: string,
  dedupeKey: string,
  cooldownSeconds: number,
  now = Date.now(),
): Promise<boolean> {
  const claimKey = buildClaimKey(chatId, dedupeKey);
  const localExpiry = localClaims.get(claimKey);
  if (localExpiry && localExpiry > now) return false;

  const cooldownMs = Math.max(1, cooldownSeconds) * 1_000;
  const { data, error } = await store.rpc("claim_telegram_notification", {
    p_claim_key: claimKey,
    p_expires_at: new Date(now + cooldownMs).toISOString(),
  });
  if (!error) {
    if (data === true) localClaims.set(claimKey, now + cooldownMs);
    return data === true;
  }

  // Keep an instance-local guard during a migration/deployment transition.
  localClaims.set(claimKey, now + cooldownMs);
  return true;
}

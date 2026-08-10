import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildClaimKey,
  claimNotification,
} from "../../functions/telegram-notify/dedupe.ts";

function store(data: boolean | null, error: { code?: string } | null = null) {
  return {
    rpc: (_name: string, _args: Record<string, unknown>) =>
      Promise.resolve({ data, error }),
  };
}

Deno.test("notification claim key is stable across time", () => {
  assertEquals(buildClaimKey("1", "position:sl"), "1:position:sl");
});

Deno.test("notification claim rejects an active durable claim", async () => {
  assertEquals(
    await claimNotification(store(false), "2", "duplicate", 900, 1_000),
    false,
  );
});

Deno.test("notification claim accepts a new durable claim", async () => {
  assertEquals(
    await claimNotification(store(true), "3", "new", 900, 1_000),
    true,
  );
});

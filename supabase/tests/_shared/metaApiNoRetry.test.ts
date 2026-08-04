import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { metaFetch, regionCache } from "../../functions/_shared/metaApiClient.ts";

Deno.test("MetaAPI non-idempotent mode does not fail over after a region error", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  regionCache.clear();
  globalThis.fetch = (() => {
    calls++;
    return Promise.resolve(
      new Response("not connected to broker in this region", { status: 409 }),
    );
  }) as typeof fetch;

  try {
    const { res, body } = await metaFetch(
      "account-1",
      "token",
      (base) => `${base}/trade`,
      { method: "POST" },
      { allowFailover: false },
    );
    assertEquals(calls, 1);
    assertEquals(res.status, 409);
    assertStringIncludes(body, "not connected");
  } finally {
    globalThis.fetch = originalFetch;
    regionCache.clear();
  }
});

Deno.test("MetaAPI non-idempotent mode returns one uncertain network result", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  regionCache.clear();
  globalThis.fetch = (() => {
    calls++;
    return Promise.reject(new Error("connection reset"));
  }) as typeof fetch;

  try {
    const { res, body } = await metaFetch(
      "account-1",
      "token",
      (base) => `${base}/trade`,
      { method: "POST" },
      { allowFailover: false },
    );
    assertEquals(calls, 1);
    assertEquals(res.status, 504);
    assertStringIncludes(body, "connection reset");
  } finally {
    globalThis.fetch = originalFetch;
    regionCache.clear();
  }
});

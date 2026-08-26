import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  META_REGIONS,
  metaFetch,
  regionCache,
} from "../../functions/_shared/metaApiClient.ts";

Deno.test("MetaAPI non-idempotent mode does not fail over after a region error", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  regionCache.clear();
  regionCache.set("account-1", "new-york");
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

Deno.test("MetaAPI never sends a cold-cache mutation when region discovery fails", async () => {
  regionCache.clear();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: String(init?.method || "GET").toUpperCase(),
    });
    return Promise.resolve(
      new Response('{"message":"account not connected to broker"}', {
        status: 409,
      }),
    );
  }) as typeof fetch;

  try {
    const result = await metaFetch(
      "account-4",
      "token",
      (base) => `${base}/trade`,
      { method: "POST", body: "{}" },
    );
    assertEquals(result.res.status, 503);
    assertEquals(
      result.body,
      "MetaAPI account region could not be established; mutation was not sent",
    );
    const clientCalls = calls.filter((call) => !call.url.includes("provisioning"));
    assertEquals(clientCalls.length, META_REGIONS.length);
    assertEquals(calls.every((call) => call.method === "GET"), true);
    assertEquals(
      clientCalls.every((call) => call.url.endsWith("/account-information")),
      true,
    );

  } finally {
    globalThis.fetch = originalFetch;
    regionCache.clear();
  }
});

Deno.test("MetaAPI ignores failover opt-in for mutating HTTP methods", async () => {
  regionCache.set("account-5", "new-york");
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    calls.push(String(input));
    return Promise.resolve(
      new Response('{"message":"region mismatch"}', { status: 409 }),
    );
  }) as typeof fetch;

  try {
    const result = await metaFetch(
      "account-5",
      "token",
      (base) => `${base}/trade`,
      { method: "POST", body: "{}" },
      { allowFailover: true },
    );
    assertEquals(result.res.status, 409);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].includes("new-york"), true);
  } finally {
    globalThis.fetch = originalFetch;
    regionCache.clear();
  }
});

Deno.test("MetaAPI non-idempotent mode returns one uncertain network result", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  regionCache.clear();
  regionCache.set("account-1", "singapore");
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

Deno.test("MetaAPI discovers a cold-cache account region before one mutation dispatch", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  regionCache.clear();
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const method = init?.method || "GET";
    calls.push({ url, method });

    if (url.includes("london") && url.endsWith("/account-information")) {
      return Promise.resolve(
        new Response("not connected to broker in this region", { status: 409 }),
      );
    }
    if (url.includes("new-york") && url.endsWith("/account-information")) {
      return Promise.resolve(new Response("{}", { status: 200 }));
    }
    if (url.includes("new-york") && url.endsWith("/trade")) {
      return Promise.resolve(
        new Response('{"stringCode":"TRADE_RETCODE_DONE"}', {
          status: 200,
        }),
      );
    }
    return Promise.resolve(new Response("unexpected request", { status: 500 }));
  }) as typeof fetch;

  try {
    const { res } = await metaFetch(
      "account-cold",
      "token",
      (base) => `${base}/trade`,
      { method: "POST", body: "{}" },
      { allowFailover: false },
    );
    assertEquals(res.status, 200);
    assertEquals(calls.filter((call) => call.method === "POST").length, 1);
    assertEquals(calls.at(-1)?.url.includes("new-york"), true);
    assertEquals(regionCache.get("account-cold"), "new-york");
  } finally {
    globalThis.fetch = originalFetch;
    regionCache.clear();
  }
});

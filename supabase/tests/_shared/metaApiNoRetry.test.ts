import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { metaFetch, regionCache } from "../../functions/_shared/metaApiClient.ts";

function requestDetails(input: string | URL | Request, init?: RequestInit) {
  return {
    url: typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url,
    method: String(init?.method || "GET").toUpperCase(),
  };
}

Deno.test("MetaAPI mutation uses one already-resolved region", async () => {
  const originalFetch = globalThis.fetch;
  const calls: ReturnType<typeof requestDetails>[] = [];
  regionCache.clear();
  regionCache.set("account-1", "new-york");
  globalThis.fetch = ((input, init) => {
    calls.push(requestDetails(input, init));
    return Promise.resolve(new Response("not connected to broker in this region", { status: 409 }));
  }) as typeof fetch;

  try {
    const { res, body } = await metaFetch(
      "account-1",
      "token",
      (base) => `${base}/trade`,
      { method: "POST" },
      { allowFailover: false },
    );
    assertEquals(calls.length, 1);
    assertEquals(calls[0].url.includes("new-york"), true);
    assertEquals(res.status, 409);
    assertStringIncludes(body, "not connected");
  } finally {
    globalThis.fetch = originalFetch;
    regionCache.clear();
  }
});

Deno.test("MetaAPI never guesses a region when provisioning fails", async () => {
  regionCache.clear();
  const originalFetch = globalThis.fetch;
  const calls: ReturnType<typeof requestDetails>[] = [];
  globalThis.fetch = ((input, init) => {
    calls.push(requestDetails(input, init));
    return Promise.resolve(new Response('{"message":"provisioning unavailable"}', { status: 503 }));
  }) as typeof fetch;

  try {
    const result = await metaFetch(
      "account-no-region",
      "token",
      (base) => `${base}/trade`,
      { method: "POST", body: "{}" },
    );
    assertEquals(result.res.status, 503);
    assertStringIncludes(result.body, "region could not be established");
    assertEquals(calls.length, 1);
    assertStringIncludes(calls[0].url, "mt-provisioning-api-v1");
    assertEquals(calls[0].method, "GET");
  } finally {
    globalThis.fetch = originalFetch;
    regionCache.clear();
  }
});

Deno.test("MetaAPI accepts dynamic provisioning regions such as vint-hill", async () => {
  regionCache.clear();
  const originalFetch = globalThis.fetch;
  const calls: ReturnType<typeof requestDetails>[] = [];
  globalThis.fetch = ((input, init) => {
    const call = requestDetails(input, init);
    calls.push(call);
    if (call.url.includes("mt-provisioning-api-v1")) {
      return Promise.resolve(new Response('{"region":"vint-hill","state":"DEPLOYED"}'));
    }
    return Promise.resolve(new Response('{"balance":10000}'));
  }) as typeof fetch;

  try {
    const result = await metaFetch(
      "account-vint-hill",
      "token",
      (base) => `${base}/account-information`,
    );
    assertEquals(result.res.status, 200);
    assertEquals(result.region, "vint-hill");
    assertEquals(calls.length, 2);
    assertStringIncludes(calls[1].url, "mt-client-api-v1.vint-hill.");
    assertEquals(calls.some((call) => call.url.includes(".london.")), false);
    assertEquals(calls.some((call) => call.url.includes(".new-york.")), false);
    assertEquals(calls.some((call) => call.url.includes(".singapore.")), false);
  } finally {
    globalThis.fetch = originalFetch;
    regionCache.clear();
  }
});

Deno.test("MetaAPI refreshes provisioning once when a cached read region is stale", async () => {
  regionCache.clear();
  regionCache.set("account-moved", "london");
  const originalFetch = globalThis.fetch;
  const calls: ReturnType<typeof requestDetails>[] = [];
  globalThis.fetch = ((input, init) => {
    const call = requestDetails(input, init);
    calls.push(call);
    if (call.url.includes(".london.")) {
      return Promise.resolve(new Response("request URL does not match the account region", { status: 409 }));
    }
    if (call.url.includes("mt-provisioning-api-v1")) {
      return Promise.resolve(new Response('{"region":"vint-hill","state":"DEPLOYED"}'));
    }
    return Promise.resolve(new Response("[]"));
  }) as typeof fetch;

  try {
    const result = await metaFetch("account-moved", "token", (base) => `${base}/positions`);
    assertEquals(result.res.status, 200);
    assertEquals(result.region, "vint-hill");
    assertEquals(calls.length, 3);
    assertStringIncludes(calls[0].url, ".london.");
    assertStringIncludes(calls[1].url, "mt-provisioning-api-v1");
    assertStringIncludes(calls[2].url, ".vint-hill.");
  } finally {
    globalThis.fetch = originalFetch;
    regionCache.clear();
  }
});

Deno.test("MetaAPI never retries a mutation after a stale-region response", async () => {
  regionCache.clear();
  regionCache.set("account-mutation", "london");
  const originalFetch = globalThis.fetch;
  const calls: ReturnType<typeof requestDetails>[] = [];
  globalThis.fetch = ((input, init) => {
    calls.push(requestDetails(input, init));
    return Promise.resolve(new Response("request URL does not match the account region", { status: 409 }));
  }) as typeof fetch;

  try {
    const result = await metaFetch(
      "account-mutation",
      "token",
      (base) => `${base}/trade`,
      { method: "POST", body: "{}" },
      { allowFailover: true },
    );
    assertEquals(result.res.status, 409);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, "POST");
  } finally {
    globalThis.fetch = originalFetch;
    regionCache.clear();
  }
});

Deno.test("MetaAPI account lookup throttle suppresses repeated account requests", async () => {
  regionCache.clear();
  const originalFetch = globalThis.fetch;
  const calls: ReturnType<typeof requestDetails>[] = [];
  const throttleBody = JSON.stringify({
    error: "TooManyRequestsError",
    message: "trying to access too many unexisting or undeployed trading accounts",
  });
  globalThis.fetch = ((input, init) => {
    const call = requestDetails(input, init);
    calls.push(call);
    if (call.url.includes("mt-provisioning-api-v1")) {
      return Promise.resolve(new Response('{"region":"vint-hill","state":"DEPLOYED"}'));
    }
    return Promise.resolve(new Response(throttleBody, { status: 429 }));
  }) as typeof fetch;

  try {
    const first = await metaFetch("account-throttled", "token", (base) => `${base}/positions`);
    const second = await metaFetch("account-throttled", "token", (base) => `${base}/account-information`);
    assertEquals(first.res.status, 429);
    assertEquals(second.res.status, 429);
    assertEquals(calls.length, 2);
    assertEquals(calls.filter((call) => call.url.includes("mt-client-api-v1")).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    regionCache.clear();
  }
});

Deno.test("MetaAPI does not call the client API for an undeployed account", async () => {
  regionCache.clear();
  const originalFetch = globalThis.fetch;
  const calls: ReturnType<typeof requestDetails>[] = [];
  globalThis.fetch = ((input, init) => {
    calls.push(requestDetails(input, init));
    return Promise.resolve(new Response('{"region":"vint-hill","state":"UNDEPLOYED"}'));
  }) as typeof fetch;

  try {
    const result = await metaFetch(
      "account-undeployed",
      "token",
      (base) => `${base}/positions`,
    );
    assertEquals(result.res.status, 503);
    assertEquals(calls.length, 1);
    assertStringIncludes(calls[0].url, "mt-provisioning-api-v1");
  } finally {
    globalThis.fetch = originalFetch;
    regionCache.clear();
  }
});

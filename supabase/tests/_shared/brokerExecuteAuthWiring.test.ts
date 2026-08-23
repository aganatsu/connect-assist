import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile(
  new URL(
    "../../functions/broker-execute/index.ts",
    import.meta.url,
  ),
);
const compactSource = source.replace(/\s+/g, " ");

Deno.test("broker-execute authenticates service and user callers through callerAuth", () => {
  assertStringIncludes(
    source,
    'import { authorizeScopedCaller } from "../_shared/callerAuth.ts";',
  );
  assertStringIncludes(
    source,
    "const caller = await authorizeScopedCaller(req, requestedUserId);",
  );
  assertStringIncludes(
    source,
    "return respond({ error: caller.error, fallback: false }, caller.status);",
  );
  assert(
    !source.includes("supabase.auth.getClaims(token)"),
    "broker-execute must not maintain a second JWT validation implementation",
  );
});

Deno.test("broker-execute scopes its database client and connection query to the caller", () => {
  assertStringIncludes(
    source,
    "const databaseKey = caller.serviceRole ? serviceRoleKey : anonKey;",
  );
  assertStringIncludes(
    compactSource,
    "caller.serviceRole ? { auth: { persistSession: false } }",
  );
  assertStringIncludes(
    source,
    "global: { headers: { Authorization: authHeader! } }",
  );
  assertStringIncludes(
    source,
    '.eq("user_id", caller.userId).single()',
  );
});

Deno.test("automated broker-execute callers send the explicit owner id", () => {
  for (
    const path of [
      "../../functions/bot-scanner/index.ts",
      "../../functions/zone-confirmation-scanner/index.ts",
    ]
  ) {
    const callerSource = Deno.readTextFileSync(new URL(path, import.meta.url));
    const invocation = callerSource.split("/functions/v1/broker-execute")[1]
      ?.slice(0, 1_200) || "";
    assertStringIncludes(
      invocation,
      "userId,",
      `${path} must identify the owner when calling with the service role`,
    );
  }
});

Deno.test("broker read failures preserve upstream origin across the execution boundary", () => {
  const helper = source.split("function respondWithBrokerReadFailure")[1]
    ?.split("function respondWithBrokerMutationOutcome")[0] || "";
  assertStringIncludes(helper, 'errorOrigin: "broker"');
  assertStringIncludes(helper, "brokerStatus: upstreamStatus");
  assertStringIncludes(helper, "upstreamStatus >= 500 ? 503 : 424");

  const readSections = [
    ['if (action === "account_summary")', 'if (action === "open_trades")'],
    ['if (action === "open_trades")', 'if (action === "place_order")'],
    [
      'if (action === "account_balance")',
      'if (action === "symbol_specs" || action === "validate_symbol")',
    ],
    [
      'if (action === "symbol_specs" || action === "validate_symbol")',
      'if (action === "connection_status")',
    ],
    ['if (action === "connection_status")', 'if (action === "close_trade")'],
    ['if (action === "trade_history")', 'if (action === "modify_trade")'],
  ] as const;

  for (const [start, end] of readSections) {
    const section = source.split(start)[1]?.split(end)[0] || "";
    assertStringIncludes(
      section,
      'respondWithBrokerReadFailure(\n            "oanda",',
      `${start} must distinguish upstream OANDA failures from app authentication failures`,
    );
    assertStringIncludes(
      section,
      'respondWithBrokerReadFailure(\n            "metaapi",',
      `${start} must distinguish upstream MetaAPI failures from app authentication failures`,
    );
  }

  const symbolSection = source.split(
    'if (action === "symbol_specs" || action === "validate_symbol")',
  )[1]?.split('if (action === "connection_status")')[0] || "";
  const metaValidationFailure = symbolSection.split(
    'if (action === "validate_symbol")',
  )[1]?.split("return respondWithBrokerReadFailure")[0] || "";
  assertStringIncludes(metaValidationFailure, 'errorOrigin: "broker"');
  assertStringIncludes(metaValidationFailure, 'broker: "metaapi"');
  assertStringIncludes(metaValidationFailure, "brokerStatus: res.status");
});

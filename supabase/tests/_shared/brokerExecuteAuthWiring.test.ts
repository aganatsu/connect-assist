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

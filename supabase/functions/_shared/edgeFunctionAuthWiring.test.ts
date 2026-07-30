/**
 * Wiring tests: the security guards must remain attached to the entry points.
 * These assert on source so an accidental revert fails CI.
 */
import { assertStringIncludes, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const read = (p: string) => Deno.readTextFileSync(new URL(p, import.meta.url));

const CRON_ONLY = [
  "../zone-confirmation-scanner/index.ts",
  "../prop-firm-daily-reset/index.ts",
  "../data-cleanup/index.ts",
  "../outcome-tracker/index.ts",
];
const DUAL_PATH = [
  "../bot-scanner/index.ts",
  "../bot-daily-review/index.ts",
  "../bot-weekly-advisor/index.ts",
  "../advisor/index.ts",
  "../optimizer/index.ts",
  "../game-plan-refresh/index.ts",
];

Deno.test("cron-only functions require an exact cron secret", () => {
  for (const file of CRON_ONLY) {
    const src = read(file);
    assertStringIncludes(src, "verifyCronCaller(req)", `${file} must guard with verifyCronCaller`);
  }
});

Deno.test("dual-path functions await the cron-or-validated-user guard", () => {
  for (const file of DUAL_PATH) {
    const src = read(file);
    assertStringIncludes(
      src,
      "await verifyCronOrUserCaller(req)",
      `${file} must await verifyCronOrUserCaller`,
    );
  }
});

Deno.test("cron auth never trusts a bare Bearer token", () => {
  const src = read("./cronAuth.ts");
  assertStringIncludes(src, "resolveAuthenticatedUserId");
  assert(
    !src.includes('authHeader.startsWith("Bearer ")'),
    "cronAuth must not authorize on the presence of a Bearer token",
  );
});

Deno.test("backtest-engine scopes status by owner and locks internal actions", () => {
  const src = read("../backtest-engine/index.ts");
  assertStringIncludes(src, 'if (action === "status")');
  assertStringIncludes(src, 'statusQuery = statusQuery.eq("user_id", ownerId)');
  const warmup = src.slice(src.indexOf('if (action === "warmup")'));
  assertStringIncludes(
    warmup.slice(0, 400),
    'if (!serviceCaller) return respond({ error: "Forbidden" }, 403)',
  );
  const chunk = src.slice(src.indexOf('if (action === "chunk")'));
  assertStringIncludes(
    chunk.slice(0, 400),
    'if (!serviceCaller) return respond({ error: "Forbidden" }, 403)',
  );
  assertStringIncludes(src, "resolveAuthenticatedUserId(req)");
});

Deno.test("telegram-notify authorizes every send", () => {
  const src = read("../telegram-notify/index.ts");
  assertStringIncludes(src, "authorizeTelegramSend(req, String(chatId)");
  assertStringIncludes(src, "status: decision.status");
});

Deno.test("dual-path account-wide handlers scope user requests to the JWT owner", () => {
  for (
    const file of [
      "../advisor/index.ts",
      "../bot-daily-review/index.ts",
      "../bot-weekly-advisor/index.ts",
      "../optimizer/index.ts",
    ]
  ) {
    const src = read(file);
    assertStringIncludes(
      src,
      "await resolveAuthenticatedUserId(req)",
      `${file} must resolve the verified user identity`,
    );
    assertStringIncludes(
      src,
      "resolveCallerScopedUserId(",
      `${file} must reject a different caller-supplied user id`,
    );
  }
});

Deno.test("optimizer protects user-owned runs and internal state-machine actions", () => {
  const src = read("../optimizer/index.ts");
  assertStringIncludes(
    src,
    '["poll-backtest", "start-trial", "finalize"].includes(action)',
  );
  assertStringIncludes(
    src,
    'runQuery = runQuery.eq("user_id", authenticatedUserId)',
  );
  assert(
    !src.includes("JSON.parse(atob(token.split"),
    "optimizer must not derive identity from an unverified JWT payload",
  );
});

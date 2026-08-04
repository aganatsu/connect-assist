import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const botScanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const fastScanner = await Deno.readTextFile(
  new URL("../../functions/zone-confirmation-scanner/index.ts", import.meta.url),
);

Deno.test("main scanner persists Direction Verdicts and durable decision contexts", () => {
  assertStringIncludes(botScanner, "persistActiveDirectionVerdict");
  assertStringIncludes(botScanner, "buildTradeDecisionContext");
  assertStringIncludes(botScanner, 'stage: "candidate"');
  assertStringIncludes(botScanner, 'stage: "pending"');
  assertStringIncludes(botScanner, 'stage: "fill"');
  assertStringIncludes(botScanner, "decisionContext: pendingDecisionContext");
  assertStringIncludes(
    botScanner,
    "decisionContext: directAuthorization.decisionContext",
  );
});

Deno.test("both fill scanners load dedicated Direction Verdict authority instead of scan logs", () => {
  assertStringIncludes(botScanner, "loadActiveDirectionVerdicts");
  assertStringIncludes(fastScanner, "loadActiveDirectionVerdicts");
  assert(
    !fastScanner.includes('from("scan_logs")'),
    "fast confirmation must not recover Direction Verdict from scan_logs",
  );
  assertStringIncludes(fastScanner, "directionVerdictMatchesGamePlan");
});

Deno.test("both fill scanners make thesis validity mandatory and record confirmation", () => {
  assertStringIncludes(botScanner, "requireThesisValidation: true");
  assertStringIncludes(fastScanner, "const requireThesisValidation = true");
  assertStringIncludes(
    botScanner,
    "entryConfirmation: pendingEntryConfirmation",
  );
  assertStringIncludes(fastScanner, "entryConfirmation,");
  assertStringIncludes(
    fastScanner,
    "decisionContext: authorization.decisionContext",
  );
});

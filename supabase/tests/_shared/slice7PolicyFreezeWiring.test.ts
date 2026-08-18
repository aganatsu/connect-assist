import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const botScanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const fastScanner = await Deno.readTextFile(
  new URL(
    "../../functions/zone-confirmation-scanner/index.ts",
    import.meta.url,
  ),
);

Deno.test("every bot-scanner entry path creates a frozen strategy context", () => {
  for (
    const context of [
      "frozenStrategyContext",
      "pendingFrozenStrategyContext",
      "directFrozenStrategyContext",
      "breakerFrozenStrategyContext",
    ]
  ) {
    assertStringIncludes(botScanner, context);
  }
  assertStringIncludes(
    botScanner,
    "frozen_strategy_context: pendingFrozenStrategyContext",
  );
  assertStringIncludes(
    botScanner,
    "frozen_strategy_context: breakerFrozenStrategyContext",
  );
});

Deno.test("the sole confirmation path resolves style and attempts from the frozen setup", () => {
  assertStringIncludes(fastScanner, "resolvePendingStylePolicy(");
  assertStringIncludes(fastScanner, "validateFrozenSetupIdentity(");
  assertStringIncludes(fastScanner, "resolvePendingMaxConfirmationAttempts(");
  assertStringIncludes(
    fastScanner,
    "pendingTimeframeAuthority.roles.confirmation",
  );
  assertStringIncludes(
    fastScanner,
    "pendingTimeframeAuthority.roles.refinement",
  );
  assertStringIncludes(
    fastScanner,
    "interval: pendingTimeframeAuthority.runtimeEntry",
  );
});

Deno.test("fill authorization carries the original policy snapshot", () => {
  assertStringIncludes(
    fastScanner,
    "stylePolicy: pendingPolicyResolution.policy",
  );
});

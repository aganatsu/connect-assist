import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const botScanner = await Deno.readTextFile(
  new URL("../bot-scanner/index.ts", import.meta.url),
);
const fastScanner = await Deno.readTextFile(
  new URL("../zone-confirmation-scanner/index.ts", import.meta.url),
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

Deno.test("both confirmation paths resolve style and attempts from the frozen setup", () => {
  for (const source of [botScanner, fastScanner]) {
    assertStringIncludes(source, "resolvePendingStylePolicy(");
    assertStringIncludes(source, "validateFrozenSetupIdentity(");
    assertStringIncludes(
      source,
      "resolvePendingMaxConfirmationAttempts(",
    );
    assertStringIncludes(
      source,
      "pendingTimeframeAuthority.roles.confirmation",
    );
    assertStringIncludes(
      source,
      "pendingTimeframeAuthority.roles.refinement",
    );
    assertStringIncludes(
      source,
      "interval: pendingTimeframeAuthority.runtimeEntry",
    );
  }
});

Deno.test("fill authorization carries the original policy snapshot", () => {
  assertStringIncludes(
    botScanner,
    "stylePolicy: pendingPolicyResolution.policy",
  );
  assertStringIncludes(
    fastScanner,
    "stylePolicy: pendingPolicyResolution.policy",
  );
});

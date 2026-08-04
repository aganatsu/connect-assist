import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const scannerManagement = await Deno.readTextFile(
  new URL("../../functions/_shared/scannerManagement.ts", import.meta.url),
);
const backtestEngine = await Deno.readTextFile(
  new URL("../../functions/backtest-engine/index.ts", import.meta.url),
);
const stylePolicy = await Deno.readTextFile(
  new URL("../../functions/_shared/stylePolicy.ts", import.meta.url),
);

Deno.test("live management resolves frozen policy and calls shared calculator", () => {
  assertStringIncludes(
    scannerManagement,
    "resolvePositionManagementPolicy(pos, config)",
  );
  assertStringIncludes(
    scannerManagement,
    "const sharedDecision = computeManagementDecision(",
  );
  assertStringIncludes(
    scannerManagement,
    "source: managementPolicy.source",
  );
});

Deno.test("backtest freezes pair policy on each position and reuses it for exits", () => {
  assertStringIncludes(
    backtestEngine,
    "const positionManagementPolicy = resolveBacktestManagementPolicy(",
  );
  assertStringIncludes(
    backtestEngine,
    "managementPolicy: positionManagementPolicy",
  );
  assertStringIncludes(
    backtestEngine,
    "const managementConfig = pos.managementPolicy?.decision",
  );
  assertStringIncludes(
    backtestEngine,
    "managementPolicy: pos.managementPolicy",
  );
});

Deno.test("style-policy v1.3 freezes the complete management inputs", () => {
  for (
    const field of [
      "breakEvenOffsetPips",
      "adaptiveTrailingEnabled",
      "baseTrailATRMultiple",
      "momentumFadeThreshold",
      "trailTightenFactor",
      "trailWidenFactor",
    ]
  ) {
    assert(
      stylePolicy.includes(`${field}: config.${field}`),
      `${field} must be persisted in the style policy`,
    );
  }
});

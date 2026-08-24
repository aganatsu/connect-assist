import {
  assert,
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

Deno.test("Watchlist score eligibility is not recorded as terminal promotion", () => {
  const qualificationStart = botScanner.indexOf(
    "// Determine whether this staged setup has reached score/cycle eligibility.",
  );
  const qualificationEnd = botScanner.indexOf(
    "// Apply the conflict hard-block decision",
    qualificationStart,
  );
  const section = botScanner.slice(qualificationStart, qualificationEnd);
  assertStringIncludes(section, "ELIGIBLE");
  assert(
    !section.includes('status: "promoted"'),
    "The Watchlist row must not be resolved before downstream creation",
  );
  assertStringIncludes(botScanner, 'status: "qualified"');
});

Deno.test("pending and direct entries preserve the Watchlist identity", () => {
  assertStringIncludes(botScanner, "pendingLifecycleEvidence?.setupId");
  assertStringIncludes(botScanner, "pendingLifecycleEvidence?.candidateId");
  assertStringIncludes(botScanner, "watchlistLifecycle");
  assertStringIncludes(botScanner, "directLifecycleEvidence");
  assertStringIncludes(botScanner, "blocked_after_qualification");
});

Deno.test("the sole confirmation scanner uses the saved pending rule", () => {
  assertStringIncludes(
    fastScanner,
    "const legacyConfirmationMethod = resolvePendingConfirmationMethod(",
  );
  assertStringIncludes(
    fastScanner,
    "resolvePendingIndicatorMinimum(",
  );
  assertStringIncludes(botScanner, "confirmation_config:");
  assertStringIncludes(botScanner, "confirmation_method:");
});

Deno.test("active Zone Setup API includes awaiting-confirmation rows", () => {
  const actionStart = botScanner.indexOf(
    'if (action === "active_pending")',
  );
  const actionEnd = botScanner.indexOf(
    "// ── Pending Orders: Cancel",
    actionStart,
  );
  const section = botScanner.slice(actionStart, actionEnd);
  assertStringIncludes(
    section,
    '.in("status", ["pending", "awaiting_confirmation", "reconciliation_required"])',
  );
});

Deno.test("the five-minute scanner does not advance post-touch confirmation", () => {
  const monitorStart = botScanner.indexOf(
    "for (const pending of activePendingOrders)",
  );
  const monitorEnd = botScanner.indexOf(
    "// ── Management-Only Early Return",
    monitorStart,
  );
  const monitor = botScanner.slice(monitorStart, monitorEnd);
  assertStringIncludes(monitor, `if (pending.status !== "pending")`);
  assertStringIncludes(monitor, "pendingConfirmationHunting++");
  assert(
    !monitor.includes(`if (pending.status === "awaiting_confirmation")`),
    "The five-minute scanner must not duplicate CHoCH, retracement, or fill ownership",
  );
  assertStringIncludes(
    fastScanner,
    `.eq("status", "awaiting_confirmation")`,
  );
  assertStringIncludes(fastScanner, "post_confirmation_entry");
});

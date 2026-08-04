import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const botScanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const zoneScanner = await Deno.readTextFile(
  new URL("../../functions/zone-confirmation-scanner/index.ts", import.meta.url),
);
const scheduledTasks = await Deno.readTextFile(
  new URL("../../functions/scheduled-tasks/index.ts", import.meta.url),
);
const scheduledTasksPage = await Deno.readTextFile(
  new URL("../../../src/pages/ScheduledTasks.tsx", import.meta.url),
);

Deno.test("Phase 5B records source, authorization, and confirmation health", () => {
  assertStringIncludes(botScanner, "publishCandleSourceAlerts");
  assertStringIncludes(botScanner, "recordScannerAuthorizationFailure");
  assertStringIncludes(botScanner, "metaapi_certificate_failure");
  assertStringIncludes(botScanner, "last_confirmation_checked_at");

  assertStringIncludes(zoneScanner, "publishCandleSourceAlerts");
  assertStringIncludes(zoneScanner, "recordScannerAuthorizationFailure");
  assertStringIncludes(zoneScanner, "last_confirmation_checked_at");
});

Deno.test("Phase 5B exposes automatically evaluated alerts in Scheduled Tasks", () => {
  assertStringIncludes(
    scheduledTasks,
    "evaluate_scanner_operational_health",
  );
  assertStringIncludes(scheduledTasks, "scanner_operational_alerts");
  assertStringIncludes(scheduledTasksPage, "Operational alert");
  assertStringIncludes(
    scheduledTasksPage,
    "clear automatically after the underlying scanner condition recovers",
  );
});

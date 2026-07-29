import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const sql = await Deno.readTextFile(
  new URL(
    "../../migrations/20260729180000_add_scanner_operational_alerts.sql",
    import.meta.url,
  ),
);

Deno.test("Phase 5B migration installs deduplicated durable alerts", () => {
  assertStringIncludes(
    sql,
    "CREATE TABLE IF NOT EXISTS public.scanner_operational_alerts",
  );
  assertStringIncludes(sql, "idx_scanner_alerts_one_active");
  assertStringIncludes(sql, "WHERE status = 'active'");
  assertStringIncludes(sql, "upsert_scanner_operational_alert");
  assertStringIncludes(sql, "resolve_scanner_operational_alert");
});

Deno.test("Phase 5B health evaluation covers every agreed failure class", () => {
  for (
    const alertType of [
      "scanner_heartbeat_missing",
      "scan_incomplete",
      "metaapi_certificate_failure",
      "metaapi_connection_failure",
      "candle_source_exhaustion",
      "stuck_confirmation_order",
      "authorization_error",
      "migration_drift",
    ]
  ) {
    assertStringIncludes(sql, `'${alertType}'`);
  }
  assertStringIncludes(sql, "interval '12 minutes'");
  assertStringIncludes(sql, "interval '3 minutes'");
  assertStringIncludes(sql, "interval '10 minutes'");
});

Deno.test("Phase 5B evaluates health every minute without changing trading state", () => {
  assertStringIncludes(sql, "evaluate_scanner_operational_health");
  assertStringIncludes(sql, "'scanner-operational-health-1min'");
  assertStringIncludes(sql, "'* * * * *'");
  assertStringIncludes(sql, "last_confirmation_checked_at");
});

Deno.test("Phase 5B keeps internal failure evidence service-role only", () => {
  assertStringIncludes(
    sql,
    "REVOKE ALL ON public.scanner_authorization_failures FROM anon, authenticated",
  );
  assertStringIncludes(
    sql,
    "GRANT SELECT ON public.scanner_operational_alerts TO authenticated",
  );
});

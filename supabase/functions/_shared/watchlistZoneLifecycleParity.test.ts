import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(new URL(
  "../../migrations/20260804043000_align_watchlist_zone_live_lifecycle.sql",
  import.meta.url,
));
const scanner = await Deno.readTextFile(new URL("../bot-scanner/index.ts", import.meta.url));

Deno.test("live Watchlist remains pending until broker-confirmed position opens", () => {
  assertStringIncludes(migration, "CREATE TRIGGER zz_sync_staged_setup_from_live_position_state");
  assertStringIncludes(migration, "IF NEW.position_status = $s$open$s$");
  assertStringIncludes(migration, "status = $s$filled$s$");
  assertStringIncludes(migration, "status = $s$pending$s$");
  assertStringIncludes(migration, "Broker outcome requires reconciliation");
  assertStringIncludes(migration, "CREATE TRIGGER zz_hold_staged_setup_until_live_broker_confirmation");
  assertStringIncludes(migration, "v_position.position_status <> $s$open$s$");
});

Deno.test("new Zone Setup supersedes either active pending state", () => {
  const start = scanner.indexOf("const { data: stalePending }");
  const end = scanner.indexOf("// GUARD: reject pending orders", start);
  const section = scanner.slice(start, end);
  assertStringIncludes(section, `.in("status", ["pending", "awaiting_confirmation"])`);
  assertStringIncludes(section, `status: "cancelled"`);
});

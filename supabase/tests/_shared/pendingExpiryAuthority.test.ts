import { assert, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const root = new URL("../../", import.meta.url);
const migration = await Deno.readTextFile(new URL(
  "migrations/20260813020000_enforce_pending_expiry_at_fill.sql",
  root,
));
const scanner = await Deno.readTextFile(new URL(
  "functions/zone-confirmation-scanner/index.ts",
  root,
));

Deno.test("atomic pending fill rejects and resolves expired orders", () => {
  assertStringIncludes(migration, "v_pending.expires_at <= now()");
  assertStringIncludes(migration, "'code', 'order_expired'");
  assertStringIncludes(migration, "status = 'expired'");
  assert(
    migration.indexOf("v_pending.expires_at <= now()") <
      migration.indexOf("INSERT INTO public.paper_positions"),
  );
});

Deno.test("one-minute confirmation scanner expires before market-data work", () => {
  assertStringIncludes(scanner, "pending.expires_at");
  assertStringIncludes(scanner, "TTL expired before confirmation fill");
  assert(
    scanner.indexOf("pending.expires_at &&") <
      scanner.indexOf("const candles5m = await fetchCandles"),
  );
});

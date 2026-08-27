import {
  assert,
  assertFalse,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const confirmationScanner = await Deno.readTextFile(
  "./supabase/functions/zone-confirmation-scanner/index.ts",
);
const botScanner = await Deno.readTextFile(
  "./supabase/functions/bot-scanner/index.ts",
);
const migration = await Deno.readTextFile(
  "./supabase/migrations/20260826210000_align_impulse_lifecycle_saved_mode.sql",
);

Deno.test("pending setups retain their frozen impulse lifecycle mode", () => {
  assertStringIncludes(botScanner, "const frozenLifecycleMode =");
  assertStringIncludes(
    botScanner,
    "frozenContext?.impulseEntryLifecycleAvailability?.mode ||\n        \"observe\"",
  );
  assertStringIncludes(
    confirmationScanner,
    "const pendingLifecycleEnforced =",
  );
  assertStringIncludes(
    confirmationScanner,
    "const pendingLifecycleMode = lifecycleAfterLock?.mode",
  );
  assertStringIncludes(
    confirmationScanner,
    'const pendingLifecycleEnforced = pendingLifecycleMode === "enforce"',
  );
  assert(
    confirmationScanner.includes(
      'impulseLifecycleEnforcement.effectiveMode !== "enforce"',
    ) === false,
    "Current Bot Config must not retroactively change an existing pending setup's lifecycle route",
  );
});

Deno.test("atomic deeper-zone retarget trusts the frozen enforce mode rather than a stale certificate gate", () => {
  assertStringIncludes(migration, "v_authority.mode <> 'enforce'");
  assertStringIncludes(migration, "'authorizedBy', 'frozen_setup_config'");
  assertFalse(migration.includes("certificate_unavailable"));
  assertFalse(migration.includes("v_certificate"));
});

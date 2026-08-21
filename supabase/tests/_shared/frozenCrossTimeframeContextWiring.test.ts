import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const scanner = await Deno.readTextFile(
  "./supabase/functions/bot-scanner/index.ts",
);
const lifecycle = await Deno.readTextFile(
  "./supabase/functions/_shared/setupLifecycle.ts",
);
const migration = await Deno.readTextFile(
  "./supabase/migrations/20260802010000_add_frozen_cross_timeframe_context.sql",
);

Deno.test("scanner freezes cross-TF context on every setup construction path", () => {
  assertStringIncludes(scanner, "loadCurrentEvidenceCertificateReferences");
  assertStringIncludes(scanner, "buildFrozenCrossTimeframeContext");
  assertStringIncludes(
    scanner,
    "crossTimeframeContext: selectedCrossTimeframeContext(originatingZone)",
  );
  assertStringIncludes(
    scanner,
    "crossTimeframeContext: pendingFrozenCrossTimeframeContext",
  );
  assertStringIncludes(
    scanner,
    "crossTimeframeContext: selectedCrossTimeframeContext(directOriginatingZone)",
  );
  assertStringIncludes(
    scanner,
    "crossTimeframeContext: selectedCrossTimeframeContext(breakerOriginatingZone)",
  );
  assertStringIncludes(scanner, "canonicalImpulseMetrics:");
});

Deno.test("setup lifecycle owns the cross-TF context", () => {
  assertStringIncludes(
    lifecycle,
    "crossTimeframeContext?: FrozenCrossTimeframeContext | null",
  );
  assertStringIncludes(
    lifecycle,
    "crossTimeframeContext: input.crossTimeframeContext || null",
  );
});

Deno.test("database exposes generated provenance from immutable context", () => {
  assertStringIncludes(migration, "cross_tf_context_version");
  assertStringIncludes(migration, "cross_tf_timeframe_evidence_id");
  assertStringIncludes(migration, "cross_tf_relationship");
  assertStringIncludes(migration, "frozen-cross-tf-context.v1");
});

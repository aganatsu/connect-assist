import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

Deno.test("Watchlist updates never reference the later streamlined persistence variable", () => {
  const declaration = source.indexOf("const streamlinedStagedId =");
  assert(declaration > 0);
  const premature =
    source.slice(0, declaration).match(/streamlinedStagedId/g) || [];
  assertEquals(premature.length, 0);
  assertStringIncludes(
    source.slice(0, declaration),
    `.eq("id", existingStaged.id)`,
  );
});

Deno.test("below-threshold staged refreshes target the guarded existing row", () => {
  const start = source.indexOf(
    "// ── Setup Staging: Stage below-threshold setups that have potential ──",
  );
  const end = source.indexOf("// ── Final sync:", start);
  assert(start >= 0 && end > start);

  const section = source.slice(start, end);
  assertEquals(
    (section.match(/streamlinedStagedId/g) || []).length,
    0,
    "later staged refreshes cannot use the earlier scoped persistence id",
  );

  const refreshStart = section.indexOf("// Update existing staged setup");
  const insertStart = section.indexOf(
    "// Create new staged setup",
    refreshStart,
  );
  assert(refreshStart >= 0 && insertStart > refreshStart);
  assertStringIncludes(
    section.slice(refreshStart, insertStart),
    `}).eq("id", existingStaged.id);`,
  );

  const retainStart = section.indexOf(
    "if (existingStaged && analysis.score < watchThreshold && stagingEnabled)",
  );
  const retainEnd = section.indexOf("detail.staging = {", retainStart);
  assert(retainStart >= 0 && retainEnd > retainStart);
  assertStringIncludes(
    section.slice(retainStart, retainEnd),
    `}).eq("id", existingStaged.id).eq("user_id", userId);`,
  );
});

Deno.test("unified Watchlist persistence failure exposes its real error", () => {
  assertStringIncludes(
    source,
    `detail.status = "unified_watch_persist_failed"`,
  );
  assertStringIncludes(source, `detail.error = error.message`);
  assertStringIncludes(
    source,
    `detail.skipReason = "Watchlist persistence failed: " + error.message`,
  );
});

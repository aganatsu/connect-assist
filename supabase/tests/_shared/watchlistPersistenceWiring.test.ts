import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile(new URL("../../functions/bot-scanner/index.ts", import.meta.url));

Deno.test("Watchlist updates never reference the later streamlined persistence variable", () => {
  const declaration = source.indexOf("const streamlinedStagedId =");
  assert(declaration > 0);
  const premature = source.slice(0, declaration).match(/streamlinedStagedId/g) || [];
  assertEquals(premature.length, 0);
  assertStringIncludes(source.slice(0, declaration), `.eq("id", existingStaged.id)`);
});

Deno.test("below-threshold staged refreshes use their guarded row id", () => {
  const start = source.indexOf("// ── Setup Staging: Stage below-threshold setups that have potential ──");
  const end = source.indexOf("// ── Final sync:", start);
  assert(start >= 0 && end > start);

  const section = source.slice(start, end);
  assertEquals((section.match(/streamlinedStagedId/g) || []).length, 0);
  assertEquals((section.match(/\.eq\("id", existingStaged\.id\)/g) || []).length, 2);
});

Deno.test("unified Watchlist persistence failure exposes its real error", () => {
  assertStringIncludes(source, `detail.status = "unified_watch_persist_failed"`);
  assertStringIncludes(source, `detail.error = error.message`);
  assertStringIncludes(source, `detail.skipReason = "Watchlist persistence failed: " + error.message`);
});

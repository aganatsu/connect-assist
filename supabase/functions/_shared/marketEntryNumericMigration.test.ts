import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migrationUrl = new URL(
  "../../migrations/20260728213000_fix_market_entry_numeric_size.sql",
  import.meta.url,
);

Deno.test("market-entry RPC parses and validates numeric position size", async () => {
  const migration = await Deno.readTextFile(migrationUrl.pathname);

  assertStringIncludes(
    migration,
    "v_size_text TEXT := NULLIF(BTRIM(p_position->>'size'), '')",
  );
  assertStringIncludes(migration, "v_size := v_size_text::NUMERIC");
  assertStringIncludes(migration, "'code', 'invalid_size'");
  assertStringIncludes(migration, "v_size <= 0");
});

Deno.test("market-entry insert uses parsed numeric size", async () => {
  const migration = await Deno.readTextFile(migrationUrl.pathname);
  const insertStart = migration.indexOf(
    "INSERT INTO public.paper_positions",
  );
  const insertEnd = migration.indexOf(
    "RETURNING id INTO v_position_uuid",
    insertStart,
  );

  assert(insertStart >= 0 && insertEnd > insertStart);
  const insert = migration.slice(insertStart, insertEnd);
  assertStringIncludes(insert, "v_size,");
  assertEquals(
    insert.includes("p_position->>'size',"),
    false,
    "The NUMERIC size column must not receive raw JSON text",
  );
});

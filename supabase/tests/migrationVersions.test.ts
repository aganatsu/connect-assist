import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Migration filenames must have unique version prefixes.
 *
 * Supabase records applied migrations in supabase_migrations.schema_migrations
 * keyed on the VERSION ALONE — the name after it is a label. So two files
 * sharing a prefix are one migration as far as Postgres is concerned: the
 * second is skipped, silently, with nothing in any log.
 *
 * That happened on 2026-09-15. 20260915120000_direction_blocked_rejection_type
 * collided with 20260915120000_frozen_decision_hash_trigger, and the CHECK
 * constraint it adds never landed. It was only caught because the code that
 * depended on it swallows insert errors, so the symptom was an empty table —
 * indistinguishable from "the thing being measured never happens", which is
 * the failure this repo has hit repeatedly.
 *
 * The collision is invisible in a directory listing sorted by name: the two
 * files sit adjacent and look like a sequence.
 */

const DIR = new URL("../migrations/", import.meta.url);

function migrations() {
  return [...Deno.readDirSync(DIR)]
    .filter((e) => e.isFile && e.name.endsWith(".sql"))
    .map((e) => ({ name: e.name, version: e.name.slice(0, 14) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

Deno.test("no two migrations share a version", () => {
  const seen = new Map<string, string>();
  const collisions: string[] = [];
  for (const m of migrations()) {
    const prior = seen.get(m.version);
    if (prior) collisions.push(`${m.version}: ${prior} and ${m.name}`);
    else seen.set(m.version, m.name);
  }
  assertEquals(collisions, [], `colliding versions — the later file will never run:\n${collisions.join("\n")}`);
});

Deno.test("every migration is named <14-digit version>_<description>.sql", () => {
  // A short or malformed prefix silently truncates to a different version.
  for (const m of migrations()) {
    assert(/^\d{14}_[a-z0-9_]+\.sql$/.test(m.name), `${m.name} does not match the convention`);
  }
});

Deno.test("the baseline sorts first", () => {
  // It creates every table the others alter. Postgres applies in version
  // order, so a migration dated before it would run against nothing.
  const all = migrations();
  assert(all.length > 0);
  assertEquals(all[0].name, "20260914000000_baseline_schema.sql");
});

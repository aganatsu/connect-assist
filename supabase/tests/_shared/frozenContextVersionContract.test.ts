import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildFrozenDecision } from "../../functions/_shared/frozenDecision.ts";

/**
 * The contractVersion the code writes must be one the database accepts.
 *
 * freeze_setup_strategy_context() fires BEFORE INSERT on pending_orders,
 * paper_positions AND staged_setups, and RAISEs on any contractVersion outside
 * its allowlist. PR #539 started writing frozen-decision.v1 into a column whose
 * trigger only knew the two setup-policy versions, so from deploy every
 * qualifying setup and every market entry was refused at the final step:
 *
 *   ERROR: unsupported frozen strategy context version: frozen-decision.v1
 *
 * Nothing surfaced as an outage. bot-scanner logs zone_setup_insert_failed and
 * continues, so it looked like a quiet market rather than a broken writer.
 *
 * This test reads the version out of the builder and checks it against the
 * allowlist in the migrations, so the two cannot drift apart again.
 */

function allowlistFromMigrations(): string[] {
  const dir = new URL("../../migrations/", import.meta.url);
  const files = [...Deno.readDirSync(dir)]
    .filter((e) => e.isFile && e.name.endsWith(".sql"))
    .map((e) => e.name)
    .sort();                              // version order; last definition wins
  let versions: string[] = [];
  for (const f of files) {
    const sql = Deno.readTextFileSync(new URL(f, dir));
    const i = sql.indexOf("v_version IS NULL OR v_version NOT IN");
    if (i === -1) continue;
    const block = sql.slice(i, sql.indexOf(") THEN", i));
    versions = [...block.matchAll(/'([a-z0-9.\-]+)'/gi)].map((m) => m[1]);
  }
  return versions;
}

Deno.test("the builder's version is accepted by the trigger", () => {
  const allowed = allowlistFromMigrations();
  assert(allowed.length > 0, "found the allowlist in the migrations");
  const version = buildFrozenDecision({ route: "manual" }).contractVersion;
  assert(
    allowed.includes(version),
    `buildFrozenDecision emits "${version}" but the trigger accepts only ` +
      `[${allowed.join(", ")}] — every insert carrying it will be REJECTED`,
  );
});

Deno.test("the setup-policy shape checks do not apply to it", () => {
  // frozen-decision.v1 has no stylePolicy, setupId, candidateId or
  // confirmation block. If the trigger measured it against those it would pass
  // the version check and then fail on "frozen strategy context is incomplete"
  // — the same outage with a different message.
  const dir = new URL("../../migrations/", import.meta.url);
  const files = [...Deno.readDirSync(dir)]
    .filter((e) => e.isFile && e.name.endsWith(".sql")).map((e) => e.name).sort();
  const latest = files.reverse().find((f) =>
    Deno.readTextFileSync(new URL(f, dir)).includes("frozen strategy context is incomplete")
  );
  assert(latest, "found the shape-check definition");
  const sql = Deno.readTextFileSync(new URL(latest!, dir));
  assert(/v_version LIKE 'setup-policy-freeze\.%' AND \(/.test(sql),
    "the shape checks are scoped to the setup-policy versions");

  const d = buildFrozenDecision({ route: "manual" }) as any;
  for (const f of ["stylePolicy", "setupId", "candidateId", "confirmation"]) {
    assert(d[f] === undefined, `frozen-decision.v1 has no ${f}, by design`);
  }
});

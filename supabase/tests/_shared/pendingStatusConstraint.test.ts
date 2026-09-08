import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * pending_orders.status was created with
 *
 *   CHECK (status IN ('pending','filled','expired','cancelled','invalidated'))
 *
 * The zone-confirmation feature shipped a month later and writes a sixth
 * value, 'awaiting_confirmation', which no migration ever added. Every zone
 * touch has therefore been rejected by the database:
 *
 *   update pending_orders set
 *     status = 'awaiting_confirmation',
 *     zone_touch_time = now(),
 *     confirmation_attempts = 0
 *
 * The whole statement fails, so the order stays 'pending' AND zone_touch_time
 * never persists. zone-confirmation-scanner selects on
 * status = 'awaiting_confirmation' and finds nothing, forever.
 *
 * Measured 2026-09-07: 31 orders over 48 hours, 0 filled, confirmation_attempts
 * 0 on every one — while 110 evaluations that day had price inside a zone.
 *
 * This test is the guard the schema never had: every status the code writes
 * must be a status the table accepts.
 */

const migrationsDir = new URL("../../migrations/", import.meta.url);

async function readAll(dir: URL): Promise<string> {
  let out = "";
  for await (const e of Deno.readDir(dir)) {
    if (e.isFile && e.name.endsWith(".sql")) {
      out += await Deno.readTextFile(new URL(e.name, dir)) + "\n";
    }
  }
  return out;
}
const migrations = await readAll(migrationsDir);

const fnFiles = [
  "bot-scanner/index.ts",
  "zone-confirmation-scanner/index.ts",
  "paper-trading/index.ts",
];
let fnSrc = "";
for (const f of fnFiles) {
  try {
    fnSrc += await Deno.readTextFile(new URL(`../../functions/${f}`, import.meta.url)) + "\n";
  } catch { /* function may not exist */ }
}

/** The last CHECK applied to pending_orders.status wins. */
function allowedStatuses(): string[] {
  const matches = [...migrations.matchAll(
    /pending_orders_status_check\s*\n?\s*CHECK \(status IN \(([\s\S]*?)\)\)/g,
  )];
  const inline = [...migrations.matchAll(
    /status TEXT NOT NULL DEFAULT 'pending'[\s\S]{0,60}CHECK \(status IN \(([\s\S]*?)\)\)/g,
  )];
  const src = matches.length > 0 ? matches[matches.length - 1][1] : inline[inline.length - 1][1];
  return [...src.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
}

Deno.test("the constraint now permits awaiting_confirmation", () => {
  const allowed = allowedStatuses();
  assert(allowed.includes("awaiting_confirmation"),
    `awaiting_confirmation missing from [${allowed.join(", ")}]`);
});

Deno.test("every status the code writes is a status the table accepts", () => {
  // The guard that would have caught this on the day the feature shipped.
  const written = new Set(
    [...fnSrc.matchAll(/from\("pending_orders"\)[\s\S]{0,400}?status: "([a-z_]+)"/g)]
      .map(m => m[1]),
  );
  assert(written.size > 0, "found no status writes — the regex has drifted");
  const allowed = allowedStatuses();
  for (const s of written) {
    assert(allowed.includes(s), `code writes status "${s}" which the CHECK rejects`);
  }
});

Deno.test("no status the live schema had is dropped by the rewrite", () => {
  // Widening must not narrow. The first version of this migration DID narrow:
  // it was written from the migrations folder, which is not the schema, and
  // silently removed reconciliation_required and broker_rejected — values the
  // live database had and the repo had no record of, because the 2026-09-01
  // revert deleted the migration files that added them.
  const allowed = allowedStatuses();
  const liveBefore = [
    "pending", "awaiting_confirmation", "filled", "reconciliation_required",
    "broker_rejected", "invalidated", "expired", "cancelled",
  ];
  for (const s of liveBefore) {
    assert(allowed.includes(s), `${s} existed in the live constraint and was dropped`);
  }
});

Deno.test("the migration drops the old constraint before adding the new one", () => {
  // ADD CONSTRAINT alone would fail on an existing database.
  const i = migrations.indexOf("DROP CONSTRAINT IF EXISTS pending_orders_status_check");
  const j = migrations.indexOf("ADD CONSTRAINT pending_orders_status_check");
  assert(i > -1, "missing DROP");
  assert(j > i, "DROP must precede ADD");
});

Deno.test("the lifecycle is documented on the column itself", () => {
  // So the next person adding a state sees the constraint before the outage.
  assert(/COMMENT ON COLUMN public\.pending_orders\.status/.test(migrations));
  // The comment must warn off the two values that were dropped once already.
  assertEquals(
    /reconciliation_required and broker_rejected come from the broker sync path/.test(migrations),
    true,
  );
});

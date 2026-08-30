import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveLinkedImpulseLifecycleTerminal,
} from "../../functions/_shared/impulseEntryLifecycleStore.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, root));

Deno.test("zone confirmation observes candidate failure before legacy cancellation", async () => {
  const scanner = await read(
    "supabase/functions/zone-confirmation-scanner/index.ts",
  );
  assertStringIncludes(scanner, "advanceStoredTradeLifecycle(");
  assertStringIncludes(
    scanner,
    'transition.event?.type === "candidate_failed"',
  );
  assertStringIncludes(scanner, "impulse_entry_lifecycle_id");
  const store = await read(
    "supabase/functions/_shared/impulseEntryLifecycleStore.ts",
  );
  assertStringIncludes(store, "advanceTradeLifecycle");
  assertStringIncludes(store, "impulse_invalidated");
});

Deno.test("linked active rows outrank stale terminal rows", () => {
  assertEquals(
    resolveLinkedImpulseLifecycleTerminal({
      pendingOrders: [
        { status: "cancelled", cancel_reason: "old route" },
        { status: "pending" },
      ],
      stagedSetups: [{ status: "invalidated" }],
    }),
    null,
  );
});

Deno.test("linked terminal precedence preserves a real fill", () => {
  assertEquals(
    resolveLinkedImpulseLifecycleTerminal({
      pendingOrders: [
        { status: "cancelled", cancel_reason: "superseded" },
        { status: "filled", resolved_at: "2026-08-30T12:00:00.000Z" },
      ],
    }),
    {
      status: "entered",
      reason: "Linked pending order resolved as filled",
      resolvedAt: "2026-08-30T12:00:00.000Z",
      source: "pending_order",
    },
  );
});

Deno.test("the existing lifecycle monitor reconciles linked terminal setup rows", async () => {
  const [monitor, lifecycle, migration] = await Promise.all([
    read("supabase/functions/impulse-lifecycle-replay/index.ts"),
    read("supabase/functions/_shared/impulseEntryLifecycleStore.ts"),
    read(
      "supabase/migrations/20260830190000_sync_terminal_impulse_lifecycles.sql",
    ),
  ]);
  assertStringIncludes(monitor, 'from("pending_orders")');
  assertStringIncludes(monitor, 'from("staged_setups")');
  assertStringIncludes(monitor, "resolveLinkedImpulseLifecycleTerminal");
  assertStringIncludes(monitor, "resolveStoredImpulseEntryLifecycle");
  assertStringIncludes(lifecycle, 'type: "setup_resolved"');
  assertStringIncludes(migration, "'cancelled'");
  assertStringIncludes(migration, "'setup_resolved'");
});

Deno.test("terminal lifecycle migration preserves every earlier transition event", async () => {
  const [terminalMigration, repairMigration, lifecycleSource] = await Promise.all([
    read(
      "supabase/migrations/20260830190000_sync_terminal_impulse_lifecycles.sql",
    ),
    read(
      "supabase/migrations/20260830200000_preserve_impulse_lifecycle_event_contract.sql",
    ),
    read("supabase/functions/_shared/impulseEntryLifecycle.ts"),
  ]);
  const eventUnion = lifecycleSource.slice(
    lifecycleSource.indexOf("export type ImpulseEntryLifecycleEvent ="),
    lifecycleSource.indexOf("export function transitionImpulseEntryLifecycle"),
  );
  const supportedEvents = [
    "created",
    ...new Set(
      [...eventUnion.matchAll(/type: "([^"]+)"/g)].map((match) => match[1]),
    ),
  ];

  for (const eventType of supportedEvents) {
    assertStringIncludes(terminalMigration, `'${eventType}'`);
    assertStringIncludes(repairMigration, `'${eventType}'`);
  }
});

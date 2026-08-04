import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { shouldCreatePendingZoneOrder } from "../../functions/_shared/botConfigBehavior.ts";

Deno.test("Pending Zone Orders: disabled cannot be overridden by hard-zone routing", () => {
  assertEquals(
    shouldCreatePendingZoneOrder({
      pendingZoneOrdersEnabled: false,
      useMarketFillAtZone: false,
      hasLimitEntry: true,
    }),
    false,
  );
});

Deno.test("Pending Zone Orders: enabled creates a pending order only when market fill is not used", () => {
  assertEquals(
    shouldCreatePendingZoneOrder({
      pendingZoneOrdersEnabled: true,
      useMarketFillAtZone: false,
      hasLimitEntry: true,
    }),
    true,
  );
  assertEquals(
    shouldCreatePendingZoneOrder({
      pendingZoneOrdersEnabled: true,
      useMarketFillAtZone: true,
      hasLimitEntry: true,
    }),
    false,
  );
});

Deno.test("Pending Zone Orders: no valid entry price cannot create an order", () => {
  assertEquals(
    shouldCreatePendingZoneOrder({
      pendingZoneOrdersEnabled: true,
      useMarketFillAtZone: false,
      hasLimitEntry: false,
    }),
    false,
  );
});

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveFrozenNestedPoiMarketRoute,
  resolveNestedPoiMarketActivation,
  shouldCreatePendingZoneOrder,
} from "../../functions/_shared/botConfigBehavior.ts";

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

Deno.test("Nested POI Market Trigger stays disabled unless Market Fill is enabled", () => {
  assertEquals(
    resolveNestedPoiMarketActivation({
      marketFillAtZone: false,
      mode: "enforce_live",
      runtimeTarget: "live",
    }),
    {
      mode: "enforce_live",
      enabled: false,
      observing: false,
      enforced: false,
      route: "legacy",
      runtimeTarget: "live",
    },
  );
});

Deno.test("Nested POI rollout keeps observe, paper, and paper-plus-live scopes distinct", () => {
  assertEquals(
    resolveNestedPoiMarketActivation({
      marketFillAtZone: true,
      mode: "observe",
      runtimeTarget: "paper",
    }).enforced,
    false,
  );
  assertEquals(
    resolveNestedPoiMarketActivation({
      marketFillAtZone: true,
      mode: "enforce_paper",
      runtimeTarget: "paper",
    }).enforced,
    true,
  );
  assertEquals(
    resolveNestedPoiMarketActivation({
      marketFillAtZone: true,
      mode: "enforce_paper",
      runtimeTarget: "live",
    }).enforced,
    false,
  );
  assertEquals(
    resolveNestedPoiMarketActivation({
      marketFillAtZone: true,
      mode: "enforce_live",
      runtimeTarget: "paper",
    }).enforced,
    true,
  );
  assertEquals(
    resolveNestedPoiMarketActivation({
      marketFillAtZone: true,
      mode: "enforce_live",
      runtimeTarget: "live",
    }).enforced,
    true,
  );
});

Deno.test("Nested POI activation freezes live paper-only mode as observation", () => {
  const activation = resolveNestedPoiMarketActivation({
    marketFillAtZone: true,
    mode: "enforce_paper",
    runtimeTarget: "live",
  });

  assertEquals(activation.route, "observe");
  assertEquals(activation.observing, true);
  assertEquals(activation.enforced, false);
});

Deno.test("frozen observation route never upgrades after target changes", () => {
  assertEquals(
    resolveFrozenNestedPoiMarketRoute({
      mode: "enforce_paper",
      route: "observe",
      runtimeTarget: "paper",
    }),
    {
      mode: "enforce_paper",
      route: "observe",
      observing: true,
      enforced: false,
      runtimeTargetMismatch: false,
    },
  );
});

Deno.test("frozen route resolver rejects impossible requested-mode combinations", () => {
  assertEquals(
    resolveFrozenNestedPoiMarketRoute({
      mode: "observe",
      route: "nested_poi_market",
      runtimeTarget: "paper",
    }),
    {
      mode: "observe",
      route: null,
      observing: false,
      enforced: false,
      runtimeTargetMismatch: false,
    },
  );
});

Deno.test("paper-only executable route fails closed after switching live", () => {
  assertEquals(
    resolveFrozenNestedPoiMarketRoute({
      mode: "enforce_paper",
      route: "nested_poi_market",
      runtimeTarget: "live",
    }),
    {
      mode: "enforce_paper",
      route: "nested_poi_market",
      observing: false,
      enforced: false,
      runtimeTargetMismatch: true,
    },
  );
});

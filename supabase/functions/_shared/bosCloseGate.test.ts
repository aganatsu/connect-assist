import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { bosCloseGate, resolveMinBosClose } from "./bosCloseGate.ts";
import { mapNestedToFlat, RUNTIME_DEFAULTS } from "./configMapper.ts";

Deno.test("config: percent → fraction; absent / junk / 0 is off; capped at 100", () => {
  assertEquals(resolveMinBosClose(70), 0.7);
  assertEquals(resolveMinBosClose("70"), 0.7);
  assertEquals(resolveMinBosClose(undefined), 0);
  assertEquals(resolveMinBosClose(null), 0);
  assertEquals(resolveMinBosClose("abc"), 0);
  assertEquals(resolveMinBosClose(0), 0);
  assertEquals(resolveMinBosClose(-5), 0);
  assertEquals(resolveMinBosClose(150), 1);
});

Deno.test("gate at 70%: the owner's USD/JPY setup (BOS 51%) is blocked; 70% and above pass", () => {
  assertEquals(bosCloseGate(0.51, 0.7).pass, false);
  assertEquals(bosCloseGate(0.51, 0.7).reason, "BOS close 51% < 70% — break candle closed weakly");
  assertEquals(bosCloseGate(0.7, 0.7).pass, true);
  assertEquals(bosCloseGate(0.97, 0.7).pass, true);
});

Deno.test("off (0) never blocks; an unmeasured leg is not blocked and says so", () => {
  assertEquals(bosCloseGate(0.1, 0).pass, true);
  const v = bosCloseGate(null, 0.7);
  assertEquals([v.pass, v.measured], [true, false]);
});

Deno.test("configMapper: strategy.minBosCloseStrength reaches the runtime config; default 0 (off)", () => {
  assertEquals((RUNTIME_DEFAULTS as Record<string, unknown>).minBosCloseStrength, 0);
  assertEquals((mapNestedToFlat({ strategy: { minBosCloseStrength: 70 } }) as Record<string, unknown>).minBosCloseStrength, 70);
  assertEquals((mapNestedToFlat({}) as Record<string, unknown>).minBosCloseStrength, 0);
});

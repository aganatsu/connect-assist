import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fridayCutoffGate, minutesToFridayClose, resolveFridayCutoffMinutes } from "./fridayCutoff.ts";

const utc = (s: string) => Date.parse(s);

Deno.test("resolveFridayCutoffMinutes: off unless a positive number", () => {
  for (const v of [undefined, null, "", "abc", 0, -5]) assertEquals(resolveFridayCutoffMinutes(v), 0);
  assertEquals(resolveFridayCutoffMinutes(60), 60);
  assertEquals(resolveFridayCutoffMinutes("90"), 90);
  assertEquals(resolveFridayCutoffMinutes(5000), 600);
});

Deno.test("minutesToFridayClose: Friday 17:00 New York, DST-aware", () => {
  // Nov 13 2026 is a Friday, EST (UTC-5): close = 22:00 UTC
  assertEquals(minutesToFridayClose(utc("2026-11-13T21:25:00Z")), 35);
  assertEquals(minutesToFridayClose(utc("2026-11-13T21:55:00Z")), 5);
  assertEquals(minutesToFridayClose(utc("2026-11-13T22:00:00Z")), null); // closed
  assertEquals(minutesToFridayClose(utc("2026-11-12T21:25:00Z")), null); // Thursday
  // Jul 10 2026 is a Friday, EDT (UTC-4): close = 21:00 UTC
  assertEquals(minutesToFridayClose(utc("2026-07-10T20:00:00Z")), 60);
});

Deno.test("fridayCutoffGate: the USD/CAD 2026-11-13 entries are blocked with a 60-minute cutoff", () => {
  assertEquals(fridayCutoffGate(utc("2026-11-13T21:25:00Z"), 60, false).pass, false);
  assertEquals(fridayCutoffGate(utc("2026-11-13T21:55:00Z"), 60, false).pass, false);
  assertEquals(fridayCutoffGate(utc("2026-11-13T20:30:00Z"), 60, false).pass, true); // 90 min before
});

Deno.test("fridayCutoffGate: off by default, and never applies to crypto", () => {
  assertEquals(fridayCutoffGate(utc("2026-11-13T21:55:00Z"), 0, false).pass, true);
  assertEquals(fridayCutoffGate(utc("2026-11-13T21:55:00Z"), 60, true).pass, true);
});

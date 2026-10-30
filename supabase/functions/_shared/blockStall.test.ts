import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { classifyScan, nextStall, stallMessage, STALL_MAX_STEP_MINUTES, type ScanBlock } from "./blockStall.ts";

const six = (status: string, reason = "") => ["EUR/USD", "GBP/USD", "USD/JPY", "CHF/JPY", "NZD/CAD", "NZD/CHF"].map((pair) => ({ pair, status, skipReason: reason }));

Deno.test("classifyScan: the 10-28 bug — six pairs, all skipped_require_unified, is blocked", () => {
  const b = classifyScan([{ scan_cycle_id: "x" } as never, ...six("skipped_require_unified", "Require Unified Zone: …")]);
  assertEquals(b.kind, "blocked");
  assertEquals((b as Extract<ScanBlock, { kind: "blocked" }>).pairs, 6);
});

Deno.test("classifyScan: market closed and session-off scans are benign", () => {
  assertEquals(classifyScan(six("skipped").map((d) => ({ ...d, skipReason: undefined, reason: "FX market closed (weekend)" }))).kind, "benign");
  assertEquals(classifyScan(six("skipped").map((d) => ({ ...d, skipReason: undefined, reason: "Asian session not enabled for EUR/USD" }))).kind, "benign");
  assertEquals(classifyScan([]).kind, "benign");
});

Deno.test("classifyScan: waiting at zones or mixed reasons is healthy", () => {
  assertEquals(classifyScan(six("watching_zone")).kind, "healthy");
  assertEquals(classifyScan([...six("skipped_require_unified").slice(0, 5), { pair: "NZD/CHF", status: "staged_watching" }]).kind, "healthy");
  assertEquals(classifyScan([...six("skipped_require_unified").slice(0, 5), { pair: "NZD/CHF", status: "skipped_no_impulse_zone" }]).kind, "healthy");
});

Deno.test("classifyScan: generic statuses split by reason, numbers ignored", () => {
  const a = classifyScan(six("rejected", "Score 3.5 < 4")); const b = classifyScan(six("rejected", "Score 2.0 < 4"));
  assertEquals(a.kind, "blocked"); assertEquals((a as never as { key: string }).key, (b as never as { key: string }).key);
  const mixed = classifyScan([...six("rejected", "Score 3.5 < 4").slice(0, 3), ...six("rejected", "Daily loss limit").slice(3)]);
  assertEquals(mixed.kind, "healthy");
});

Deno.test("nextStall: accumulates capped market time and notifies once at 6h", () => {
  const block = classifyScan(six("skipped_require_unified")) as Extract<ScanBlock, { kind: "blocked" }>;
  const t0 = new Date("2026-10-28T17:00:00Z");
  let s = nextStall(null, block, t0);
  assertEquals(s.blockedMinutes, 0); assertEquals(s.shouldNotify, false);
  let prev = { dedupe_key: block.key, last_detected_at: t0.toISOString(), evidence: s.evidence as Record<string, unknown> };
  let t = t0;
  for (let i = 0; i < 71; i++) {                          // 71 × 5 min = 355 min
    t = new Date(t.getTime() + 5 * 60000); s = nextStall(prev, block, t);
    assertEquals(s.shouldNotify, false);
    prev = { dedupe_key: block.key, last_detected_at: t.toISOString(), evidence: s.evidence as Record<string, unknown> };
  }
  t = new Date(t.getTime() + 5 * 60000); s = nextStall(prev, block, t);
  assertEquals(s.blockedMinutes, 360); assertEquals(s.shouldNotify, true);
  prev = { dedupe_key: block.key, last_detected_at: t.toISOString(), evidence: s.evidence as Record<string, unknown> };
  s = nextStall(prev, block, new Date(t.getTime() + 5 * 60000));
  assertEquals(s.shouldNotify, false);                   // already notified
});

Deno.test("nextStall: a weekend gap counts at most the step cap; a new reason restarts", () => {
  const block = classifyScan(six("skipped_require_unified")) as Extract<ScanBlock, { kind: "blocked" }>;
  const prev = { dedupe_key: block.key, last_detected_at: "2026-10-30T20:55:00Z", evidence: { blocked_minutes: 60 } };
  assertEquals(nextStall(prev, block, new Date("2026-11-01T22:00:00Z")).blockedMinutes, 60 + STALL_MAX_STEP_MINUTES);
  const other = classifyScan(six("market_entry_disabled")) as Extract<ScanBlock, { kind: "blocked" }>;
  assertEquals(nextStall(prev, other, new Date("2026-10-30T21:00:00Z")).blockedMinutes, 0);
});

Deno.test("stallMessage: names the reason and the setting to check", () => {
  const block = classifyScan(six("skipped_require_unified", "Require Unified Zone: unified zone engine did not reach triggered/confirmed state")) as Extract<ScanBlock, { kind: "blocked" }>;
  const m = stallMessage(block, 360);
  assertEquals(m.includes("all 6 pairs skipped for 6.0h"), true);
  assertEquals(m.includes("Require Unified Zone Confirmation"), true);
});

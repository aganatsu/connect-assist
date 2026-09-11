import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyPairOverrides, RUNTIME_DEFAULTS } from "../../functions/_shared/configMapper.ts";

/**
 * The static stop floor was a code constant, so tuning it needed a deploy.
 * That is how XAU/USD sat at 50 pips — $0.50 on a $4,400 instrument, 0.011%
 * of price, against forex floors of 0.16–0.31% — until 2026-09-03. After the
 * raise to 700 gold went to +$485 at 52.9% in Era C, the best non-forex
 * symbol on the book.
 *
 * BTC/USD is the same shape and still unfixed. Era C: 19 trades, 26.3% win
 * against a 33.3% break-even at 2:1, -$2,194 — the only losing symbol of
 * eight, and the whole of the net loss. Its stop sits on the 150-pip floor
 * every time, because the "dynamic" ATR layer is computed on the 5m ENTRY
 * timeframe: 1.5 x 5m ATR measured 118.6 pips, below the static, so it never
 * binds. The 15m equivalent measured ~194.
 *
 * This does NOT raise BTC. Widening the stop would only help if those
 * stop-outs are noise rather than genuine invalidation, and nothing in
 * paper_trade_history records excursion, so that is unproven. What ships is
 * the ability to change it in seconds and measure the result — slFloor now
 * rides on each trade rather than living only in scan_logs.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const modal = await Deno.readTextFile(
  new URL("../../../src/components/BotConfigModal.tsx", import.meta.url),
);

const cfg = (overrides: Record<string, unknown>) =>
  applyPairOverrides(
    { ...RUNTIME_DEFAULTS, pairGateOverrides: { "BTC/USD": overrides } } as never,
    "BTC/USD",
  ) as unknown as Record<string, unknown>;

Deno.test("an override reaches the config for that pair only", () => {
  assertEquals(cfg({ minStopPips: 194 }).minStopPips, 194);
  const untouched = applyPairOverrides(
    { ...RUNTIME_DEFAULTS, pairGateOverrides: { "BTC/USD": { minStopPips: 194 } } } as never,
    "EUR/USD",
  ) as unknown as Record<string, unknown>;
  assertEquals(untouched.minStopPips, undefined, "EUR/USD must not inherit BTC's floor");
});

Deno.test("no override leaves the constant in charge", () => {
  assertEquals(cfg({ minTier1Factors: 4 }).minStopPips, undefined);
});

/** The resolver, mirroring bot-scanner. */
const resolve = (override: unknown, constant: number) =>
  (typeof override === "number" && Number.isFinite(override) && override > 0) ? override : constant;

Deno.test("the resolver rejects values that would silently disable the floor", () => {
  // jsonb_set stores "194" as a string and it flows straight into arithmetic —
  // the same silent-failure trap zoneEntryDepth has. A bad value must fall
  // back to the constant, never to zero.
  assertEquals(resolve(194, 150), 194);
  assertEquals(resolve("194", 150), 150, "a string must not be trusted");
  assertEquals(resolve(0, 150), 150, "zero would remove the floor entirely");
  assertEquals(resolve(-5, 150), 150);
  assertEquals(resolve(NaN, 150), 150);
  assertEquals(resolve(undefined, 150), 150);
  assertEquals(resolve(null, 150), 150);
});

Deno.test("every floor call site honours the override, including the cap", () => {
  // Four sites read this. The impulse SL cap is expressed as a MULTIPLE of the
  // floor, so leaving it on the constant would reject stops the raised floor
  // had just widened — a pair could be given more room and then blocked for
  // using it.
  assertEquals(
    (scanner.match(/resolveStaticFloorPips\(pairConfig, pair\)/g) ?? []).length, 4,
    "market entry, zone route, impulse SL cap, and the shadow instrumentation",
  );
  // The constant may survive in exactly one place — the resolver's own
  // fallback. Anywhere else is a call site that would ignore the override.
  const direct = (scanner.match(/MIN_SL_PIPS\[pair\] \?\? 15/g) ?? []).length;
  assertEquals(direct, 1, "the constant may only be read inside resolveStaticFloorPips");
  const fn = scanner.indexOf("function resolveStaticFloorPips");
  const fnEnd = scanner.indexOf("\n}", fn);
  assert(
    scanner.slice(fn, fnEnd).includes("MIN_SL_PIPS[pair] ?? 15"),
    "and that one read must be the resolver's fallback",
  );
  assert(
    /maxSlPips: resolveStaticFloorPips\(pairConfig, pair\) \* \(pairConfig\.impulseSlCapMultiplier/.test(scanner),
    "the cap must scale with the floor",
  );
});

Deno.test("the floor decision is recorded on the trade, not only the scan", () => {
  // slFloorTrace existed but only reached detail.slFloor, which lands in
  // scan_logs. There was no way to join a trade to whether its stop was
  // floor-bound — the exact question BTC raises.
  assertEquals(
    (scanner.match(/slFloor: slFloorTrace,/g) ?? []).length, 2,
    "both entry routes: the pending order and the market entry",
  );
  const i = scanner.indexOf("const slFloorTrace = {");
  const block = scanner.slice(i, i + 500);
  for (const f of ["staticMinSlPips", "atrFloorPips", "effectiveMinSlPips", "actualSlPips", "widened"]) {
    assert(new RegExp(`${f}[,:]`).test(block), `must record ${f}`);
  }
});

Deno.test("the UI exposes it per pair and says why BTC is the case", () => {
  const i = modal.indexOf("'minStopPips'");
  assert(i > -1, "must appear in the per-pair override fields");
  const block = modal.slice(i, i + 420);
  assert(/MIN_SL_PIPS/.test(block), "name the constant it overrides");
  assert(/118\.6/.test(block) && /194/.test(block), "and the measurement that motivates it");
});

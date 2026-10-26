import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import * as SM from "../../../functions/_shared/smcAnalysis.ts";
import * as IZ from "../../../functions/_shared/impulseZoneEngine.ts";
import { bestZoneWithLeg, detectFVGsFull, mapImpulsePOIsFull, PRICE_AT_ZONE_ATR_MULT, PRICE_AT_ZONE_STRICT_ATR_MULT } from "../../../functions/_shared/iov3/zones.ts";

/** The Impulse-on-V3 zone layer equals production wherever it should (research gates G1 / G1b, on synthetic data). */

// deterministic swinging 1H and 5m candles
function candles(n: number, seed: number, stepMs: number, period: number, amp: number) {
  let s = seed, p = 1.1; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = p, c = o + Math.sin(i / period) * amp + (rnd() - 0.5) * amp * 1.5;
    out.push({ datetime: new Date(Date.parse("2025-06-02T00:00:00Z") + i * stepMs).toISOString(), open: +o.toFixed(5), high: +(Math.max(o, c) + rnd() * amp * 0.4).toFixed(5), low: +(Math.min(o, c) - rnd() * amp * 0.4).toFixed(5), close: +c.toFixed(5) });
    p = c;
  }
  return out;
}
const H1 = candles(3000, 3, 3_600_000, 6, 0.0012), M5 = candles(3000, 5, 300_000, 9, 0.0004);
const strip = (xs: { quality?: unknown }[]) => xs.map(({ quality: _q, ...r }) => r);
let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

Deno.test("zones: restated PRICE_AT_ZONE constants equal production's (impulseZoneEngine.ts)", () => {
  const src = Deno.readTextFileSync(new URL("../../../functions/_shared/impulseZoneEngine.ts", import.meta.url));
  assert(src.includes(`const PRICE_AT_ZONE_ATR_MULT = ${PRICE_AT_ZONE_ATR_MULT};`));
  assert(src.includes(`const PRICE_AT_ZONE_STRICT_ATR_MULT = ${PRICE_AT_ZONE_STRICT_ATR_MULT};`));
});

Deno.test("G1: bestZoneWithLeg given production's own leg == findBestEntryZone (steps 2–7 identical)", () => {
  let n = 0, zones = 0;
  for (let i = 320; i < H1.length; i += 23) {
    const htf = H1.slice(i - 299, i + 1), ent = M5.slice(Math.max(0, (i % 2700) - 299), (i % 2700) + 1), price = htf[htf.length - 1].close;
    for (const dir of ["bullish", "bearish"] as const) {
      const prod = IZ.findBestEntryZone(htf, ent, dir, price, undefined, { fibMaxRetracement: 1, pipSize: 0.0001 });
      const leg = IZ.findImpulseLeg(htf, dir);
      if (!leg) { assertEquals(prod.bestZone, null); continue; }
      const mine = bestZoneWithLeg(htf, ent, leg, dir, price, undefined, { fibMaxRetracement: 1, pipSize: 0.0001 });
      assertEquals(JSON.stringify(mine.bestZone), JSON.stringify(prod.bestZone), `i=${i} ${dir}`);
      n++; if (prod.bestZone) zones++;
    }
  }
  assert(n > 100 && zones > 20, `${n} compared, ${zones} with a zone`);
});

Deno.test("G1b: full-leg FVGs == production on ≤ 52 candles and a superset beyond; full-leg POIs == production on legs ≤ 50 candles", () => {
  for (let k = 0; k < 300; k++) {
    const len = 3 + Math.floor(rnd() * 50), s = Math.floor(rnd() * (H1.length - len)), cs = H1.slice(s, s + len);
    assertEquals(JSON.stringify(detectFVGsFull(cs)), JSON.stringify(strip(SM.detectFVGs(cs))));
  }
  for (let k = 0; k < 100; k++) {
    const len = 60 + Math.floor(rnd() * 400), s = Math.floor(rnd() * (H1.length - len)), cs = H1.slice(s, s + len);
    const full = new Set(detectFVGsFull(cs).map((f) => JSON.stringify(f)));
    for (const f of strip(SM.detectFVGs(cs))) assert(full.has(JSON.stringify(f)));
  }
  let legs = 0;
  for (let i = 320; i < H1.length; i += 7) {
    const htf = H1.slice(i - 299, i + 1);
    for (const dir of ["bullish", "bearish"] as const) {
      const leg = IZ.findImpulseLeg(htf, dir);
      if (!leg || leg.endIndex + 1 - Math.max(0, leg.startIndex - 10) > 50) continue;
      assertEquals(JSON.stringify(mapImpulsePOIsFull(htf, leg)), JSON.stringify(IZ.mapImpulsePOIs(htf, leg)), `i=${i} ${dir}`);
      legs++;
    }
  }
  assert(legs > 50, `${legs} legs compared`);
});

import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Weekend crypto mode must not resurrect a disabled instrument.
 *
 * FX is shut Fri 17:00 ET to Sun 17:00 ET, and the scanner keeps running on
 * crypto through that window. It did so from a hardcoded list ASSIGNED OVER
 * config.instruments:
 *
 *   const weekendCryptoList = ["BTC/USD", "ETH/USD"].filter(...);
 *   config.instruments = weekendCryptoList;
 *
 * So disabling BTC — done on 2026-09-15, after it accounted for -$2,250 of a
 * +$175 book — would have held Monday to Friday and lapsed every weekend, with
 * nothing in the config to explain the trades. Same shape as every other bug
 * this week: the stored intent and the runtime behaviour disagree, and only the
 * runtime is load-bearing.
 */

const src = Deno.readTextFileSync(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

Deno.test("the weekend list is filtered by the configured instruments", () => {
  const block = code.slice(
    code.indexOf("const weekendCryptoList"),
    code.indexOf("const hasCrypto"),
  );
  assert(block.length > 0, "found the weekend crypto block");
  assert(/config\.instruments\.includes\(s\)/.test(block),
    "a disabled instrument cannot come back at the weekend");
});

Deno.test("an empty intersection leaves weekend mode off", () => {
  // With no crypto configured the guard must not flip weekendCryptoMode true
  // and hand the scanner an empty instrument list.
  const block = code.slice(
    code.indexOf("const weekendCryptoList"),
    code.indexOf("const hasCrypto"),
  );
  assert(/if \(weekendCryptoList\.length > 0\) \{/.test(block),
    "mode is only entered when something survives the filter");
});

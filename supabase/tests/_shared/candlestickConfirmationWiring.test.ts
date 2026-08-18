import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const main = await Deno.readTextFile(
  "./supabase/functions/bot-scanner/index.ts",
);
const fast = await Deno.readTextFile(
  "./supabase/functions/zone-confirmation-scanner/index.ts",
);
const confirmation = await Deno.readTextFile(
  "./supabase/functions/_shared/zoneConfirmation.ts",
);
const backtest = await Deno.readTextFile(
  "./supabase/functions/backtest-engine/index.ts",
);

Deno.test("the sole pending confirmation scanner uses frozen route candlestick profiles", () => {
  assertStringIncludes(
    fast,
    'candlestickProfile: "unified" | "standalone" | "cascade"',
  );
  assertStringIncludes(fast, 'sr?.signalSource === "cascade"');
  assertStringIncludes(fast, 'sr?.signalSource === "unified"');
  assertStringIncludes(fast, "candlestickProfile,");
  if (main.includes('if (pending.status === "awaiting_confirmation")')) {
    throw new Error(
      "bot-scanner must not reintroduce a second pending confirmation owner",
    );
  }
});

Deno.test("backtest uses the same route-aware Confirmation Authority", () => {
  assertStringIncludes(backtest, "detectZoneConfirmation(");
  assertStringIncludes(backtest, "backtestConfirmationProfile");
  assertStringIncludes(backtest, "Confirmation Authority");
  assertStringIncludes(backtest, "backtestConfirmationSignal?.authority");
});

Deno.test("candlestick evidence is owned by the existing Confirmation Authority", () => {
  assertStringIncludes(confirmation, "evaluateCandlestickConfirmation({");
  assertStringIncludes(confirmation, '"pattern:" + pattern.pattern');
  assertStringIncludes(confirmation, '"reversal_pattern"');
});

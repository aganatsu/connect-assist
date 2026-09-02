import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { STYLE_CONFIRMATION_TIMEFRAME } from "../../functions/_shared/styleTimeframes.ts";

/**
 * The trading style parameters exist twice: STYLE_OVERRIDES in
 * bot-scanner/index.ts drives the bot, STYLE_PARAMS in
 * src/lib/botStyleClassifier.ts drives what the config UI shows the user.
 *
 * Nothing bound them together. They agreed on values but had already drifted on
 * form — the backend wrote day_trader as "15min"/"1day" where the frontend wrote
 * "15m"/"1d". Harmless here because canonicalInterval normalises both, and
 * exactly the kind of divergence CLAUDE.md opens by warning about: every
 * production bug in the 2026-08-10 audit was a drift bug between parallel
 * implementations, not a logic bug.
 *
 * Parsed from source rather than imported, because STYLE_OVERRIDES is a module
 * -private const inside an Edge Function whose module body calls Deno.serve.
 */

const ROOT = new URL("../../../", import.meta.url);
const scannerSrc = await Deno.readTextFile(
  new URL("supabase/functions/bot-scanner/index.ts", ROOT),
);
const classifierSrc = await Deno.readTextFile(
  new URL("src/lib/botStyleClassifier.ts", ROOT),
);

const STYLES = ["scalper", "day_trader", "swing_trader"] as const;
type Style = typeof STYLES[number];

/** Pull one style's literal block out of a `Record<..., {...}>` table. */
function styleBlock(src: string, tableDecl: string, style: Style): string {
  const tableAt = src.indexOf(tableDecl);
  assert(tableAt > -1, `${tableDecl} not found`);
  const styleAt = src.indexOf(`  ${style}: {`, tableAt);
  assert(styleAt > -1, `${style} not found in ${tableDecl}`);
  const end = src.indexOf("\n  },", styleAt);
  assert(end > -1, `${style} block in ${tableDecl} is unterminated`);
  return src.slice(styleAt, end);
}

function readField(block: string, field: string): string | undefined {
  // Value up to the comma, with any trailing line comment removed.
  const m = block.match(new RegExp(`\\b${field}:\\s*([^,\\n]+)`));
  return m ? m[1].trim().replace(/\s*\/\/.*$/, "").replace(/^["']|["']$/g, "") : undefined;
}

/** "15min" and "15m" are the same interval; compare canonically. */
function canonicalTF(v: string): string {
  const m: Record<string, string> = {
    "1min": "1m", "5min": "5m", "15min": "15m", "30min": "30m",
    "60m": "1h", "60min": "1h", "240m": "4h",
    "1day": "1d", "1week": "1w", "1wk": "1w",
  };
  return m[v] || v;
}

// Fields present in both tables. The frontend names its confluence field
// differently, so it is mapped rather than assumed.
const SHARED_FIELDS: Array<{ backend: string; frontend: string; timeframe?: boolean }> = [
  { backend: "entryTimeframe", frontend: "entryTimeframe", timeframe: true },
  { backend: "htfTimeframe", frontend: "htfTimeframe", timeframe: true },
  { backend: "tpRatio", frontend: "tpRatio" },
  { backend: "slBufferPips", frontend: "slBufferPips" },
  { backend: "minConfluence", frontend: "confluenceThreshold" },
  { backend: "trailingStopEnabled", frontend: "trailingStopEnabled" },
  { backend: "trailingStopPips", frontend: "trailingStopPips" },
  { backend: "trailingStopActivation", frontend: "trailingStopActivation" },
  { backend: "breakEvenEnabled", frontend: "breakEvenEnabled" },
  { backend: "breakEvenPips", frontend: "breakEvenPips" },
  { backend: "partialTPEnabled", frontend: "partialTPEnabled" },
  { backend: "partialTPLevel", frontend: "partialTPLevel" },
  { backend: "maxHoldHours", frontend: "maxHoldHours" },
];

for (const style of STYLES) {
  Deno.test(`style tables agree for ${style}`, () => {
    const backend = styleBlock(scannerSrc, "const STYLE_OVERRIDES", style);
    const frontend = styleBlock(classifierSrc, "export const STYLE_PARAMS", style);

    for (const { backend: bKey, frontend: fKey, timeframe } of SHARED_FIELDS) {
      const bRaw = readField(backend, bKey);
      const fRaw = readField(frontend, fKey);
      // Only compare fields the backend actually declares for this style —
      // it omits some where the feature is switched off.
      if (bRaw === undefined || fRaw === undefined) continue;
      const b = timeframe ? canonicalTF(bRaw) : bRaw;
      const f = timeframe ? canonicalTF(fRaw) : fRaw;
      assertEquals(
        b,
        f,
        `${style}.${bKey} is ${bRaw} in STYLE_OVERRIDES but ${fRaw} in STYLE_PARAMS (${fKey})`,
      );
    }
  });
}

Deno.test("every style is present in both tables", () => {
  for (const style of STYLES) {
    assert(scannerSrc.includes(`  ${style}: {`), `${style} missing from STYLE_OVERRIDES`);
    assert(classifierSrc.includes(`  ${style}: {`), `${style} missing from STYLE_PARAMS`);
  }
});

Deno.test("the confirmation timeframe the UI shows is the one the bot uses", () => {
  for (const style of STYLES) {
    const frontend = styleBlock(classifierSrc, "export const STYLE_PARAMS", style);
    const shown = readField(frontend, "confirmationTimeframe");
    assertEquals(
      shown,
      STYLE_CONFIRMATION_TIMEFRAME[style],
      `${style} confirmation timeframe differs between the UI table and styleTimeframes.ts`,
    );
  }
});

Deno.test("confirmation happens on the timeframe the style enters on", () => {
  // The rule the mapping encodes. Confirming above the entry timeframe would
  // miss entries the style exists to take; confirming below it decides a setup
  // on noise the style deliberately ignores.
  for (const style of STYLES) {
    const backend = styleBlock(scannerSrc, "const STYLE_OVERRIDES", style);
    const entry = canonicalTF(readField(backend, "entryTimeframe")!);
    assertEquals(
      STYLE_CONFIRMATION_TIMEFRAME[style],
      entry,
      `${style} confirms on ${STYLE_CONFIRMATION_TIMEFRAME[style]} but enters on ${entry}`,
    );
  }
});

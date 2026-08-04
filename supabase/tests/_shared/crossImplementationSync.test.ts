/**
 * crossImplementationSync.test.ts
 * 
 * Guard test: ensures that consolidated functions remain in their canonical
 * locations and are not re-duplicated elsewhere. If a new file introduces a
 * local copy of any of these functions, this test will fail — forcing the
 * developer to import from the shared module instead.
 *
 * This test reads source files and asserts that function definitions only
 * exist in their canonical homes.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const BASE = new URL("../../functions/", import.meta.url).pathname;
const FUNCTIONS_DIR = BASE;

// ─── Helpers ─────────────────────────────────────────────────
function readSource(relativePath: string): string {
  return Deno.readTextFileSync(`${FUNCTIONS_DIR}${relativePath}`);
}

function countDefinitions(pattern: RegExp, excludePaths: string[], searchPaths: string[]): { path: string; line: number }[] {
  const violations: { path: string; line: number }[] = [];
  for (const p of searchPaths) {
    if (excludePaths.some(ex => p.includes(ex))) continue;
    try {
      const src = readSource(p);
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          violations.push({ path: p, line: i + 1 });
        }
      }
    } catch {
      // File doesn't exist — skip
    }
  }
  return violations;
}

// Files to scan (all edge functions that historically had duplicates)
const SCAN_PATHS = [
  "bot-scanner/index.ts",
  "broker-execute/index.ts",
  "zone-confirmation-scanner/index.ts",
  "paper-trading/index.ts",
  "prop-firm/index.ts",
  "bot-daily-review/index.ts",
  "bot-weekly-advisor/index.ts",
  "_shared/reconcileBrokerState.ts",
  "_shared/candleSource.ts",
  "_shared/ictJudasSwing.ts",
  "_shared/ictDisplacementMSS.ts",
];

// ─── Tests ───────────────────────────────────────────────────

Deno.test("GUARD: resolveSymbol is only defined in _shared/brokerSymbols.ts", () => {
  const pattern = /^\s*(export\s+)?function\s+resolveSymbol\s*\(/;
  const violations = countDefinitions(pattern, ["_shared/brokerSymbols.ts"], SCAN_PATHS);
  assertEquals(violations, [], `resolveSymbol re-defined outside canonical location:\n${violations.map(v => `  ${v.path}:${v.line}`).join("\n")}`);
});

Deno.test("GUARD: calculateATR is only defined in _shared/smcAnalysis.ts", () => {
  const pattern = /^\s*(export\s+)?function\s+calculateATR\s*\(/;
  const violations = countDefinitions(pattern, ["_shared/smcAnalysis.ts"], SCAN_PATHS);
  assertEquals(violations, [], `calculateATR re-defined outside canonical location:\n${violations.map(v => `  ${v.path}:${v.line}`).join("\n")}`);
});

Deno.test("GUARD: metaFetch is only defined in _shared/metaApiClient.ts", () => {
  const pattern = /^\s*(export\s+)?(async\s+)?function\s+metaFetch\s*[\(<]/;
  const violations = countDefinitions(pattern, ["_shared/metaApiClient.ts"], SCAN_PATHS);
  assertEquals(violations, [], `metaFetch re-defined outside canonical location:\n${violations.map(v => `  ${v.path}:${v.line}`).join("\n")}`);
});

Deno.test("GUARD: META_REGIONS is only defined in _shared/metaApiClient.ts", () => {
  const pattern = /^\s*(export\s+)?const\s+META_REGIONS\s*=/;
  const violations = countDefinitions(pattern, ["_shared/metaApiClient.ts"], SCAN_PATHS);
  assertEquals(violations, [], `META_REGIONS re-defined outside canonical location:\n${violations.map(v => `  ${v.path}:${v.line}`).join("\n")}`);
});

Deno.test("GUARD: normalizeTradeRecord is only defined in _shared/advisorCore.ts", () => {
  const pattern = /^\s*(export\s+)?function\s+normalizeTradeRecord\s*\(/;
  const violations = countDefinitions(pattern, ["_shared/advisorCore.ts"], SCAN_PATHS);
  assertEquals(violations, [], `normalizeTradeRecord re-defined outside canonical location:\n${violations.map(v => `  ${v.path}:${v.line}`).join("\n")}`);
});

Deno.test("GUARD: detectSession/detectSilverBullet/detectMacroWindow are only in _shared/sessions.ts", () => {
  // Pattern matches function definitions but excludes thin wrappers that delegate to shared*
  const pattern = /^\s*(export\s+)?function\s+(detectSession|detectSilverBullet|detectMacroWindow)\s*\(/;
  const delegatePattern = /shared(DetectSession|DetectSilverBullet|DetectMacroWindow)/;
  const violations: { path: string; line: number }[] = [];
  for (const p of SCAN_PATHS) {
    if (p.includes("_shared/sessions.ts")) continue;
    try {
      const src = readSource(p);
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i]) && !delegatePattern.test(lines[i])) {
          violations.push({ path: p, line: i + 1 });
        }
      }
    } catch { /* skip */ }
  }
  assertEquals(violations, [], `Session detection functions re-defined outside canonical location:\n${violations.map(v => `  ${v.path}:${v.line}`).join("\n")}`);
});

Deno.test("GUARD: bot-scanner imports resolveSymbol from brokerSymbols (not local)", () => {
  const src = readSource("bot-scanner/index.ts");
  const hasImport = src.includes('from "../../functions/_shared/brokerSymbols.ts"') || src.includes('from "../_shared/brokerSymbols.ts"');
  assertEquals(hasImport, true, "bot-scanner must import resolveSymbol from _shared/brokerSymbols.ts");
});

Deno.test("GUARD: bot-scanner imports metaFetch from metaApiClient (not local)", () => {
  const src = readSource("bot-scanner/index.ts");
  const hasImport = src.includes('from "../../functions/_shared/metaApiClient.ts"') || src.includes('from "../_shared/metaApiClient.ts"');
  assertEquals(hasImport, true, "bot-scanner must import metaFetch from _shared/metaApiClient.ts");
});

Deno.test("GUARD: zone-confirmation-scanner imports resolveSymbol from brokerSymbols", () => {
  const src = readSource("zone-confirmation-scanner/index.ts");
  const hasImport = src.includes('from "../../functions/_shared/brokerSymbols.ts"') || src.includes('from "../_shared/brokerSymbols.ts"');
  assertEquals(hasImport, true, "zone-confirmation-scanner must import resolveSymbol from _shared/brokerSymbols.ts");
});

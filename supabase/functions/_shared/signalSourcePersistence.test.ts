/**
 * signalSourcePersistence.test.ts
 *
 * Verifies that the signal_reason JSON stored in paper_positions includes
 * signalSource and unifiedZone fields. This test would have FAILED before
 * the manus/signal-source-badge change, since those fields were not persisted.
 *
 * Approach: We extract the signal_reason JSON.stringify template from bot-scanner
 * by reading the file and verifying the string includes the expected fields.
 * This is a static analysis test — it doesn't run the full scanner but proves
 * the schema is correct.
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("signal_reason JSON includes signalSource field (market order path)", async () => {
  const botScanner = await Deno.readTextFile(
    new URL("../bot-scanner/index.ts", import.meta.url)
  );

  // Find the market-order signal_reason line (the one with setupRationale which is unique to market orders)
  // This is a very long single line, so we search line-by-line
  const lines = botScanner.split("\n");
  let marketOrderLine: string | null = null;
  for (const line of lines) {
    if (line.includes("signal_reason: JSON.stringify") && line.includes("setupRationale")) {
      marketOrderLine = line;
      break;
    }
  }
  assert(marketOrderLine, "Should find market-order signal_reason JSON.stringify");

  assert(
    marketOrderLine!.includes("signalSource: (detail as any).signalSource"),
    "Market-order signal_reason must include signalSource field"
  );
  assert(
    marketOrderLine!.includes("unifiedZone: (detail as any).unifiedZone"),
    "Market-order signal_reason must include unifiedZone field"
  );
});

Deno.test("signal_reason JSON includes signalSource field (limit order path)", async () => {
  const botScanner = await Deno.readTextFile(
    new URL("../bot-scanner/index.ts", import.meta.url)
  );

  // Find the limit-order signal_reason line (the one with expiry_minutes nearby)
  // The limit order path has setupConfidence but NOT setupRationale
  const lines = botScanner.split("\n");
  let limitOrderLine: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("signal_reason: JSON.stringify") && lines[i].includes("setupConfidence") && !lines[i].includes("setupRationale")) {
      limitOrderLine = lines[i];
      break;
    }
  }
  assert(limitOrderLine, "Should find limit-order signal_reason JSON.stringify");

  assert(
    limitOrderLine!.includes("signalSource: (detail as any).signalSource"),
    "Limit-order signal_reason must include signalSource field"
  );
  assert(
    limitOrderLine!.includes("unifiedZone: (detail as any).unifiedZone"),
    "Limit-order signal_reason must include unifiedZone field"
  );
});

Deno.test("signalSource is set to one of: unified, standalone, cascade", async () => {
  const botScanner = await Deno.readTextFile(
    new URL("../bot-scanner/index.ts", import.meta.url)
  );

  // Verify all three signal source assignments exist
  assert(
    botScanner.includes('(detail as any).signalSource = "cascade"'),
    "Should assign signalSource = cascade"
  );
  assert(
    botScanner.includes('(detail as any).signalSource = "unified"'),
    "Should assign signalSource = unified"
  );
  assert(
    botScanner.includes('(detail as any).signalSource = "standalone"'),
    "Should assign signalSource = standalone"
  );
});

Deno.test("signalSource assignment happens BEFORE signal_reason construction", async () => {
  const botScanner = await Deno.readTextFile(
    new URL("../bot-scanner/index.ts", import.meta.url)
  );

  // The signalSource assignments (around line 4846-4855) must come before
  // the signal_reason JSON.stringify (around line 6217)
  const assignIdx = botScanner.indexOf('(detail as any).signalSource = "unified"');
  const jsonIdx = botScanner.indexOf("signalSource: (detail as any).signalSource");

  assert(assignIdx > 0, "signalSource assignment must exist");
  assert(jsonIdx > 0, "signalSource in signal_reason must exist");
  assert(
    assignIdx < jsonIdx,
    `signalSource assignment (pos ${assignIdx}) must come before signal_reason construction (pos ${jsonIdx})`
  );
});

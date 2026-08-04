import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));

Deno.test("scanner freezes bounded exact candle inputs after pair fetch", () => {
  const scanner = read("supabase/functions/bot-scanner/index.ts");
  assertStringIncludes(scanner, "const candleSnapshotRows: any[] = []");
  assertStringIncludes(scanner, "timeframeCandles.slice(-500)");
  assertStringIncludes(scanner, '.from("scan_candle_snapshots").upsert');
  assertStringIncludes(scanner, "completed_candle_cutoff:");
  assert(scanner.indexOf('from("scan_logs").insert') < scanner.indexOf('from("scan_candle_snapshots").upsert'));
});

Deno.test("market data exposes an authenticated Bot Evidence snapshot route", () => {
  const market = read("supabase/functions/market-data/index.ts");
  assertStringIncludes(market, 'action === "bot_evidence_candles"');
  assertStringIncludes(market, '.from("scan_candle_snapshots")');
  assertStringIncludes(market, '.eq("user_id", userId)');
});

Deno.test("both charts separate frozen evidence from live broker candles", () => {
  for (const path of ["src/pages/Chart.tsx", "src/pages/TradeReplay.tsx"]) {
    const source = read(path);
    assertStringIncludes(source, "Bot Evidence");
    assertStringIncludes(source, "Live Broker");
    assertStringIncludes(source, "botEvidenceCandles");
  }
});

Deno.test("snapshot migration enforces ownership, bounds, immutability, and retention", () => {
  const migration = read("supabase/migrations/20260804143000_add_scan_candle_snapshots.sql");
  assertStringIncludes(migration, "auth.uid() = user_id");
  assertStringIncludes(migration, "candle_count <= 500");
  assertStringIncludes(migration, "scan candle snapshots are immutable");
  const cleanup = read("supabase/functions/data-cleanup/index.ts");
  assertStringIncludes(cleanup, '.from("scan_candle_snapshots")');
  assert(cleanup.includes('.lt("created_at", thirtyDaysAgo)'));
});

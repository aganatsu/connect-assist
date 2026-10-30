// Source pins for the thesis pre-check (Oct 2026: 65 direction_flip cancels from 22 setups, 61 within 2 min).
import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";

const scanner = Deno.readTextFileSync(new URL("../../functions/bot-scanner/index.ts", import.meta.url));

Deno.test("cancel check and pre-check build their inputs with the same helper", () => {
  const uses = scanner.split("thesisValidationOpts(config,").length - 1;
  assert(uses === 2, `expected 2 calls to thesisValidationOpts, found ${uses}`);
  assert((scanner.split("loadThesisCandles(").length - 1) === 2, "both load candles through loadThesisCandles");
  assert(!/huntFetch\(pending\.symbol, "1d", "1y", "pending_thesis_htf"\)/.test(scanner), "no inline copy of the cancel check's fetches");
});

Deno.test("pre-check runs after the dry-run guard and before every entry path", () => {
  const dry = scanner.indexOf('detail.status = "dry_run_market_skipped";');
  const pre = scanner.indexOf("// ── Thesis pre-check: never enter what the cancel check would kill on arrival ──");
  const route2 = scanner.indexOf("if (effectiveLimitEnabled && limitEntry) {\n          // ── ROUTE 2 DISTANCE GUARD");
  const market = scanner.indexOf('useMarketFillAtZone ? "trade_placed_at_zone" : "trade_placed"');
  assert(dry > 0 && pre > dry, "after the dry-run guard");
  assert(route2 > pre && market > pre, "before the Route 2 and market-fill placements");
  const block = scanner.slice(pre, scanner.indexOf("// ── Candidate C shadow", pre));
  assert(/detail\.status = "skipped_thesis_conflict";/.test(block) && /scanDetails\.push\(detail\);\s*continue;/.test(block), "skips the pair");
  assert(/catch \(e: any\)[\s\S]*fail-open/.test(block), "fail-open like the validator");
  assert(/thesisValidationEnabled !== false/.test(block), "honours the master switch");
});

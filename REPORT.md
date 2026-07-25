# Task: Consolidate duplicated trading logic into _shared

## Branch: manus/shared-dedup

## Behavior changes

1. **BUG FIX (zone-confirmation-scanner):** `resolveSymbol` now correctly maps `XAU/USD` → `XAUUSD` (previously it returned `XAU/USD` unchanged because it lacked the `.replace("/", "")` step). This means zone-confirmation-scanner will now correctly resolve broker symbols for all instruments, fixing failed MetaAPI position lookups for gold and other slash-containing symbols.

2. **detectSilverBullet / detectMacroWindow in bot-scanner:** Previously used inline reimplementations with identical logic to `_shared/sessions.ts`. Now delegates to the shared versions. The window definitions and logic are byte-for-byte identical — no behavioral difference.

All other changes are pure refactors (import path changes, deletion of duplicate code).

## Files modified

| File | Change |
|------|--------|
| `_shared/brokerSymbols.ts` | **NEW** — canonical `resolveSymbol` with proper suffix/prefix/slash handling |
| `_shared/metaApiClient.ts` | **NEW** — canonical `metaFetch` with region failover, `META_REGIONS`, `metaBaseUrl`, `regionCache` |
| `_shared/crossImplementationSync.test.ts` | **NEW** — 9 guard tests preventing future re-duplication |
| `_shared/smcAnalysis.ts` | Removed `detectSession`, `detectSilverBullet`, `detectMacroWindow` (replaced with re-exports from sessions.ts) |
| `_shared/ictJudasSwing.ts` | Deleted local `calculateATR` (20 lines), imports from smcAnalysis.ts |
| `_shared/ictDisplacementMSS.ts` | Deleted local `calculateATR` (25 lines), imports from smcAnalysis.ts |
| `_shared/candleSource.ts` | Deleted local `META_REGIONS`/`regionCache`, imports from metaApiClient.ts |
| `_shared/reconcileBrokerState.ts` | Deleted local `resolveSymbol`/`metaFetch`/`META_REGIONS`/`regionCache` (44 lines), imports from shared modules |
| `bot-scanner/index.ts` | Deleted local `resolveSymbol`, `metaFetch`, `detectSilverBullet`, `detectMacroWindow` (~88 lines), imports from shared modules |
| `broker-execute/index.ts` | Deleted local `resolveSymbol`/`metaFetch` (~54 lines), imports from shared modules |
| `zone-confirmation-scanner/index.ts` | Deleted buggy local `resolveSymbol`/`metaFetch` (~45 lines), imports from shared modules |
| `paper-trading/index.ts` | Deleted local `metaFetch`/`META_REGIONS`/`regionCache` (~30 lines), imports from metaApiClient.ts |
| `prop-firm/index.ts` | Deleted local `META_REGIONS`/`metaBaseUrl`/`regionCache` (~10 lines), imports from metaApiClient.ts |
| `prop-firm/propFirmStatusBrokerEquity.test.ts` | Updated source-inspection tests to check for import from metaApiClient.ts |
| `bot-daily-review/index.ts` | Deleted local `TradeRecord`/`TradeReasoning`/`normalizeTradeRecord`/`sendTelegramNotification` delivery logic (~108 lines), imports from advisorCore.ts |
| `bot-weekly-advisor/index.ts` | Same as above (~108 lines removed) |

**Net: −551 lines deleted, +57 lines added (new shared modules + imports)**

## Tests added

| Test | Assertion |
|------|-----------|
| `crossImplementationSync.test.ts` — resolveSymbol guard | No `function resolveSymbol(` outside `_shared/brokerSymbols.ts` |
| `crossImplementationSync.test.ts` — calculateATR guard | No `function calculateATR(` outside `_shared/smcAnalysis.ts` |
| `crossImplementationSync.test.ts` — metaFetch guard | No `function metaFetch` outside `_shared/metaApiClient.ts` |
| `crossImplementationSync.test.ts` — META_REGIONS guard | No `const META_REGIONS` outside `_shared/metaApiClient.ts` |
| `crossImplementationSync.test.ts` — normalizeTradeRecord guard | No `function normalizeTradeRecord(` outside `_shared/advisorCore.ts` |
| `crossImplementationSync.test.ts` — session detection guard | No full reimplementation of `detectSession`/`detectSilverBullet`/`detectMacroWindow` (thin wrappers allowed) |
| `crossImplementationSync.test.ts` — bot-scanner resolveSymbol import | bot-scanner imports from `_shared/brokerSymbols.ts` |
| `crossImplementationSync.test.ts` — bot-scanner metaFetch import | bot-scanner imports from `_shared/metaApiClient.ts` |
| `crossImplementationSync.test.ts` — zone-confirmation-scanner import | zone-confirmation-scanner imports from `_shared/brokerSymbols.ts` |

## Tests run

```
$ deno test --no-check --allow-all supabase/functions/
ok | 1953 passed | 0 failed (21s)
```

Stable across 2 consecutive runs.

## Regression check

- Full test suite (1953 tests) passes — up from 1944 on main (9 new guard tests added)
- All pre-existing source-code-inspection tests updated where they checked for local definitions that are now imports
- The `resolveSymbol` bug fix in zone-confirmation-scanner is the only behavioral change — it now correctly handles slash-containing symbols (XAU/USD, BTC/USD) which were previously broken
- `calculateATR` in smcAnalysis.ts returns 0 on insufficient data (same behavior as the deleted copies in ictJudasSwing/ictDisplacementMSS)
- `metaFetch` region failover logic is identical across all previously-duplicated implementations

## Open questions

1. **bot-scanner's `detectAMDPhase`** — this is also a local function (~50 lines) that could potentially be moved to `_shared/sessions.ts`. However, it takes `candles: Candle[]` as input (not just time-based), making it different from the pure time-detection functions. Left in place for now.

2. **advisorCore.ts pre-existing type errors** — there are 6 type errors in advisorCore.ts (`maxConcurrent`, `confluenceThreshold` properties missing from config type, and a `ClosedTrade` type mismatch). These are pre-existing and unrelated to this task. Should they be fixed in a follow-up?

3. **candleSource.ts `metaFetchCandles`** — this is a specialized variant with circuit-breaker logic (different from the standard `metaFetch`). It now imports `META_REGIONS`/`regionCache` from metaApiClient.ts but keeps its own fetch logic. Could be further consolidated if desired.

## Suggested PR title and description

**Title:** `[shared-dedup] Consolidate duplicated trading logic into _shared — fix zone-confirmation-scanner resolveSymbol bug`

**Description:**
Eliminates ~550 lines of duplicated trading logic across 13 files by consolidating into shared modules:

- **BUG FIX:** `zone-confirmation-scanner`'s `resolveSymbol` was missing `.replace("/", "")`, causing MetaAPI position lookups to fail for XAU/USD and other slash-containing symbols
- **New `_shared/brokerSymbols.ts`:** Single canonical `resolveSymbol` with proper suffix/prefix/slash handling
- **New `_shared/metaApiClient.ts`:** Single canonical `metaFetch` with region failover, shared `META_REGIONS`/`metaBaseUrl`/`regionCache`
- **Consolidated `calculateATR`:** Deleted copies from `ictJudasSwing.ts` and `ictDisplacementMSS.ts`, now import from `smcAnalysis.ts`
- **Consolidated session detection:** Deleted copies from `smcAnalysis.ts`, re-exports from `sessions.ts`
- **Consolidated `normalizeTradeRecord` + Telegram delivery:** `bot-daily-review` and `bot-weekly-advisor` now import from `advisorCore.ts`
- **Guard test (`crossImplementationSync.test.ts`):** 9 tests that will fail if anyone re-introduces a local copy of any consolidated function

All 1953 tests pass. Net -551/+57 lines.

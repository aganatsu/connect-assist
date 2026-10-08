# Step 16-E — 26 live code-default-only controls stored explicitly: effect report

**Approved set:** A+B, all 26 keys (2026-10-08).

**Status:** PR open, **not merged**; production **NOT patched**. The PATCH runs by hand only after merge and PATCH approval.

**Unchanged:**
- the account stays $100,000, paused and entries-locked;
- no change to the fill floor, `MIN_TP_PIPS` / `skipped_tp_too_small`, crons, the resolver, Route 2 behaviour, the risk profile or migrations.

## 1. Production state (re-verified 2026-10-08 03:34 UTC, immediately before the PR)

| Check | Result |
|---|---|
| Config row | `bot_configs` `327912ae-4e5b-4677-ad04-7c5d566f7990`: the only row, connection_id null, updated 2026-10-07 12:55 |
| Canonical hash | **`3d5b8fb0d756b3596ed46d133e873a88`**; md5 of the exact stored text (`config_json::text`) matches |
| Proof fixture | `docs/step16/step16e_config_before.json` is **byte-identical** to the stored text |
| Runtime parity | mapper + pair overrides on the fixture = all 199 settings recorded by the scanner for each of the six pairs (03:20 scan, `__configVersion 3d5b8fb0…`) |
| Account | $100,000, paused, entries-locked, kill switch off |
| Positions | 0 |
| Risk profile | `ftmo_2step` active |
| Change log | latest `e3eb2e67 → 3d5b8fb0` (Step 14) |

## 2. The 26 keys

Every value is the current code default (`RUNTIME_DEFAULTS`, read from code). None is stored today. The mapper is their only live reader; bot-scanner's `_legacyLoadConfigMapping` (bs:1083) is never called.

| Group | Key | Value | Mapper | Governs |
|---|---|---|---|---|
| A | `impulseZoneEnabled` | true | cm:514 | Impulse hard-gate branch |
| A | `legStopBufferPct` | 0.02 | cm:522 | impulse-origin stop buffer |
| A | `legStopCapMultiple` | 1.2 | cm:523 | stop cap max(floor × 1.5, leg × 1.2) |
| A | `useSimpleDirection` | true | cm:529 | direction engine |
| A | `simpleDirectionH4ChochLookback` | 10 | cm:530 | direction engine |
| A | `simpleDirectionH1BosLookback` | 8 | cm:531 | direction engine |
| A | `useConfirmedTrend` | true | cm:532 | direction engine |
| A | `zoneChaseMaxZoneWidths` | 1 | cm:536 | hunt reset boundary |
| A | `thesisValidationEnabled` | true | cm:539 | live-order thesis cancel |
| A | `thesisCheckDirectionFlip` | true | cm:540 | direction-flip cancel |
| A | `confirmedTrendFibFactor` | 0.25 | cm:547 | direction engine |
| A | `confirmedTrendSwingLookback` | 5 | cm:548 | direction engine |
| A | `ictHTFEnabled` | true | cm:700 | weekly bias → Gate 1 |
| A | **`atrDerivedFloorsEnabled`** | **false** | cm:537 | ATR stop-floor layer (bs:5486). A flipped default would move every floor |
| B | `gamePlanGateMode` | "soft" | cm:545 | "hard" would block entries |
| B | `requireUnifiedZone` | false | cm:526 | would require a Unified zone |
| B | `zoneAnchoredStop` | false | cm:534 | would change the stop geometry |
| B | `priceAwareStructureBlocks` | false | cm:533 | would change direction-engine structure blocks |
| B | `thesisDirectionStyleAware` | false | cm:543 | would change the thesis-cancel engine |
| B | `htfBiasHardVeto` | false | cm:470 | legacy Gate 1 fallback veto |
| B | `ictHTFGateMode` | "off" | cm:701 | ICT HTF gating |
| B | `ictKillZoneGateMode` | "off" | cm:734 | kill-zone gating |
| B | `ictJudasSwingGateMode` | "off" | cm:718 | Judas-swing gating |
| B | `ictDisplacementMSSGateMode` | "off" | cm:710 | displacement-MSS gating |
| B | `sessions.killZoneOnly` | false | cm:651 | Gate 12 kill-zone-only |
| B | `entry.limitOrderEnabled` | false | cm:759 | legacy limit-entry path |

## 3. Equivalence proof

`supabase/tests/_shared/step16eExplicitDefaults.test.ts`: 8 tests, passing.

| Proof | Result |
|---|---|
| exactly the 26 approved keys (incl. `atrDerivedFloorsEnabled`), all absent today | ✅ |
| every value = `RUNTIME_DEFAULTS` (booleans asserted from code) | ✅ |
| no existing stored value changes (after minus the 26 keys = before) | ✅ |
| **full effective runtime config byte-identical:** EUR/USD, GBP/USD, USD/JPY, CHF/JPY, NZD/CAD, NZD/CHF | ✅ 6/6 |
| `resolveSimplification`; `resolvePositionCaps` at placement, hunt_fill, scan_stop, decision_record on all six pairs | ✅ |
| per category: admission, order geometry, sizing, stop, management, caps, direction engine, thesis, ICT HTF, leg cap (60 settings, covering all 26 keys) plus 17 simplification switches | ✅ |
| **the production SQL file executed in real Postgres:** 3d5b8fb0 → exactly `1037e617…`; it writes exactly the proven object; re-run is a no-op; a changed row aborts (`STEP16E_PATCH_ABORTED`) | ✅ |
| reporting registry: old and new hash in one class | ✅ |

**Mutation check** (final test, temporary edits to the patch file, reverted):

| Mutation | Result |
|---|---|
| leg cap 1.3 | 4 of 8 fail |
| ATR floors on | 4 of 8 fail |
| Game Plan gate "hard" | 4 of 8 fail |
| `killZoneOnly` true | 5 of 8 fail |

**Raw-config readers:** besides the mapper, the scanner reads the raw config only through:
- `resolveSimplification` and `resolvePositionCaps` (identical above);
- `isExplicitlySet`, which runs only with style overrides **on** (they are off), and none of the 26 keys is in its protected list.

**What changes (records only):**
- the canonical `config_version`;
- one new `bot_config_history` row.

## 4. Versions

| Hash | Relation |
|---|---|
| `3d5b8fb0d756b3596ed46d133e873a88` | current (Step 14) |
| **`1037e6170289f865e4d6618dcf28b94d`** | **new: behaviour-equivalent to `3d5b8fb0`, NOT identical; marks the explicit frozen-config boundary** |
| `031220a48de71e731967d38108680792` | historical reference only: the A-only (14-key) candidate. **Not used**, and no A-only SQL is in this PR |

**Reporting:** `CONFIG_EQUIVALENCE_CLASSES["frozen_impulse_route2_v1"] = [3d5b8fb0…, 1037e617…]` (`_shared/hypotheticalCapBook.ts`). The cap-book pools the two only through this explicit entry. Any other hash stays its own class.

## 5. Applying the PATCH (after merge + approval only)

- **File:** `docs/step16/STEP16E_PATCH_AB_26.sql`. Run once, by hand, in the SQL editor.
- **What it does:**
  - **server-side `jsonb_set`**, so every existing byte is kept (a client round-trip would rewrite `"orderRRMin": 1.0` as `1` and change the hash);
  - updates only the row whose hash is still `3d5b8fb0`;
  - aborts unless the result is exactly `1037e617…`;
  - then a read-only SELECT shows the hash and the change-log entry (`3d5b8fb0 → 1037e617` via the `audit_bot_config_change` trigger).
- **After it:**
  1. the next full scan records `__configVersion = 1037e617…` and the same 199 settings on all six pairs (the parity check from §1);
  2. new attribution rows carry `1037e617…`;
  3. the baseline doc's §11 status is updated.

## 6. Effect

**None on trading.**
- Identical effective configuration on every pair.
- Identical admission, order geometry, sizing, stops, management, caps, direction engine, thesis and ICT HTF behaviour.

## Carried: Step 16-D status

- **Caller-level guard:** complete ✅ (merged `45fb9a2a`; paper-trading deployed 03:07 and serving).
- **Live guard behaviour:** pending verification.
- **Atomic reset / exposure race:** **mandatory pre-unlock item**, not resolved (`PRE_UNLOCK_DECISIONS_V1.md` §3).

# Task: Market Fill UI Controls

## Branch: manus/market-fill-ui-controls

## Behavior changes

1. **New UI controls exposed**: Users can now toggle "Market Fill at Zone" ON/OFF and adjust the "Zone Proximity (ATR×)" slider (0.1–1.0) from the Entry/Exit tab in BotConfigModal. Previously these were hardcoded/hidden.
2. **Configurable strict ATR multiplier**: The `PRICE_AT_ZONE_STRICT_ATR_MULT` constant (0.3) is no longer the sole source of truth. When a user sets `marketFillStrictATRMult` in their config, that value overrides the constant. If not set, the default 0.3 is used — **identical behavior to before**.
3. **No change to trade execution logic**: The `marketFillAtZone` toggle already existed in DEFAULTS and was already read by the scanner. The only new behavior is that users can now change it from the UI instead of needing a raw DB edit.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/impulseZoneEngine.ts` | Added `ZoneEngineOptions` interface with optional `strictATRMult`. Added optional `options` param to `findBestEntryZone` and `findBestEntryZoneMultiTF`. Uses `options.strictATRMult` when provided, falls back to hardcoded 0.3. |
| `supabase/functions/bot-scanner/index.ts` | Added `marketFillStrictATRMult: 0.3` to DEFAULTS. Added it to loadConfig merge. Passes `ZoneEngineOptions` to `findBestEntryZoneMultiTF`. Added `ZoneEngineOptions` to import. |
| `src/components/BotConfigModal.tsx` | Added "Market Fill at Zone" toggle and "Zone Proximity (ATR×)" slider in the Entry/Exit tab. Added search index entries for discoverability. |
| `supabase/functions/_shared/impulseZoneEngine.test.ts` | Added 5 new tests covering: backward compatibility, wider/tighter multiplier behavior, zero multiplier edge case, multi-TF passthrough, and regression check. |

## What was changed in bot-scanner/index.ts (extra caution file)

Three minimal, additive changes:

1. **Import** (line 61): Added `type ZoneEngineOptions` to the existing import from `impulseZoneEngine.ts`.
2. **DEFAULTS** (line 205): Added `marketFillStrictATRMult: 0.3` — matches the existing hardcoded constant, so zero behavior change on fresh installs.
3. **loadConfig merge** (line 963): Added `marketFillStrictATRMult: entry.marketFillStrictATRMult ?? raw.marketFillStrictATRMult ?? DEFAULTS.marketFillStrictATRMult` — standard config merge pattern identical to all other fields.
4. **Zone engine call** (line 3982): Constructs `ZoneEngineOptions` from `pairConfig.marketFillStrictATRMult` and passes it as the 7th argument to `findBestEntryZoneMultiTF`. Since the default is 0.3 (same as the hardcoded constant), existing behavior is unchanged unless the user explicitly changes the slider.

## Tests added

| Test | Assertion |
|------|-----------|
| `options.strictATRMult=undefined uses default 0.3` | No-options, explicit-undefined, and empty-object all produce identical `priceAtZoneStrict` |
| `larger strictATRMult widens strict proximity` | 1.0× is at least as permissive as 0.1× |
| `strictATRMult=0 makes strict proximity impossible` | Zero threshold means only inside-zone counts as strict |
| `findBestEntryZoneMultiTF — passes options through` | Options propagate to both TF calls without crash |
| `regression: no options produces same result as before` | Full output structure check — all fields present and typed correctly |

## Tests run

```
$ deno test supabase/functions/_shared/impulseZoneEngine.test.ts --allow-all
running 42 tests from ./supabase/functions/_shared/impulseZoneEngine.test.ts
ok | 42 passed | 0 failed (51ms)
```

## Regression check

- All 37 pre-existing tests pass unchanged — the optional `options` parameter defaults to `undefined`, which triggers the `?? PRICE_AT_ZONE_STRICT_ATR_MULT` fallback, producing byte-identical behavior.
- The `findBestEntryZone — regression: no options produces same result as before` test explicitly validates output structure hasn't changed.
- The `findBestEntryZone — options.strictATRMult=undefined uses default 0.3` test proves all three calling patterns (no arg, undefined, empty object) are equivalent.

## Open questions

1. **Per-pair override?** Currently `marketFillStrictATRMult` is a global config field. If you want per-pair overrides (e.g., wider for gold, tighter for EUR/USD), that would require extending `pairConfig` — let me know.
2. **Loose threshold configurable too?** The 1.5× ATR "loose" threshold (for watchlist awareness) is still hardcoded. Want that exposed as well?

## Suggested PR title and description

**Title:** `feat(ui): add Market Fill at Zone toggle and ATR proximity slider to BotConfigModal`

**Description:**
```
Adds two new controls to the Entry/Exit tab in BotConfigModal:
- Market Fill at Zone (toggle) — enables/disables immediate market fill when
  price is already at the impulse zone
- Zone Proximity ATR× (slider, 0.1–1.0) — configures how close price must be
  to the zone edge for market fill (default 0.3× ATR, same as before)

Backend changes:
- impulseZoneEngine.ts: new ZoneEngineOptions interface with optional strictATRMult;
  passed through findBestEntryZone → findBestEntryZoneMultiTF
- bot-scanner/index.ts: reads marketFillStrictATRMult from config and passes to
  zone engine; defaults to 0.3 (no behavior change unless user adjusts slider)

5 new Deno tests, all 42 zone engine tests passing.
No behavior change for existing users — controls default to current values.
```

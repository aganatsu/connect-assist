# Task: Config Modal Sub-Component Migration
## Branch: manus/config-modal-subcomponents
## Behavior changes
none — pure refactor. All ICT2022, SMC Enhancement, Factor Weights, and Pair Overrides functionality is preserved identically; only the file location changed.

## Files modified
- `src/components/config/ScanTab.tsx` — Expanded from 300 lines to ~560 lines. Now contains full ICT2022 Mentorship module cards (with gate mode selectors, fine-tuning sliders for HTF bias, displacement ratio, Judas sweep pips, FVG body ratio, KZ buffer) and full SMC Enhancements module cards (with gate modes, phase detection thresholds, zone lifecycle params, breaker block params, fib 3-point TP level selector, trendline liquidity params, Enable All/Disable All buttons).
- `src/components/config/EnterTab.tsx` — Expanded from 219 lines to ~521 lines. Now contains full Factor Weights editor (tier-grouped sliders with reset-to-default, tier scoring explanation) and full Per-Pair Gate Overrides (instrument type grouping, collapsible per-pair editors, recommended overrides button, clear overrides).

## Tests added
- TypeScript compilation (`npx tsc --noEmit`) — verifies all imports, types, and JSX are valid across the new file structure.

## Tests run
```
$ npx tsc --noEmit --project tsconfig.app.json
EXIT: 0
```
No runtime test framework is configured in this repo (Lovable frontend project). TypeScript type-checking is the primary verification.

## Regression check
- All original sub-component code was extracted verbatim from the original BotConfigModal.tsx (commit before redesign, accessed via `git show`)
- ICT2022_MODULES constant: identical 6 modules with same keys, labels, descriptions, enabledFields, gateFields
- SMC_ENHANCEMENT_MODULES constant: identical 6 modules with same keys, labels, descriptions, configFields, gateFields, hasParams
- FACTOR_WEIGHT_DEFS: identical 16 factors with same tiers, default weights, tier points
- RECOMMENDED_OVERRIDES and OVERRIDE_FIELDS: identical structure
- All updateField/setConfig/updateStrategy/updateEnhancement patterns preserved
- Gate mode selector UI (Off/Soft/Hard) and fine-tuning parameters preserved with same min/max/step/defaults

## Open questions
None — this completes the sub-component migration. The BotConfigModal is now fully decomposed into 4 focused tab files.

## Suggested PR title and description
**Title:** feat: migrate ICT2022, SMC Enhancements, FactorWeights, PairOverrides into tab components

**Description:**
Completes the config modal decomposition started in PR #83. Migrates all remaining inline sub-components into their proper tab files:

- **ScanTab.tsx**: Full ICT 2022 Mentorship (6 modules with gate modes + fine-tuning) and SMC Enhancements (6 modules with gate modes + fine-tuning + Enable/Disable All)
- **EnterTab.tsx**: Full Factor Weights editor (16 factors, tier-grouped, with sliders and reset) and Per-Pair Gate Overrides (instrument grouping, collapsible editors, recommended overrides)

No behavior changes. TypeScript compiles clean.

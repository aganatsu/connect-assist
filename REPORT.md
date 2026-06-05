# Task: Config Change UI
## Branch: manus/config-change-ui
## Behavior changes
none — pure UI refactor. No changes to what trades get taken, what positions get sized, or what gates pass. The auto-apply key mapping extension means more recommendations will show "Approve" instead of "Manual", but the actual config change still requires user action (clicking Approve).

## Files modified
- `src/components/RecommendationsDashboard.tsx` — Replaced raw JSON display with human-readable labeled config diff rows; added "Open in Config" button for manual recommendations that opens BotConfigModal to the relevant tab
- `src/components/BotConfigModal.tsx` — Added `defaultTab` and `defaultSearch` optional props to allow external components to open the modal pre-navigated to a specific tab/field
- `src/lib/applyRecommendation.ts` — Extended the `resolveConfigPath` direct key map with 20+ common config paths (rrRatio, tpRRRatio, minRR, maxDailyDrawdown, confluenceThreshold, tier1Minimum, etc.) so more AI recommendations become auto-applicable

## Tests added
No new test files — this is a frontend-only UI change. TypeScript compilation verified clean with `tsc --noEmit -p tsconfig.app.json`.

## Tests run
```
$ npx tsc --noEmit -p tsconfig.app.json
(no errors)
```

## Regression check
- The `applyRecommendationToConfig` function only ADDS new key mappings — all existing mappings are unchanged. Any recommendation that was previously auto-applicable remains so.
- The `BotConfigModal` new props are optional with defaults matching previous behavior (`defaultTab` defaults to "strategy", `defaultSearch` defaults to "").
- The `RecommendationCard` rendering logic is functionally equivalent for the expand/collapse, approve/dismiss/mark-done flows.

## Open questions
1. The LLM in bot-daily-review emits `{"rrRatio": 1.5}` as the suggested_value key. The actual config path is `exit.tpRRRatio`. The mapping now handles this, but if the LLM emits other novel keys in future, they'll fall back to the old JSON display (graceful degradation). Should we add a catch-all that attempts camelCase → dot-path resolution?
2. Factor weight recommendations already had their own dedicated handler — they continue to show "Approve" as before. The new labeled display also applies to them (shows factor name instead of raw key).

## Suggested PR title and description
**Title:** Replace raw JSON config recommendations with human-readable UI + Open in Config

**Description:**
Improves the AI Advisor recommendation cards:
- Config changes now display as labeled rows: `R:R Ratio (TP Target)  3 → 1.5` instead of `{"rrRatio":3} → {"rrRatio":1.5}`
- Manual recommendations get an "Open in Config" button that opens BotConfigModal pre-navigated to the relevant tab and field
- Extended the auto-apply key mapping with 20+ common config paths, converting many previously-manual recommendations to one-click Approve

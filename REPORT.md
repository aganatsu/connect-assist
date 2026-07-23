# Task: Config Export/Import
## Branch: manus/config-export-import
## Behavior changes
1. New "Export" button in BotConfigModal toolbar — downloads the current config (including all sections + factor weights + instrument buffers) as a timestamped JSON file.
2. New "Import" button in BotConfigModal toolbar — opens a file picker, validates the JSON, loads it into the editor (user must still click "Save Config" to persist).
3. Import supports both the wrapped format (`{ _meta, config }`) and raw config objects for backward compatibility.
4. Export includes metadata (`_meta.version`, `_meta.exportedAt`, `_meta.source`, `_meta.connectionId`) for traceability.

## Files modified
- `src/components/BotConfigModal.tsx` — Added Download/Upload icons to lucide import, added `handleExport`, `handleImportClick`, `handleFileChange` handlers, added Export/Import buttons + hidden file input to the toolbar.

## Tests added
- No new Deno tests required (this is a pure frontend feature — export creates a Blob, import reads a file and sets local state).
- TypeScript compilation: 0 errors.
- Existing tests: 21 passed, 0 failed.

## Tests run
```
deno test resolveTradeConfig.test.ts sltpRecalc.test.ts --no-check
ok | 21 passed | 0 failed (111ms)

npx tsc --noEmit
EXIT: 0
```

## Regression check
- Export produces a JSON file containing the exact same config object that was in the editor state.
- Import loads the file into local state only — no database write until user clicks "Save Config" — so there's zero risk of accidental overwrites.
- The existing `saveMut` flow (which includes validation via the edge function) still applies after import.

## Open questions
- None. The feature is self-contained in the frontend. No backend changes needed since import just loads into the editor and the existing save flow handles persistence + validation.

## Suggested PR title and description
**Title:** feat: add config export/import buttons to BotConfigModal

**Description:**
Adds Export and Import buttons to the bot configuration modal toolbar:
- **Export** downloads the current config as a timestamped `.json` file with metadata
- **Import** opens a file picker, validates the JSON structure, and loads it into the editor
- User must still click "Save Config" to persist imported configs (safety by design)
- Supports both wrapped (`{ _meta, config }`) and raw config formats
- No backend changes required

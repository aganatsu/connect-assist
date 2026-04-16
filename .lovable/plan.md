

# Fix Symbol Suffix UX — Make It Clear & Functional

## Problem
The current form is confusing: you type a single "Default Symbol Suffix" but if you need different suffixes for different symbols (e.g. `r` for forex, `m` for gold, `b` for indices), you have to manually add overrides one-by-one. Plus the override display is buggy (showing `B → ""` with empty suffix).

## Solution
Replace the single text field + manual overrides with a **symbol-suffix table** approach:

1. **Keep the Default Suffix field** — this applies to any symbol not explicitly listed
2. **Improve the Symbol Overrides section**:
   - Show overrides as a clean editable table with columns: Symbol | Suffix | Delete
   - Show the resolved symbol name preview (e.g. `XAUUSD` + `m` = `XAUUSDm`)
   - Fix the display bug where empty suffixes show as `""`— show `(none)` instead
   - Clear the input fields after adding an override
3. **Add a helper note** explaining: "Default suffix applies to all symbols. Add overrides below for symbols that need a different suffix."

## Changes

### `src/pages/Settings.tsx`
- Fix `addOverride` to clear inputs after adding (`setNewOverrideSymbol("")` / `setNewOverrideSuffix("")`)
- Show resolved symbol preview next to each override (e.g. `XAUUSD + m → XAUUSDm`)
- Display `(no suffix)` instead of `""` when override suffix is empty
- Add clearer helper text explaining the default vs override relationship
- Minor layout improvements to the overrides list

### No backend changes needed
The `symbol_suffix` and `symbol_overrides` columns already exist and work correctly. This is purely a UI clarity fix.


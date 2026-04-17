

## Plan: Add searchable filter to Bot Configuration modal

User wants a search input inside the Bot Config modal that filters fields/tabs as they type — similar to a command palette / settings search.

Need to inspect `BotConfigModal.tsx` to see structure (tabs, fields) before finalizing.

### What I'll build

1. **Add a search input at the top of `BotConfigModal`** (sticky, just under the dialog header)
   - Icon + input, placeholder "Search settings… (e.g. trailing stop, spread, news)"
   - Uses existing `Input` + `Search` lucide icon, dark-theme tokens

2. **Filtering behavior**
   - Build a static index of every setting: `{ tab, label, keywords[], fieldId }` derived from the modal's existing tabs/fields
   - As user types: case-insensitive match against label + keywords
   - When query is non-empty:
     - Hide the normal tab strip
     - Render a flat **Results list** grouped by tab (e.g. "Risk › Max Daily Loss", "Exits › Trailing Stop Pips") — each row is the actual control (input/switch/select), not just a link, so they can edit inline
     - Empty state: "No settings match 'xyz'"
   - When query is empty: restore normal tabbed view, no behavior change

3. **Click-to-jump fallback** (optional row affordance)
   - Each result row also shows the tab name as a small badge; clicking the badge switches to that tab and clears the search, scrolling/highlighting the field

4. **Keyboard**
   - Auto-focus search on modal open
   - `Esc` clears query first, then closes modal on second press
   - `↑/↓` to move highlight, `Enter` to jump to that field's tab

### Scope notes
- Frontend-only, single file: `src/components/BotConfigModal.tsx`
- No bot logic touched (memory constraint respected) — purely a UI filter over existing form fields
- No new deps; uses existing shadcn `Input`, `Badge`, lucide `Search`


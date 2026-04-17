

## Plan: SignalReasoningCard — parse the JSON wall into a readable card

### 1. New file `src/components/SignalReasoningCard.tsx`

Props: `signalReason: string`, `compact?: boolean`.

**Parsing** — input is a JSON string like:
```json
{"summary":"BUY: 10/17 factors aligned (score: 9.8/10). Market Structure, Order Block, ... | VWAP: above @ 1.85196 | AMD distribution/bullish","exitFlags":{...},"spreadFilter":{...},"newsFilter":{...}}
```
Steps:
1. `JSON.parse(signalReason)` → if fails, fall back to raw text in muted mono.
2. From `obj.summary`, regex-extract:
   - `direction`: `^(BUY|SELL)`
   - `factorCount` / `total`: `(\d+)\/(\d+)\s+factors`
   - `score`: `score:\s*([\d.]+)\/10`
   - `alignedFactors[]`: comma-split between `". "` and the first `" | "`
   - `extraContext[]`: remaining `" | "`-segments (VWAP / AMD / SMT etc.)
3. Pull `exitFlags`, `spreadFilter`, `newsFilter` directly off the object.

**Compact view** (`compact=true`):
`<span>` with color-coded direction: `BUY · 10 factors (9.8)`.

**Full view**:
- **Header**: BUY/SELL badge (`bg-success/15 border-success/40` or `bg-destructive/15 border-destructive/40`), score in mono (`text-success` if BUY else `text-destructive`), `10/17 factors` muted.
- **Aligned Factors**: flex-wrap pills (`rounded-full bg-secondary/60 border border-border px-1.5 py-0.5 text-[9px]`).
- **Context** (if any): mono secondary tags (`bg-muted/40 text-muted-foreground`).
- **Exit Strategy** — 2-col grid, only render rows present on `exitFlags`:
  - Trailing Stop → `${trailingStopPips} pips` + `(${trailingStopActivation})` if set
  - Break Even → `${breakEvenPips} pips`
  - Partial TP → `${partialTPPercent}% @ ${partialTPLevel}R`
  - TP Ratio → `tpRatio` if present
  - Max Hold → `${maxHoldHours}h`
- **Filters** — 2-col grid:
  - Spread: `enabled · max ${maxPips} pips`
  - News: `enabled · pause ${pauseMinutes} min`

Tailwind sizing 8–10px, dark-theme tokens (`text-foreground`, `text-muted-foreground`, `border-border`, `bg-card`, `bg-secondary`, `bg-success`, `bg-destructive`) — no hardcoded colors.

### 2. `src/pages/BotView.tsx`
- Add `import { SignalReasoningCard } from "@/components/SignalReasoningCard";`
- Inline table cell (~line 306): replace `{p.signalReason || "—"}` with `<SignalReasoningCard signalReason={p.signalReason || ""} compact />`
- Expanded "SIGNAL REASONING" block (~line 323): replace the raw `{p.signalReason}` paragraph with `<SignalReasoningCard signalReason={p.signalReason || ""} />`

### 3. `src/pages/Journal.tsx`
- Same import.
- Replace the `<pre>{JSON.stringify(selectedTrade.reasoning_json, null, 2)}</pre>` block (~line 307) with:
  `<SignalReasoningCard signalReason={typeof selectedTrade.reasoning_json === "string" ? selectedTrade.reasoning_json : JSON.stringify(selectedTrade.reasoning_json)} />`

### Notes
- Frontend-only. No edge function, DB, or bot-logic changes (memory constraint respected).
- Robust fallback: if JSON parse fails or fields are missing, the card degrades gracefully (raw text or omitted sections) — nothing breaks for legacy rows.


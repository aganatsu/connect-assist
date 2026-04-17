

## Plan: Add timestamp columns to Open / Closed Today / All History tables

The previous plan for this was approved but the edits never landed in `BotView.tsx` (build failed on an unrelated R2 timeout, then a different file got edited). Re-presenting the same scoped change so it can actually be applied.

### Changes — `src/pages/BotView.tsx` only

**A. Open Positions table**
- Add `<th>Opened</th>` header between Symbol and Direction.
- Add matching `<td>` rendering `formatBrokerTime(p.openTime)` in `text-[10px] font-mono text-muted-foreground`.
- Bump the expanded-row `colSpan` by +1.

**B. `TradeHistoryTable` (used by both Closed Today & All History)**
- Add two leading columns: **Opened** and **Closed**.
- Cells render `formatBrokerTime(t.openTime)` and `formatBrokerTime(t.closedAt)` in the same muted mono style.

**C. Import**
- `import { formatBrokerTime } from "@/lib/formatTime";` if not already imported.

### Format
Uses the existing project-wide helper → `"04/17, 02:05:23 PM"`, matching `BrokerLog` and `CloseAuditLog`.

### Scope
Frontend-only, single file. No bot logic, no DB, no edge functions. Memory constraint respected.


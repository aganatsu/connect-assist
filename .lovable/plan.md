

# Fix Broker Connection Card Text Overflow

## Problem
The broker connection card at lines 103-116 in `Settings.tsx` displays the `account_id` (which contains a long JWT token) without any text truncation. This causes:
1. Text bleeding/overflowing the card boundary
2. The Test and Delete buttons being pushed off-screen

## Fix
In `BrokerSettings()` (lines 103-116), update the connection card layout:
- Add `overflow-hidden` and `min-w-0` to the text container div
- Add `truncate` class to the text displaying broker type and account ID
- Add `shrink-0` to the button container so it never gets pushed off-screen

### File: `src/pages/Settings.tsx` (lines 104-115)
Change the card content layout from:
```tsx
<CardContent className="pt-4 flex items-center justify-between">
  <div>
    <p className="font-medium text-sm">{c.display_name}</p>
    <p className="text-xs text-muted-foreground">{c.broker_type.toUpperCase()} · {c.account_id} · {c.is_live ? "Live" : "Demo"}</p>
  </div>
  <div className="flex gap-2">
```
To:
```tsx
<CardContent className="pt-4 flex items-center justify-between gap-3">
  <div className="min-w-0 flex-1">
    <p className="font-medium text-sm truncate">{c.display_name}</p>
    <p className="text-xs text-muted-foreground truncate">{c.broker_type.toUpperCase()} · {c.account_id} · {c.is_live ? "Live" : "Demo"}</p>
  </div>
  <div className="flex gap-2 shrink-0">
```

This ensures long text is truncated with ellipsis and the Test/Delete buttons always remain visible.


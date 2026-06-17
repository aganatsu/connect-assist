# Task: Telegram Notification Settings Panel
## Branch: manus/telegram-notification-settings
## Behavior changes
1. Users can now toggle individual Telegram notification categories on/off from the Settings > Preferences page
2. When a category is toggled OFF, the corresponding Telegram notification is silently skipped (no message sent)
3. All categories default to ON — existing users see no change until they explicitly disable something
4. The "Notification Categories" card only appears when at least one Telegram Chat ID is configured (no UI clutter for users without Telegram set up)

## Files modified
- `src/pages/Settings.tsx` — Added "Notification Categories" card with 12 toggle switches, "All On"/"All Off" bulk actions, saves to `preferences_json.telegramNotifyCategories`
- `supabase/functions/bot-scanner/index.ts` — Added `shouldNotify()` helper after telegramChatIds extraction; wrapped all 9 telegram send points with category guards (trade_opened, zone_setup_active, zone_touched, confirmed_entry, trade_closed, trade_management, thesis_invalidated, prop_firm_alert, game_plan)
- `supabase/functions/bot-daily-review/index.ts` — Added `daily_review` category check before sending daily review notification
- `supabase/functions/bot-weekly-advisor/index.ts` — Added `weekly_advisor` category check before sending weekly advisor notification
- `supabase/functions/_shared/notificationCategoryToggles.test.ts` — New test file with 9 tests

## Extra caution note (bot-scanner/index.ts)

**What changed:** Added a `shouldNotify(category)` helper function (2 lines) and inserted `&& shouldNotify("category_name")` into 9 existing `if (telegramChatIds.length > 0)` conditions. No other logic was touched.

**Why this is safe:** The guard is purely additive — it's an AND condition appended to the existing telegramChatIds check. When `telegramNotifyCategories` is missing from preferences (all existing users), `shouldNotify()` returns `true` for every category, making the behavior identical to before. Only when a user explicitly sets a category to `false` via the new UI does the notification get skipped.

## Tests added
1. `shouldNotify — all categories default to true when telegramNotifyCategories is missing` — verifies backward compatibility
2. `shouldNotify — all categories default to true when telegramNotifyCategories is empty object` — verifies empty state
3. `shouldNotify — explicitly disabled category returns false` — verifies toggle-off works
4. `shouldNotify — explicitly enabled category returns true` — verifies explicit true
5. `shouldNotify — toggle all OFF disables every category` — verifies bulk disable
6. `shouldNotify — toggle all ON enables every category` — verifies bulk enable
7. `shouldNotify — mixed toggles respected correctly` — verifies complex state
8. `shouldNotify — unknown category defaults to true (forward-compatible)` — verifies future categories work
9. `shouldNotify — null/undefined in telegramNotifyCategories treated as enabled` — verifies edge cases

## Tests run
```
$ deno test supabase/functions/_shared/notificationCategoryToggles.test.ts --no-check
running 9 tests from ./supabase/functions/_shared/notificationCategoryToggles.test.ts
ok | 9 passed | 0 failed (47ms)

$ deno test supabase/functions/_shared/scanMetaActiveStyle.test.ts --no-check
running 9 tests from ./supabase/functions/_shared/scanMetaActiveStyle.test.ts
ok | 9 passed | 0 failed (58ms)
```

## Regression check
- The `shouldNotify()` function uses `notifyCategories[category] !== false` which means:
  - Missing field → true (backward compatible, no behavior change for existing users)
  - `undefined` → true (safe)
  - `null` → true (safe)
  - Only explicit `false` disables
- Existing users with no `telegramNotifyCategories` in their preferences_json will see zero change in notification behavior
- The guard is additive (AND condition) to the existing `telegramChatIds.length > 0` check

## Open questions
- `gate_effectiveness` toggle is wired in the UI but no corresponding notification exists yet in the backend — it's ready for when that feature is added
- Should prop_firm_alert be non-disablable (always send regardless of toggle)? Currently it can be disabled like any other category. This is a safety consideration.

## Suggested PR title and description
**Title:** feat: Telegram notification category toggles (UI + backend guards)

**Description:**
Adds a per-category notification settings panel to the Preferences page. Users can toggle which Telegram notifications they receive (trade opened, zone touched, confirmed entry, trade closed, management actions, thesis invalidated, prop firm alerts, daily review, weekly advisor, game plan).

Backend changes wrap all telegram send points with `shouldNotify(category)` checks that read from `preferences_json.telegramNotifyCategories`. All categories default ON — existing users see no change until they explicitly disable something.

Includes 9 unit tests covering the toggle logic edge cases.

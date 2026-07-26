# Task: Add caller verification to functions using service-role key

## Branch: manus/cron-secret-guard

## Behavior changes

1. **Cron-only functions now return 401 without `x-cron-secret` header:**
   - `data-cleanup`
   - `prop-firm-daily-reset`
   - `zone-confirmation-scanner`
   - `outcome-tracker`

2. **Dual-path functions now return 401 without either `x-cron-secret` OR a valid user JWT:**
   - `bot-daily-review`
   - `bot-weekly-advisor`
   - `advisor`
   - `optimizer`

3. **scheduled-tasks** now includes `x-cron-secret` header when invoking downstream functions via `run_now`.

4. **optimizer self-invoke** now includes `x-cron-secret` header to pass its own gate on re-entry.

5. **CORS headers** updated to allow `x-cron-secret` in preflight responses (both shared `cors.ts` and optimizer's local corsHeaders).

## Files modified

| File | Change |
|------|--------|
| `_shared/cronAuth.ts` | **NEW** — shared caller verification helpers (`verifyCronCaller`, `verifyCronOrUserCaller`) |
| `_shared/cronAuth.test.ts` | **NEW** — 16 tests covering both guards, edge cases, fail-closed behavior |
| `_shared/cors.ts` | Added `x-cron-secret` to allowed CORS headers |
| `data-cleanup/index.ts` | Added `verifyCronCaller` gate |
| `prop-firm-daily-reset/index.ts` | Added `verifyCronCaller` gate |
| `zone-confirmation-scanner/index.ts` | Added `verifyCronCaller` gate |
| `outcome-tracker/index.ts` | Added `verifyCronCaller` gate |
| `bot-daily-review/index.ts` | Added `verifyCronOrUserCaller` gate |
| `bot-weekly-advisor/index.ts` | Added `verifyCronOrUserCaller` gate |
| `advisor/index.ts` | Added `verifyCronOrUserCaller` gate |
| `optimizer/index.ts` | Added `verifyCronOrUserCaller` gate + `x-cron-secret` in self-invoke + CORS header |
| `scheduled-tasks/index.ts` | Added `x-cron-secret` header to downstream function invocations |
| `migrations/20260726120001_add_cron_secret_to_pg_cron_jobs.sql` | **NEW** — Re-issues all 4 pg_cron jobs with `x-cron-secret` header from Vault |

## Tests added

| Test | Assertion |
|------|-----------|
| `verifyCronCaller: returns null with correct secret` | Authorized when secret matches |
| `verifyCronCaller: returns 401 with no header` | Rejects missing header |
| `verifyCronCaller: returns 401 with wrong secret` | Rejects wrong value |
| `verifyCronCaller: returns 401 with user JWT` | Cron-only rejects user path |
| `verifyCronCaller: fail-closed when CRON_SECRET not configured` | Refuses if env not set |
| `verifyCronCaller: returns 401 with empty string secret` | Rejects empty |
| `verifyCronOrUserCaller: authorized via cron-secret path` | Cron path works |
| `verifyCronOrUserCaller: authorized via user JWT path` | User path works |
| `verifyCronOrUserCaller: rejects service role key on user path` | Service key can't bypass |
| `verifyCronOrUserCaller: returns 401 with no headers at all` | Both paths required |
| `verifyCronOrUserCaller: returns 401 with wrong cron secret and no JWT` | Wrong secret rejected |
| `verifyCronOrUserCaller: cron path works without SERVICE_ROLE_KEY` | Paths independent |
| `verifyCronOrUserCaller: user JWT path works without CRON_SECRET` | Paths independent |
| `verifyCronOrUserCaller: both paths missing returns 401` | Fail-closed |
| `verifyCronCaller: timing-safe comparison` | Near-miss rejected |
| `verifyCronOrUserCaller: Bearer prefix required` | Raw token rejected |

## Tests run

```
ok | 1634 passed | 0 failed (17s)
```

(Includes 16 new cronAuth tests + 9 autoApply tests + 1609 existing tests)

## Regression check

- **Cron-only functions**: Verified that with correct `x-cron-secret`, the guard returns null and execution proceeds normally (no change to function behavior when called correctly).
- **Dual-path functions**: Verified user JWT path still works (frontend calls unaffected) and cron path works (scheduled invocations unaffected).
- **Service role key explicitly rejected on user path**: Prevents the scheduled-tasks function's `Authorization: Bearer <SERVICE_ROLE_KEY>` from accidentally satisfying the user-path check — it MUST use `x-cron-secret`.

## Deployment requirement

**Both steps must be completed BEFORE deploying this branch:**

### Step 1: Set CRON_SECRET as an edge function secret
```bash
# Generate a secure random value
CRON_SECRET_VALUE=$(openssl rand -base64 48)
echo "$CRON_SECRET_VALUE"  # Save this — you'll use it in Step 2

# Set it as a Supabase edge function secret
supabase secrets set CRON_SECRET="$CRON_SECRET_VALUE"
```

### Step 2: Store the SAME value in Supabase Vault (for pg_cron access)
Via SQL Editor or Dashboard → Settings → Vault:
```sql
INSERT INTO vault.secrets (name, secret)
VALUES ('cron_secret', '<same-value-from-step-1>');
```

### Step 3: Deploy edge functions + migration together
The migration re-issues the pg_cron jobs with the new header. Deploy both in the same release to avoid a window where functions require the header but cron jobs don't send it.

### Step 4: Verify after deploy
Check `cron.job_run_details` for at least one successful run of each:
```sql
SELECT jobname, status, return_message, start_time
FROM cron.job_run_details
WHERE jobname IN (
  'prop-firm-daily-reset-summer',
  'prop-firm-daily-reset-winter',
  'outcome-tracker-hourly',
  'optimizer-weekly-run'
)
ORDER BY start_time DESC
LIMIT 10;
```

Without Steps 1+2, all cron-only functions will fail-closed (return 401 to everything).

## Open questions

None — pg_cron jobs now covered by the migration.

## Suggested PR title and description

**Title:** `[cron-secret-guard] Add caller verification to all service-role edge functions`

**Description:**
Adds `x-cron-secret` header verification to 8 edge functions that previously accepted any request with a valid Supabase JWT (including anonymous/unrelated users).

- 4 cron-only functions (`data-cleanup`, `prop-firm-daily-reset`, `zone-confirmation-scanner`, `outcome-tracker`) now require the cron secret
- 4 dual-path functions (`bot-daily-review`, `bot-weekly-advisor`, `advisor`, `optimizer`) accept either cron secret OR valid user JWT
- `scheduled-tasks` threads the secret through to downstream invocations
- Shared helper in `_shared/cronAuth.ts` with 16 tests

**Deployment prerequisite:** Run `supabase secrets set CRON_SECRET="$(openssl rand -base64 48)"` before deploying.

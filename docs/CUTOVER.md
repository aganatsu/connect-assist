# Cutover: moving live trading to the new Supabase project

The new project (`rvouzhacxqlbetwcttoe`) has the schema, the functions, market
data, the frontend and a copy of the data. It is **not trading**, because no
cron jobs exist. The old Lovable project (`istpcfaokubxlualybhp`) still is.

This is the sequence that swaps them. The whole risk is in one sentence: for as
long as both have cron, **both bots scan the same symbols and place the same
trades against two copies of the same account**. So the old one must stop before
the new one starts, in one sitting.

## When

Forex closes Friday 17:00 ET and reopens Sunday 17:00 ET. Do this inside that
window. Nothing is mid-flight, no position can move while you work, and if you
have to roll back you have two days to notice.

Do not do it on a weekday. The scanner runs every 5 minutes and the position
manager every minute.

---

## Part 1 — Before the window (safe to do any time)

None of this affects trading.

**1. Vault secrets** on the NEW project, Settings → Vault. All three are read by
the cron jobs:

| Name | Value |
|---|---|
| `supabase_url` | `https://rvouzhacxqlbetwcttoe.supabase.co` |
| `service_role_key` | Settings → API Keys → Legacy tab → `service_role` |
| `cron_secret` | any long random string |

`pg_cron` and `pg_net` are already installed — the baseline migration creates
them. Nothing to enable.

Note on `cron_secret`: **no function reads it.** The jobs send it as a header
and nothing checks it. The service-role key in the `Authorization` header is
what actually authenticates. Set it anyway so the jobs match the file, but do
not mistake it for a second factor.

**2. A secret API key for the data re-sync** (Part 2 step 4). The one used
during migration was deleted. Create a fresh one: Settings → API Keys → New
secret key. Revoke it again when the cutover is done.

**3. Confirm the new project's config is the one you want to trade.**

```sql
select id, updated_at, config_json #> '{tradingStyle}' as style
from bot_configs;
```

Whatever is in that row is what the bot will run from the first cycle. There is
no grace period.

---

## Part 2 — The cutover

### Step 1 — Record the old project's jobs

In the **OLD** SQL editor. Keep this output; it is the rollback list.

```sql
select jobid, jobname, schedule, active from cron.job order by jobname;
```

### Step 2 — Stop the old bot

In the **OLD** SQL editor:

```sql
select cron.unschedule(jobname) from cron.job;
select jobname, active from cron.job;   -- expect zero rows
```

Then wait two minutes for anything mid-flight to finish.

### Step 3 — Check what the old project was holding

In the **OLD** SQL editor:

```sql
select 'open positions' as what, count(*)::text as n from paper_positions
union all select 'live pending orders',
  count(*)::text from pending_orders
  where status in ('pending','awaiting_confirmation','triggered')
union all select 'account balance',
  string_agg(balance::text, ', ') from paper_accounts
union all select 'trades since the migration',
  count(*)::text from paper_trade_history where closed_at > '2026-09-14';
```

**Open positions are the thing to think about.** They were zero when the data
was copied. If there are any now, they exist only on the old project, and the
new project's manager will not know about them. Either close them on the old
project before switching, or accept that they are orphaned — they will sit in
the old database untouched.

**Live pending orders will be lost.** `pending_orders` was deliberately not
carried across. Anything waiting to fill on the old project stays there.

### Step 4 — Re-sync the drifted data

The copy was taken on 2026-09-14. Everything the old bot did since then —
closed trades, balance changes — is not on the new project. Re-run the push for
the tables that move, with a fresh secret key on line 3.

Safe to re-run: it upserts, so rows already present are updated rather than
duplicated.

```sql
do $$
declare
  new_key  text := 'PASTE_A_FRESH_SECRET_KEY';
  base_url text := 'https://rvouzhacxqlbetwcttoe.supabase.co/rest/v1/';
  tables   text[] := array['paper_accounts','paper_trade_history','trade_reasonings'];
  tbl text; gen_cols text[]; batch int := 25; off int; payload jsonb;
begin
  foreach tbl in array tables loop
    select coalesce(array_agg(attname) filter (where attgenerated <> ''), '{}')
      into gen_cols
      from pg_attribute
     where attrelid = ('public.' || tbl)::regclass
       and attnum > 0 and not attisdropped;
    off := 0;
    loop
      execute format(
        'select jsonb_agg((to_jsonb(t) - %L::text[]) || %L::jsonb) '
        'from (select * from public.%I order by ctid limit %s offset %s) t',
        gen_cols,
        case when tbl = 'paper_trade_history'
             then jsonb_build_object('source_pending_order_id', null)
             else '{}'::jsonb end,
        tbl, batch, off) into payload;
      exit when payload is null;
      perform net.http_post(
        url     := base_url || tbl,
        headers := jsonb_build_object(
                     'apikey', new_key, 'Authorization', 'Bearer ' || new_key,
                     'Content-Type', 'application/json',
                     'Prefer', 'return=minimal,resolution=merge-duplicates'),
        body    := payload, timeout_milliseconds := 60000);
      off := off + batch;
    end loop;
  end loop;
end $$;
```

`source_pending_order_id` is nulled because `pending_orders` is empty on the new
project and the foreign key would reject the batch. It is a dead column the bot
never writes.

Wait a minute, then confirm on the NEW project that
`select count(*) from paper_trade_history` matches the old one, and that
`paper_accounts.balance` agrees.

### Step 5 — Refresh the planner statistics

On the **NEW** project, after any bulk load:

```sql
analyze;
```

Skipping this is what produced `canceling statement due to statement timeout` on
the dashboard the first time. A freshly loaded table has no statistics, so the
planner ignores the indexes.

### Step 6 — Start the new bot

On the **NEW** project, run `supabase/cron/setup_cron.sql` in full. Then:

```sql
select jobname, schedule, active from cron.job order by jobname;
```

Expect **13 rows, all active**.

---

## Part 3 — Watch the first hour

The position manager runs every minute and the scanner every five, so problems
appear quickly.

**After ~2 minutes**, on the NEW project:

```sql
select status_code, count(*)
from net._http_response
where created > now() - interval '5 minutes'
group by status_code;
```

`200` is healthy. `401` means the `service_role_key` Vault secret is wrong.
Anything `5xx` — read the function logs.

**After ~10 minutes:**

```sql
select created_at, pairs_scanned, signals_found
from scan_logs
order by created_at desc
limit 5;
```

Rows appearing means the scanner is running. `pairs_scanned = 0` on every row
means it is running but seeing nothing — check `TWELVE_DATA_API_KEY`, because
`candleSource` returns an empty array and logs nothing when the key is missing.

**Also check Edge Functions → bot-scanner → Logs** for
`reserve_api_credit HTTP 401`, which would mean the service-role key is wrong in
a way the cron response codes do not show.

---

## Rollback

If anything is wrong, this reverses in under a minute.

On the **NEW** project:

```sql
select cron.unschedule(jobname) from cron.job;
```

Then re-create the jobs on the **OLD** project from the list captured in Step 1.
The old project's data was never modified by any of this — it is still the
complete record.

Point the frontend back by changing `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY` in Vercel to the old project **and redeploying**
— those are compiled into the bundle, so editing them alone does nothing.

---

## After it is stable

- Revoke the secret API key from Part 1 step 2.
- The old project keeps `scan_logs` (856MB), `rejected_setups` and
  `pending_orders`, none of which were carried. Keep it alive as long as you
  want that history for analysis.
- `strategy-advisor`, `bot-daily-review` and `bot-weekly-advisor` still read
  `LOVABLE_API_KEY` and will fail once the subscription ends. Nothing that
  trades depends on them.

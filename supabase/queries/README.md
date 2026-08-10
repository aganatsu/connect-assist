# supabase/queries

Read-only diagnostic SQL. **Not migrations.**

Nothing in this folder is applied automatically. These are queries you paste into
the Supabase SQL editor to answer a specific question about live data.

Do not move these into `supabase/migrations/`. That directory is applied against
the database on deploy and forms permanent, ordered history — a `SELECT` has no
business there.

| File | Question it answers |
|---|---|
| `gate9_impact.sql` | Is Gate 9 rejecting setups whose adjusted score had already cleared the threshold? See the open items in `CLAUDE.md`. |

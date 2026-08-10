create table if not exists public.telegram_notification_claims (
  claim_key text primary key,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.telegram_notification_claims enable row level security;
revoke all on public.telegram_notification_claims from anon, authenticated;

create index if not exists telegram_notification_claims_expires_at_idx
  on public.telegram_notification_claims (expires_at);

create or replace function public.claim_telegram_notification(
  p_claim_key text,
  p_expires_at timestamptz
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed text;
begin
  insert into public.telegram_notification_claims (claim_key, expires_at)
  values (p_claim_key, p_expires_at)
  on conflict (claim_key) do update
    set expires_at = excluded.expires_at,
        created_at = now()
    where telegram_notification_claims.expires_at <= now()
  returning claim_key into claimed;

  return claimed is not null;
end;
$$;

revoke all on function public.claim_telegram_notification(text, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_telegram_notification(text, timestamptz) to service_role;

comment on table public.telegram_notification_claims is
  'Service-role notification idempotency claims. Prevents concurrent Edge Function instances from sending duplicate Telegram alerts.';

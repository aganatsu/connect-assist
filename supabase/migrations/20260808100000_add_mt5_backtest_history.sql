-- Private MT4/MT5 history files used only by their owner for backtesting.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('backtest-history', 'backtest-history', false, 78643200, array['text/csv','text/plain','application/vnd.ms-excel'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

create table if not exists public.backtest_history_datasets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null,
  source text not null default 'mt5' check (source in ('mt4','mt5')),
  base_timeframe text not null default '1m' check (base_timeframe = '1m'),
  storage_path text not null unique,
  original_filename text not null,
  candle_count integer not null check (candle_count > 0),
  start_at timestamptz not null,
  end_at timestamptz not null,
  timezone text not null default 'UTC',
  validation jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (end_at > start_at)
);

create index if not exists backtest_history_owner_symbol_idx
  on public.backtest_history_datasets (user_id, symbol, created_at desc);

alter table public.backtest_history_datasets enable row level security;
create policy "Users manage own backtest history metadata"
  on public.backtest_history_datasets for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "Users upload own backtest history"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'backtest-history' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Users read own backtest history"
  on storage.objects for select to authenticated
  using (bucket_id = 'backtest-history' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Users delete own backtest history"
  on storage.objects for delete to authenticated
  using (bucket_id = 'backtest-history' and (storage.foldername(name))[1] = auth.uid()::text);

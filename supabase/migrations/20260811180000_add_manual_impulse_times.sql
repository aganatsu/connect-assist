-- Timestamps for a hand-marked impulse.
--
-- Resolving a marking by price alone is ambiguous: price revisits levels, so the
-- matcher has to guess which visit was meant. A leg marked on AUD/JPY in August
-- anchored to an equally-close high from May, producing a 45-bar leg where the
-- drawn one was 8.
--
-- With the time of each swing the resolution is deterministic — the time picks
-- WHICH bars, the price still defines the geometry. Both are needed: chart feeds
-- disagree on bar boundaries (a TradingView "Aug 2" daily can be the bot's
-- "Aug 3"), so the bar is matched by nearest timestamp and then cross-checked
-- against the marked price.
--
-- Nullable: markings created before this migration, and quick markings where the
-- user does not want to type times, still resolve by price.

ALTER TABLE public.manual_impulses
  ADD COLUMN IF NOT EXISTS high_time TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS low_time  TIMESTAMPTZ;

COMMENT ON COLUMN public.manual_impulses.high_time IS
  'When the swing high printed. Optional; disambiguates revisited levels.';
COMMENT ON COLUMN public.manual_impulses.low_time IS
  'When the swing low printed. Optional; disambiguates revisited levels.';

ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS partial_tp_fired boolean NOT NULL DEFAULT false;
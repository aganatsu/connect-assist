ALTER TABLE public.paper_trade_history
  ADD COLUMN IF NOT EXISTS source_pending_order_id UUID
  REFERENCES public.pending_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_paper_trade_history_pending_source
  ON public.paper_trade_history (source_pending_order_id)
  WHERE source_pending_order_id IS NOT NULL;

COMMENT ON COLUMN public.paper_trade_history.source_pending_order_id IS
  'Durable link to the pending lifecycle that produced this closed trade.';

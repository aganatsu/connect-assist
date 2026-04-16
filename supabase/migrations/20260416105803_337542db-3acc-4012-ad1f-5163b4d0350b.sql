
ALTER TABLE public.broker_connections
ADD COLUMN symbol_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.bot_configs
ADD COLUMN connection_id uuid REFERENCES public.broker_connections(id) ON DELETE CASCADE;

ALTER TABLE public.bot_configs
ADD CONSTRAINT bot_configs_user_connection_unique UNIQUE (user_id, connection_id);

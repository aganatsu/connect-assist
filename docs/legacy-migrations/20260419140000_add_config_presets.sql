-- Config Presets: user-saved full config snapshots
CREATE TABLE public.config_presets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.config_presets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own presets" ON public.config_presets FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER update_config_presets_updated_at BEFORE UPDATE ON public.config_presets FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Index for fast lookup by user
CREATE INDEX idx_config_presets_user_id ON public.config_presets (user_id);
-- Prevent duplicate preset names per user
CREATE UNIQUE INDEX idx_config_presets_user_name ON public.config_presets (user_id, name);

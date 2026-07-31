-- Canonical Bot Config change history.
-- Every saved mutation is retained so a setup can be traced back to the
-- configuration that existed when the scanner loaded it.

CREATE TABLE IF NOT EXISTS public.bot_config_change_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  config_id UUID,
  connection_id UUID,
  change_type TEXT NOT NULL
    CHECK (change_type IN ('insert', 'update', 'delete')),
  previous_config JSONB,
  next_config JSONB,
  previous_hash TEXT,
  next_hash TEXT,
  changed_by UUID,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_config_change_log_user_time
  ON public.bot_config_change_log (user_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_bot_config_change_log_config_time
  ON public.bot_config_change_log (config_id, changed_at DESC);

ALTER TABLE public.bot_config_change_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own bot config history"
  ON public.bot_config_change_log;
CREATE POLICY "Users can read own bot config history"
  ON public.bot_config_change_log
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.bot_config_change_log FROM anon;
GRANT SELECT ON public.bot_config_change_log TO authenticated;
GRANT ALL ON public.bot_config_change_log TO service_role;

CREATE OR REPLACE FUNCTION public.audit_bot_config_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old JSONB := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.config_json END;
  v_new JSONB := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.config_json END;
  v_user_id UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
  v_config_id UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  v_connection_id UUID := CASE
    WHEN TG_OP = 'DELETE' THEN OLD.connection_id
    ELSE NEW.connection_id
  END;
BEGIN
  IF TG_OP = 'UPDATE' AND v_old IS NOT DISTINCT FROM v_new THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.bot_config_change_log (
    user_id,
    config_id,
    connection_id,
    change_type,
    previous_config,
    next_config,
    previous_hash,
    next_hash,
    changed_by
  ) VALUES (
    v_user_id,
    v_config_id,
    v_connection_id,
    lower(TG_OP),
    v_old,
    v_new,
    CASE WHEN v_old IS NULL THEN NULL ELSE md5(v_old::TEXT) END,
    CASE WHEN v_new IS NULL THEN NULL ELSE md5(v_new::TEXT) END,
    auth.uid()
  );

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS audit_bot_config_change ON public.bot_configs;
CREATE TRIGGER audit_bot_config_change
AFTER INSERT OR UPDATE OR DELETE
ON public.bot_configs
FOR EACH ROW
EXECUTE FUNCTION public.audit_bot_config_change();

COMMENT ON TABLE public.bot_config_change_log IS
  'Append-only history of Bot Config mutations for runtime and trade provenance.';

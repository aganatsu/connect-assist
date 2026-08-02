CREATE OR REPLACE FUNCTION public.mirror_staged_setup_resolution_reason()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status IN ('invalidated', 'expired', 'cancelled', 'blocked_after_qualification') THEN
    IF NEW.invalidation_reason IS NULL OR btrim(NEW.invalidation_reason) = '' THEN
      NEW.invalidation_reason := NULLIF(btrim(COALESCE(NEW.lifecycle_reason, '')), '');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mirror_staged_setup_resolution_reason ON public.staged_setups;
CREATE TRIGGER trg_mirror_staged_setup_resolution_reason
BEFORE INSERT OR UPDATE ON public.staged_setups
FOR EACH ROW
EXECUTE FUNCTION public.mirror_staged_setup_resolution_reason();
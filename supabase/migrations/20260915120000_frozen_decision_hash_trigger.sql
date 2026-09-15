-- Step 1 of the frozen decision record (docs/FROZEN_DECISION_RECORD.md).
--
-- Each of pending_orders, paper_positions and staged_setups carries
--   CHECK (frozen_strategy_context IS NULL
--          OR frozen_strategy_hash = md5(frozen_strategy_context::text))
--
-- The trap: frozen_strategy_context::text is POSTGRES's normalised rendering of
-- the jsonb — its own key ordering and whitespace. An md5 computed in
-- TypeScript over the JSON the function sent will not match it, and the insert
-- is rejected. Every caller would have to know that, and one of them
-- eventually would not.
--
-- So the database computes it. After this, the constraint cannot be violated
-- and no caller needs to know the rule exists.
--
-- Note strategy_activation_json_hash() already exists and uses sha256; it is
-- NOT the hasher for this column, which the constraints pin to md5.
--
-- Nothing writes frozen_strategy_context yet, so this changes no behaviour
-- today. It is deliberately first: it cannot break anything, and it makes the
-- next step safe.

CREATE OR REPLACE FUNCTION public.set_frozen_strategy_hash()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  -- NULL context means no decision was frozen. Hashing '{}' instead would
  -- make an absent record indistinguishable from an empty one.
  IF NEW.frozen_strategy_context IS NULL THEN
    NEW.frozen_strategy_hash := NULL;
  ELSE
    NEW.frozen_strategy_hash := md5(NEW.frozen_strategy_context::text);
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.set_frozen_strategy_hash() IS
  'Keeps frozen_strategy_hash equal to md5 of the stored jsonb text. The hash must be computed over Postgres''s own normalisation of the value, so it cannot be done client-side. See docs/FROZEN_DECISION_RECORD.md.';

-- BEFORE UPDATE as well as INSERT: if the context is ever amended the hash
-- must follow it, or the row silently stops satisfying its own constraint.
DROP TRIGGER IF EXISTS set_frozen_strategy_hash_pending ON public.pending_orders;
CREATE TRIGGER set_frozen_strategy_hash_pending
  BEFORE INSERT OR UPDATE OF frozen_strategy_context ON public.pending_orders
  FOR EACH ROW EXECUTE FUNCTION public.set_frozen_strategy_hash();

DROP TRIGGER IF EXISTS set_frozen_strategy_hash_position ON public.paper_positions;
CREATE TRIGGER set_frozen_strategy_hash_position
  BEFORE INSERT OR UPDATE OF frozen_strategy_context ON public.paper_positions
  FOR EACH ROW EXECUTE FUNCTION public.set_frozen_strategy_hash();

DROP TRIGGER IF EXISTS set_frozen_strategy_hash_staged ON public.staged_setups;
CREATE TRIGGER set_frozen_strategy_hash_staged
  BEFORE INSERT OR UPDATE OF frozen_strategy_context ON public.staged_setups
  FOR EACH ROW EXECUTE FUNCTION public.set_frozen_strategy_hash();

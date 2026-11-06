-- Tier scoring and the confluence score were removed (feat/remove-tier-scoring).
-- This strips the config keys that only fed them from saved bot configs and presets.
--
-- APPLY ONLY AFTER THE CODE IS DEPLOYED. Several of these keys are load-bearing for
-- the OLD scanner: Baseline A stores the score/tier gates as "off" (tier1GateEnabled
-- false, scoreGateMode "log", stagingEnabled false). Deleting them while the old
-- bot-scanner still runs makes it fall back to its defaults and switch those gates
-- back ON. The new code reads none of them, so after deploy this is a no-op for trading.
--
-- Also normalises a stored "soft" gate mode to "off" for the gates that no longer have
-- a soft mode (the scanner already runs "soft" as off via hardOrOff); gamePlanGateMode
-- keeps "soft" (advisory pass) and is untouched.
--
-- The config hash changes (attribution config_version / bot_config_history get a new row
-- on the next scan). The audit_bot_config_change trigger records every row's previous
-- config in bot_config_change_log, which is the undo record.
--
-- Re-runnable: removing an absent key and re-mapping "off" are no-ops.

create or replace function pg_temp.strip_tier_score(c jsonb) returns jsonb
language plpgsql as $$
declare
  dead text[] := array[
    'confluenceThreshold', 'minConfluenceScore', 'minConfluence', 'normalizedScoring',
    'tier1GateEnabled', 'minTier1Factors', 'tier1RequireAtPOI',
    'stagingEnabled', 'watchThreshold', 'stagingTTLMinutes', 'minStagingCycles',
    'regimeScoringStrength', 'impulseZonePenalty', 'impulseZoneBonus',
    'ictHTFAlignedBonus', 'ictHTFMisalignedPenalty', 'ictDisplacementMSSPenalty',
    'ictJudasSwingPenalty', 'ictFVGInvalidatedPenalty', 'ictFVGExhaustedPenalty',
    'ictKillZonePrimeBonus', 'ictKillZoneOutsidePenalty',
    'factorWeights', 'conflictThresholdRaise'
  ];
  modes text[] := array[
    'impulseZoneGateMode', 'ictHTFGateMode', 'ictDisplacementMSSGateMode',
    'ictJudasSwingGateMode', 'ictFVGInvalidationGateMode', 'ictKillZoneGateMode'
  ];
  k text;
  sym text;
begin
  if c is null or jsonb_typeof(c) <> 'object' then return c; end if;

  -- keys are read as strategy.X ?? X, so both places
  c := c - dead;
  if jsonb_typeof(c->'strategy') = 'object' then
    c := jsonb_set(c, '{strategy}', (c->'strategy') - dead);
  end if;
  if jsonb_typeof(c->'risk') = 'object' then
    c := jsonb_set(c, '{risk}', (c->'risk') - 'conflictThresholdRaise');
  end if;
  if jsonb_typeof(c->'simplification') = 'object' then
    c := jsonb_set(c, '{simplification}', (c->'simplification') - 'scoreGateMode');
  end if;

  if jsonb_typeof(c->'pairGateOverrides') = 'object' then
    for sym in select jsonb_object_keys(c->'pairGateOverrides') loop
      if jsonb_typeof(c->'pairGateOverrides'->sym) = 'object' then
        c := jsonb_set(c, array['pairGateOverrides', sym],
                       (c->'pairGateOverrides'->sym) - array['minTier1Factors', 'minConfluence']);
      end if;
    end loop;
  end if;

  foreach k in array modes loop
    if c->>k = 'soft' then c := jsonb_set(c, array[k], '"off"'); end if;
    if jsonb_typeof(c->'strategy') = 'object' and c->'strategy'->>k = 'soft' then
      c := jsonb_set(c, array['strategy', k], '"off"');
    end if;
  end loop;

  return c;
end $$;

update public.bot_configs
   set config_json = pg_temp.strip_tier_score(config_json)
 where config_json is distinct from pg_temp.strip_tier_score(config_json);

update public.config_presets
   set config_json = pg_temp.strip_tier_score(config_json)
 where config_json is distinct from pg_temp.strip_tier_score(config_json);

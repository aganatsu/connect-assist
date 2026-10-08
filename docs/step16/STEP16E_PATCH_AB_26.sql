-- STEP 16-E — store the 26 live code-default-only controls explicitly (approved set A+B, 2026-10-08).
-- Run ONCE, by hand, in the SQL editor — only after the PR is merged AND the production PATCH is approved.
-- Zero behaviour change: docs/STEP16E_EFFECT_REPORT.md; proof and an execution of THIS file in real Postgres:
-- supabase/tests/_shared/step16eExplicitDefaults.test.ts.
-- One transaction. Server-side jsonb_set so every existing byte is preserved (a client round-trip would
-- rewrite "orderRRMin": 1.0 as 1 and change the hash). Guarded: updates only the row that still has the old
-- hash, and aborts unless the result is exactly the proven new hash.
--   old  3d5b8fb0d756b3596ed46d133e873a88
--   new  1037e6170289f865e4d6618dcf28b94d   (behaviour-equivalent, NOT identical: supabase/tests/_shared/step16eExplicitDefaults.test.ts)
begin;
update public.bot_configs
   set config_json = jsonb_set(jsonb_set(jsonb_set(config_json,
           '{strategy}', coalesce(config_json -> 'strategy', '{}'::jsonb) || '{"impulseZoneEnabled": true, "legStopBufferPct": 0.02, "legStopCapMultiple": 1.2, "useSimpleDirection": true, "useConfirmedTrend": true, "confirmedTrendFibFactor": 0.25, "confirmedTrendSwingLookback": 5, "simpleDirectionH1BosLookback": 8, "simpleDirectionH4ChochLookback": 10, "zoneChaseMaxZoneWidths": 1, "thesisValidationEnabled": true, "thesisCheckDirectionFlip": true, "ictHTFEnabled": true, "atrDerivedFloorsEnabled": false, "gamePlanGateMode": "soft", "zoneAnchoredStop": false, "requireUnifiedZone": false, "priceAwareStructureBlocks": false, "thesisDirectionStyleAware": false, "htfBiasHardVeto": false, "ictHTFGateMode": "off", "ictKillZoneGateMode": "off", "ictJudasSwingGateMode": "off", "ictDisplacementMSSGateMode": "off"}'::jsonb),
           '{sessions}', coalesce(config_json -> 'sessions', '{}'::jsonb) || '{"killZoneOnly": false}'::jsonb),
           '{entry}', coalesce(config_json -> 'entry', '{}'::jsonb) || '{"limitOrderEnabled": false}'::jsonb)
 where id = '327912ae-4e5b-4677-ad04-7c5d566f7990'
   and config_version = '3d5b8fb0d756b3596ed46d133e873a88';
do $$
begin
  if (select config_version from public.bot_configs where id = '327912ae-4e5b-4677-ad04-7c5d566f7990') is distinct from '1037e6170289f865e4d6618dcf28b94d' then
    raise exception 'STEP16E_PATCH_ABORTED: result hash % is not the proven 1037e6170289f865e4d6618dcf28b94d (row changed since 3d5b8fb0?)',
      (select config_version from public.bot_configs where id = '327912ae-4e5b-4677-ad04-7c5d566f7990');
  end if;
end $$;
commit;
-- read-only verification (one row): expect config_version = 1037e6170289f865e4d6618dcf28b94d, change-log prev 3d5b8fb0… → next 1037e617…
select c.config_version, c.updated_at,
       (select previous_hash || ' -> ' || next_hash from public.bot_config_change_log l where l.config_id = c.id order by l.changed_at desc limit 1) as last_change
  from public.bot_configs c where c.id = '327912ae-4e5b-4677-ad04-7c5d566f7990';

UPDATE public.bot_configs
SET config_json = jsonb_set(
  jsonb_set(
    jsonb_set(config_json, '{exit,partialTPEnabled}', 'true'::jsonb, true),
    '{exit,partialTPPercent}', '50'::jsonb, true),
  '{exit,partialTPLevel}', '1.0'::jsonb, true);
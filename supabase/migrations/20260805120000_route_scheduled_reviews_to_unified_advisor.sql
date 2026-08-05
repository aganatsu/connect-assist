-- Route existing stored review schedules through the single Advisor function.
-- The action carries the mode so scheduled-tasks can build the correct request.
UPDATE public.scheduled_tasks
SET function_name = 'advisor',
    action = 'daily',
    display_name = 'Daily Review',
    description = 'Unified Advisor analysis of recent trades and authority evidence',
    updated_at = now()
WHERE function_name = 'bot-daily-review';

UPDATE public.scheduled_tasks
SET function_name = 'advisor',
    action = 'weekly',
    display_name = 'Weekly Review',
    description = 'Unified Advisor deep review of performance and authority evidence',
    updated_at = now()
WHERE function_name = 'bot-weekly-advisor';

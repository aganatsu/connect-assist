CREATE TEMP TABLE scan_logs_keep AS
SELECT * FROM public.scan_logs WHERE scanned_at >= now() - interval '30 days';

TRUNCATE public.scan_logs;

INSERT INTO public.scan_logs SELECT * FROM scan_logs_keep;

DROP TABLE scan_logs_keep;
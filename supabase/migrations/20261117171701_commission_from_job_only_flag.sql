INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES ('commission_from_job_only_v1', false, 'Commission is claimed only at the job''s stored figure. Off: a job with no commission record accepts a typed amount.')
ON CONFLICT (flag_name) DO NOTHING;

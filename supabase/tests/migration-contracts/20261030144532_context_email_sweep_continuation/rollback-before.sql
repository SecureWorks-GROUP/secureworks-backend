INSERT INTO public.context_email_sweep_windows(source_key,window_from,window_to) VALUES('retained_fixture',now()-interval '48 hours',now());
UPDATE public.feature_flags SET enabled=true WHERE flag_name='email_sweep_continuation_v1';

-- A point's switch is already on before its checks exist (someone made the
-- row by hand). Applying the migration would start that point at merge: the
-- guard must refuse and say which switch.
INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES ('context_jev_point_email_triage', true, 'hand-made');

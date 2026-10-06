-- The Jev switch is already on before the log exists (someone created the row
-- by hand). Applying the migration would switch Jev on at merge with nowhere to
-- write: the guard must refuse and say so.
INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES ('context_jev_shadow_v1', true, 'hand-made');

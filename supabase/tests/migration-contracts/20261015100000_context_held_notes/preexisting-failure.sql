-- The switch is already on before the first apply: the migration must refuse.
INSERT INTO public.feature_flags (flag_name, enabled, description) VALUES ('context_held_notes_v1', true, 'switched on by hand');

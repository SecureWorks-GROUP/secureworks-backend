-- The story switch is already on before the store exists (someone created the
-- row by hand). Applying the migration would start the story writer at merge
-- with nowhere to write: the guard must refuse and say so.
INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES ('context_job_story_text_v1', true, 'hand-made');

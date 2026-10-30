CREATE OR REPLACE FUNCTION public.context_job_story_enqueue_changed(p_limit integer DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;

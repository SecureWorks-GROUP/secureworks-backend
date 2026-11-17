-- Remove the sentence-ref binding. The real read contract must notice.
CREATE OR REPLACE FUNCTION public.job_truth_story_sentences(p_sections jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT '[]'::jsonb $$;

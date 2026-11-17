-- P0-02.3 backend read side only. No triggers, timers or worker change.
-- Preserve any existing operator setting on replay.
INSERT INTO public.feature_flags(flag_name,enabled,description)
VALUES ('job_story_stored_page_v1',false,'Read the current job story from its stored job page. Historical reads retain the existing reader.')
ON CONFLICT(flag_name) DO NOTHING;

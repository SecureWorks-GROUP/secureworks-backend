-- Rollback of 20261115091000: first stories are again written only when a person asks.
-- Requests it queued stay (they are ordinary job_changed requests); stories it led to stay.
DROP FUNCTION IF EXISTS public.context_job_story_enqueue_first(integer);
DROP FUNCTION IF EXISTS public.context_job_story_first_policy();

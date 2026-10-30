-- Rollback of 20261030030000_context_job_story_text_on: the saved job story off again.
UPDATE public.feature_flags
SET enabled = false,
    description = 'Saved job story (20261009100000): while on, the Luna context worker (secureworks-jarvis) writes the short story of each live job (five plain sections from the job card and live AI notes, every amount and date checked against them), rewrites it when something new happens, and staff can ask for a rewrite from the job page. Each story is one model call from the shared day (reserve_context_model_call phase story: at most context_job_story_text_policy() calls_per_day a Perth day, never inside the ledger''s live reserve). Off: nothing is queued, claimed or called, and the job page shows no saved story. Owner''s word to turn on.',
    updated_at = now()
WHERE flag_name = 'context_job_story_text_v1';

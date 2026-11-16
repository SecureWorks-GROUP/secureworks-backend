-- Remove the promised behaviour: the copy test drops the payload key, so a mail whose only copy names
-- it in the payload is no longer counted and the contract's count of four must fail.
SELECT pg_get_functiondef('public.context_job_story_meta(uuid,timestamptz)'::regprocedure) AS card_speed_def \gset
SELECT replace(:'card_speed_def', $r$c.payload ? 'inbox_events_id' AND (c.payload ->> 'inbox_events_id') = m.id::text$r$,
               $r$false AND (c.payload ->> 'inbox_events_id') = m.id::text$r$) AS card_speed_broken \gset
:card_speed_broken;

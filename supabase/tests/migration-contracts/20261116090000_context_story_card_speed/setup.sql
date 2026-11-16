-- Prerequisites for 20261116090000_context_story_card_speed. The story meta it rewrites comes from the
-- earlier registered setups and migrations. Its payload-key read is answered by the index production
-- holds from 20261103150000 (not a registered case, so not in this stack): built here as that
-- migration builds it.
CREATE INDEX IF NOT EXISTS business_events_inbox_events_id_any_source
  ON public.business_events ((payload ->> 'inbox_events_id'))
  WHERE payload ? 'inbox_events_id';

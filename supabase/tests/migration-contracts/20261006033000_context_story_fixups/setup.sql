-- Prerequisites for 20261006033000_context_story_fixups: none of its own. It
-- replaces five bodies of the record layer (20261006011000) and the story
-- (20261006014000), whose registered setups create every table and column these
-- bodies read (job_events.detail_json, email_events.metadata, job_documents and
-- job_assignments as they are live). The case always runs after them.
SELECT 1 AS story_fixups_setup;

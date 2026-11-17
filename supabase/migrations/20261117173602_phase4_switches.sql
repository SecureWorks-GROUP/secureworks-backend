-- P4-01.5: latest launch instruction seeds every new switch off.
-- Existing rows are never changed. No consumer is installed by this migration.
INSERT INTO public.feature_flags (flag_name, enabled, description) VALUES
  ('context_fact_read_v1', false, 'While on, the worker runs the old fact reader. Off stops it; notes, story and bills keep running.'),
  ('context_record_close_v1', false, 'While on, code closes an open item when a record closes it. Off: it only reports what it would close.'),
  ('context_story_code_parts_v1', false, 'While on, code writes the headline, the job line and where it is at; the AI writes two parts.'),
  ('context_checker_must_differ_v1', false, 'While on, a story is saved only when its checker is a different model family from its writer.'),
  ('job_page_stored_read_v1', false, 'While on, Ops and agents read the stored job page.'),
  ('agent_money_press_v1', false, 'While on, a money action asked by anything but a signed-in person becomes a proposal a person must press.'),
  ('agent_money_press_observe_v1', false, 'While on (and the press switch off), the gate only records what it would catch.'),
  ('ops_chat_engine_agent_v1', false, 'While on, the Ops chat uses the agent service.')
ON CONFLICT (flag_name) DO NOTHING;

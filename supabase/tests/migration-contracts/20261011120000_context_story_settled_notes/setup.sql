-- Prerequisites for 20261011120000_context_story_settled_notes: none of its own. The assembler is
-- pure (it reads no table), and the story read's new meta key reads business_events, which the
-- earlier registered setups and migrations create, with every function both bodies call.
SELECT 1;

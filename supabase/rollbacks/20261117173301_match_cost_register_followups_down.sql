-- Restore the preceding service-role grants and remove only the added seed.
GRANT TRUNCATE, TRIGGER, REFERENCES ON TABLE public.match_clue_types,
  public.match_clues, public.match_queue, public.match_shadow_runs, public.match_rules
  TO service_role;
GRANT TRUNCATE, TRIGGER, REFERENCES ON TABLE public.job_cost_lines,
  public.job_cost_line_parts TO service_role;
GRANT DELETE, TRUNCATE ON TABLE public.xero_draft_register,
  public.bookkeeping_checks TO service_role;
DELETE FROM public.match_clue_types WHERE code = 'who_ordered';

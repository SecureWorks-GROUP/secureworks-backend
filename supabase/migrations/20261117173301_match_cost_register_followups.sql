-- P0-08.4 follow-ups 5 and 6. No active switch or business-row update.
INSERT INTO public.match_clue_types (code, class, family, mode, words)
SELECT 'who_ordered', 'narrower', 'history', 'off', 'Who ordered it (shown only)'
WHERE NOT EXISTS (SELECT 1 FROM public.match_clue_types WHERE code = 'who_ordered');

REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE public.match_clue_types,
  public.match_clues, public.match_queue, public.match_shadow_runs, public.match_rules
  FROM service_role;
REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE public.job_cost_lines,
  public.job_cost_line_parts FROM service_role;
REVOKE DELETE, TRUNCATE ON TABLE public.xero_draft_register,
  public.bookkeeping_checks FROM service_role;

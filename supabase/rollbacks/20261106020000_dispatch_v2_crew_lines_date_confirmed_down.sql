-- Down for 20261106020000_dispatch_v2_crew_lines_date_confirmed. Roll back
-- ops-api first (it writes trigger 'date_confirmed'). Lines already written
-- with 'date_confirmed' are relabelled 'date_set' so the narrower CHECK holds;
-- the notes themselves stay in the crew thread.
UPDATE public.dispatch_v2_order_crew_lines
  SET trigger = 'date_set'
  WHERE trigger = 'date_confirmed';

ALTER TABLE public.dispatch_v2_order_crew_lines
  DROP CONSTRAINT IF EXISTS dispatch_v2_order_crew_lines_trigger_valid;

ALTER TABLE public.dispatch_v2_order_crew_lines
  ADD CONSTRAINT dispatch_v2_order_crew_lines_trigger_valid CHECK (
    trigger IN ('accept', 'stage_set', 'date_set')
  );

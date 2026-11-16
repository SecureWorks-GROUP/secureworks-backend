-- Rollback for 20261116003000_sep_reconcile_placements: removes exactly what that migration wrote
-- (rows stamped with its actor) and reopens those queue rows. A bill a person has changed since
-- (another actor on its fact or queue row) is left alone.
DO $rollback$
DECLARE
  c_actor CONSTANT text := 'marnin (approved list, migration 20261116003000)';
BEGIN
  UPDATE public.materials_reconciliation_queue q
     SET status = 'open', assigned_job_id = NULL, assigned_by = NULL, assigned_at = NULL,
         overhead_ex = NULL, overhead_note = NULL, updated_at = now()
   WHERE q.assigned_by = c_actor AND q.status IN ('assigned', 'split');
  DELETE FROM public.job_materials_facts f WHERE f.assigned_by = c_actor;
  DELETE FROM public.job_events e
   WHERE e.event_type IN ('materials_bill_assigned', 'materials_bill_split')
     AND e.detail_json ->> 'assigned_by' = c_actor;
END
$rollback$;

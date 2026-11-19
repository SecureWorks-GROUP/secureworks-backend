-- A rule for every command on job_events that applies to PUBLIC grants reads
-- too; the migration cannot split it safely, so it must refuse.
CREATE POLICY fv_every_command ON public.job_events FOR ALL
  USING (EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = job_events.job_id AND j.org_id = public.auth_org_id()));

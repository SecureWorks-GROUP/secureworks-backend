-- Open job_events reads to every signed-in caller in the company again (the
-- old rule, for authenticated): the trade case must catch it.
CREATE POLICY fv_open_read ON public.job_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = job_events.job_id AND j.org_id = public.auth_org_id()));

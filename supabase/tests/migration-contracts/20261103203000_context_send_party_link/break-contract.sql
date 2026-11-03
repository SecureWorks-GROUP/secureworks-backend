-- Ship C14 without the job_events hook: a staff text from a job links nobody,
-- so the neighbour's texts still find no job. The contract must catch it.
DROP TRIGGER context_job_event_send_link ON public.job_events;

-- Preserve held office review records. Rollback removes automatic capture only.
DROP TRIGGER IF EXISTS invoice_review_when_scheduled ON public.jobs;
DROP TRIGGER IF EXISTS invoice_review_when_council_step_complete ON public.council_submissions;
DROP FUNCTION IF EXISTS public.capture_scheduled_invoice_review();
DROP FUNCTION IF EXISTS public.capture_council_invoice_review();
DROP TRIGGER IF EXISTS invoice_review_when_install_booked ON public.job_assignments;
DROP FUNCTION IF EXISTS public.capture_booking_invoice_review();
DROP FUNCTION IF EXISTS public.enqueue_invoice_milestone_review(uuid,text,text,jsonb);

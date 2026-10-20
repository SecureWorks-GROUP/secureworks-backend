-- Restore the narrow read a consumer would write by hand: only rows whose job_id is the job.
CREATE OR REPLACE FUNCTION public.context_job_mail(p_job uuid, p_limit int DEFAULT 100, p_roles text[] DEFAULT NULL)
RETURNS TABLE (event_id uuid, occurred_at timestamptz, direction text, from_address text, subject text,
               preview text, provider_message_id text, counterpart_role text, placement text, by text,
               reason text, other_jobs jsonb)
LANGUAGE sql STABLE AS $$
  SELECT e.id, e.occurred_at, e.direction, e.payload ->> 'from', e.payload ->> 'subject', NULL::text,
         e.provider_message_id, NULL::text, 'certain'::text, 'ladder'::text, NULL::text, '[]'::jsonb
  FROM public.business_events e WHERE e.job_id = p_job AND e.channel = 'email'
  ORDER BY e.occurred_at DESC LIMIT p_limit
$$;

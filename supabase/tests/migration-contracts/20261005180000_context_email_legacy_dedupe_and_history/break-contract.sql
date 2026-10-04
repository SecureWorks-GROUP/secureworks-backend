-- Ship the old-path lookup without its source filter: the reader's own row
-- would then count as an old copy and real mail would be skipped. The
-- contract must catch it.
CREATE OR REPLACE FUNCTION public.context_email_legacy_copy(p_from text,p_received_at timestamptz,p_subject text DEFAULT NULL)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH k AS (
  SELECT lower(btrim(p_from)) AS sender,
   nullif(lower(regexp_replace(btrim(coalesce(p_subject,'')),'\s+',' ','g')),'(no subject)') AS subject
 )
 SELECT e.id FROM public.business_events e, k
 WHERE k.sender<>'' AND p_received_at IS NOT NULL
  AND e.occurred_at BETWEEN p_received_at-interval '2 minutes' AND p_received_at+interval '2 minutes'
  AND lower(btrim(e.payload->>'from'))=k.sender
  AND (e.occurred_at=p_received_at
   OR (nullif(k.subject,'') IS NOT NULL
    AND lower(regexp_replace(btrim(coalesce(e.payload->>'subject','')),'\s+',' ','g'))=k.subject))
 ORDER BY (e.occurred_at=p_received_at) DESC, abs(extract(epoch FROM e.occurred_at-p_received_at)), e.id
 LIMIT 1
$$;

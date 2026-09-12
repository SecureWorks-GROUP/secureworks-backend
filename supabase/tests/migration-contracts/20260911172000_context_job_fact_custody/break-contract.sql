CREATE OR REPLACE FUNCTION public.context_fact_expiry(p_kind text,p_event_at timestamptz,p_due_date date DEFAULT NULL)
RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 RETURN CASE p_kind
  WHEN 'current_state' THEN (((p_event_at AT TIME ZONE 'Australia/Perth')::date+1)::timestamp AT TIME ZONE 'Australia/Perth')
  WHEN 'pending_action' THEN CASE WHEN p_due_date IS NOT NULL THEN ((p_due_date+1)::timestamp AT TIME ZONE 'Australia/Perth') ELSE p_event_at+interval '168 hours' END
  WHEN 'quote_issue' THEN p_event_at+interval '336 hours'
  WHEN 'proposal' THEN p_event_at+interval '504 hours'
  ELSE NULL END;
END $$;

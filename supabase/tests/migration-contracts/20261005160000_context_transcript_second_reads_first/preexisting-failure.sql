-- The due-call selection is no longer T2's body (a change this migration was
-- not written against): the guard must refuse rather than overwrite it.
CREATE OR REPLACE FUNCTION public.context_transcript_due_calls(p_limit integer DEFAULT 40,p_history boolean DEFAULT false)
RETURNS TABLE (call_event_id uuid, call_message_id text, event_type text, event_at timestamptz, contact_id text,
 conversation_key text, direction text, call_status text, duration_seconds numeric, call_sid text, line text,
 from_line text, by_user text, capture_mode text, transcript_event_id uuid, attempts integer,
 seen_sentences integer, seen_digest text, seen_at timestamptz, job_numbers text[], fetch_mode text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT NULL::uuid,NULL::text,NULL::text,NULL::timestamptz,NULL::text,NULL::text,NULL::text,NULL::text,NULL::numeric,NULL::text,NULL::text,
  NULL::text,NULL::text,NULL::text,NULL::uuid,NULL::integer,NULL::integer,NULL::text,NULL::timestamptz,NULL::text[],NULL::text WHERE false
$$;

-- T2b (context finish, 5 Oct 2026): call transcripts start saving on the next
-- run, whatever the backlog.
--
-- Why (first live runs, 4 Oct 2026 22:36Z and 22:41Z: 40 calls selected each,
-- 0 saved): a transcript saves only when two reads at least 5 minutes apart
-- agree (review M10, unchanged here). context_transcript_due_calls ordered
-- every due call by call time alone, so a call waiting for its agreeing second
-- read competed for the 40 places with every never-read call older than it.
-- On a backlog (198 calls at switch-on) a newer call's second read waited
-- until every older call had been read once; the agreeing read, the one that
-- saves, came last.
--
-- Changed: only the ORDER BY of context_transcript_due_calls. Due calls whose
-- fetch record last read words and waits for agreement
-- (last_code awaiting_agreement) come first, then the rest oldest first as
-- before. What is due, the limit, the window, history mode, the columns and
-- the agreement rule are unchanged. No row is written; no flag or switch
-- changes. Voicemails GHL cannot transcribe end in the edge function
-- (voicemail_no_transcript), not here.
--
-- Built on T2's body (20261002100000):
--   context_transcript_due_calls(integer,boolean)  md5(prosrc) 74d87e872300c883676c6ed8a3188023
-- Whether production still carries that body was not observed (read-only
-- task); the guard refuses unless it is T2's or already this migration's.
-- The new comment starts "T2b:", so it is easy to tell which body is live.
--
-- Rollback: supabase/rollbacks/20261005011500_context_transcript_second_reads_first_down.sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Pre-image guard.
DO $guard$
DECLARE live text;
BEGIN
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.context_transcript_due_calls(integer,boolean)');
 IF live IS NULL OR NOT live=ANY(ARRAY['74d87e872300c883676c6ed8a3188023','4e67b697860f6206c30d1e107dd62677']) THEN
  RAISE EXCEPTION 'context_transcript_second_reads_first_preimage_mismatch: public.context_transcript_due_calls(integer,boolean) md5 %; read the live definition before replacing it',coalesce(live,'<missing>');
 END IF;
END $guard$;

-- 1. Calls due a fetch now: second reads first, then oldest first.
CREATE OR REPLACE FUNCTION public.context_transcript_due_calls(p_limit integer DEFAULT 40,p_history boolean DEFAULT false)
RETURNS TABLE (call_event_id uuid, call_message_id text, event_type text, event_at timestamptz, contact_id text,
 conversation_key text, direction text, call_status text, duration_seconds numeric, call_sid text, line text,
 from_line text, by_user text, capture_mode text, transcript_event_id uuid, attempts integer,
 seen_sentences integer, seen_digest text, seen_at timestamptz, job_numbers text[], fetch_mode text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH policy AS (SELECT public.context_transcript_capture_policy() AS p),
 live AS (
  -- History only: the GHL contacts of the jobs live now (M4's one definition).
  SELECT l.ghl_contact_id AS contact, array_agg(l.job_number ORDER BY l.job_number) AS job_numbers
  FROM public.context_ghl_history_live_jobs() l
  WHERE coalesce(p_history,false) AND l.ghl_contact_id IS NOT NULL
  GROUP BY l.ghl_contact_id
 ),
 calls AS (
  SELECT e.*, substr(e.provider_message_id,5) AS msg, lv.job_numbers
  FROM public.business_events e CROSS JOIN policy
  LEFT JOIN live lv ON lv.contact=e.contact_id
  WHERE e.event_type IN (SELECT jsonb_array_elements_text(policy.p->'call_event_types'))
   AND e.provider_message_id LIKE 'ghl:%'
   AND CASE WHEN coalesce(p_history,false)
    THEN e.event_at <= now()-make_interval(days=>(policy.p->>'window_days')::integer) AND lv.contact IS NOT NULL
    ELSE (e.event_at > now()-make_interval(days=>(policy.p->>'window_days')::integer) AND e.event_at <= now())
     OR e.id IN (SELECT b.call_event_id FROM public.call_transcript_fetches b
      WHERE b.mode='backfill' AND b.outcome='pending' AND b.next_at<=now()) END
 )
 SELECT c.id, c.msg, c.event_type, c.event_at, c.contact_id, c.conversation_key, c.direction,
  c.payload->>'call_status',
  CASE WHEN jsonb_typeof(c.payload->'duration_seconds')='number' THEN (c.payload->>'duration_seconds')::numeric END,
  c.payload->>'call_sid', c.payload->>'line', c.payload->>'from_line', c.payload->>'by_user',
  coalesce(c.metadata->>'capture_mode','live'), tx.id, coalesce(f.attempts,0), f.seen_sentences, f.seen_digest, f.seen_at,
  c.job_numbers, f.mode
 FROM calls c
 LEFT JOIN public.call_transcript_fetches f ON f.call_message_id=c.msg
 LEFT JOIN public.business_events tx ON tx.provider_message_id='ghltx:'||c.msg
 WHERE c.msg ~ '^[A-Za-z0-9_-]{6,64}$'
  AND (f.call_message_id IS NULL OR (f.outcome='pending' AND f.next_at<=now()))
  AND (tx.id IS NOT NULL OR public.context_call_transcript_eligible(c.event_type,c.provider_message_id,c.payload))
 -- T2b: a call waiting for its agreeing second read goes first, whatever the
 -- backlog of calls never read; then oldest first.
 ORDER BY CASE WHEN f.last_code='awaiting_agreement' THEN 0 ELSE 1 END, c.event_at, c.id
 LIMIT greatest(1,least(coalesce(p_limit,40),200))
$$;
COMMENT ON FUNCTION public.context_transcript_due_calls(integer,boolean) IS
 'T2b: calls due a transcript fetch now (transcripts slice T2): GHL call rows eligible from their stored status and duration, with no terminal fetch record and the next try due; calls waiting for their agreeing second read (last_code awaiting_agreement) first, then oldest first; live: the last 14 days, plus history calls whose backfill fetch record is pending and due now; history: older, on a GHL contact of a job live now (M4 context_ghl_history_live_jobs), with its live job numbers. A call whose transcript row already exists is included so the fetcher records it saved. fetch_mode is the open fetch record''s mode; a backfill record is always saved as backfill.';

-- 2. Grants, as T2 left them.
REVOKE ALL ON FUNCTION public.context_transcript_due_calls(integer,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_transcript_due_calls(integer,boolean) TO service_role;

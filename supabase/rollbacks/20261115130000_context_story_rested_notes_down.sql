-- Rollback of 20261115130000_context_story_rested_notes: context_job_story's earlier body and comment word for
-- word (as 20261030161813 left them), then the two functions this slice added are dropped. No row
-- is touched: the slice wrote none.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE h text;
BEGIN
 SELECT md5(p.prosrc) INTO h FROM pg_proc p
 WHERE p.oid = to_regprocedure('public.context_job_story(uuid,timestamp with time zone,uuid,timestamp with time zone,boolean)');
 IF h IS DISTINCT FROM '8d3084454a285899dcf477018c8f7a3d' THEN
  RAISE EXCEPTION 'rested_notes_rollback_mismatch: context_job_story %', h;
 END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.context_job_story(p_job_id uuid, p_as_of timestamp with time zone DEFAULT now(), p_generation_id uuid DEFAULT NULL::uuid, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_record_only boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 -- (held messages, 20261012100000) the story, and with it the messages placed on no job that could be
 -- this job's (context_job_story_held), marked job not certain: only when there are any, so a job
 -- with none reads exactly as before, and never in the records-only read
 -- (held notes, 20261015100000) the items a held message still holds up are marked job not
 -- certain wherever the card lists them (context_job_story_held_marks); none: unchanged
 SELECT public.context_job_story_placement_review(public.context_job_story_held_marks(public.context_job_story_payment_terms(st.story), p_job_id, p_as_of) || CASE WHEN hm.held IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('held_messages', hm.held) END,p_job_id,p_generation_id,p_as_of,p_record_only)
 FROM (SELECT public.context_job_story_assemble(
  (SELECT jsonb_build_object('id', jb.id, 'job_number', jb.job_number, 'type', jb.type, 'status', jb.status,
          'client_name', jb.client_name, 'site_suburb', jb.site_suburb, 'created_at', jb.created_at,
          'ghl_contact_id', nullif(btrim(jb.ghl_contact_id), ''))
   FROM public.jobs jb WHERE jb.id = p_job_id),
  jsonb_build_object(
   'timeline', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.at, t.kind, t.source_id), '[]'::jsonb)
                FROM public.context_job_record_timeline(ARRAY[p_job_id], p_as_of) t),
   'loops', (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.rule, l.source_id), '[]'::jsonb)
             FROM public.context_job_record_loops(ARRAY[p_job_id], p_as_of) l),
   'money', (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.owing DESC, m.party), '[]'::jsonb)
             FROM public.context_job_record_money(ARRAY[p_job_id], p_as_of) m),
   'contact', (SELECT to_jsonb(c) FROM public.context_job_record_contact(ARRAY[p_job_id], p_as_of) c),
   'facts', public.context_job_story_facts(p_job_id, p_as_of),
   -- (lead cutoff, 20261007010000) the lead rule's answer for this job, which the assembler reads
   'lead', (SELECT to_jsonb(m) FROM public.context_lead_monitored_jobs(ARRAY[p_job_id], p_as_of) m)),
  -- record_only: the records alone, for the reader's own prompt; the ledger is
  -- not read, so no item, attachment or ledger word reaches the output.
  CASE WHEN coalesce(p_record_only, false) THEN jsonb_build_object('status', 'omitted', 'items', '[]'::jsonb, 'transitions', '[]'::jsonb)
       ELSE public.context_job_story_ledger(p_job_id, p_generation_id, p_as_of) END,
  -- (story settled notes, 20261011120000) and each call log on the job whose transcript is on the job
  -- by p_as_of, call row id to transcript id (the evidence rows' has_transcript pairing: the
  -- transcript's payload.ghl_call_id or key ghltx:<id> names the call's ghl:<id>), so the assembler
  -- can leave out an event the reader wrote from the call log alone
  public.context_job_story_meta(p_job_id, p_as_of)
   || jsonb_build_object('call_transcripts', (SELECT coalesce(jsonb_object_agg(e.id::text, t.id::text), '{}'::jsonb)
        FROM public.context_ledger_reader_events(ARRAY[p_job_id]) e
        CROSS JOIN LATERAL (SELECT t.id FROM public.context_ledger_reader_events(ARRAY[p_job_id]) t
                            WHERE t.job_id = e.job_id AND t.event_type = 'call.transcript_completed'
                              AND public.context_linked_status(t.attribution_status)
                              AND (t.payload ->> 'ghl_call_id' = substr(e.provider_message_id, 5)
                                   OR t.provider_message_id = 'ghltx:' || substr(e.provider_message_id, 5))
                              AND greatest(coalesce(t.context_captured_at, t.recorded_at, t.occurred_at), t.attributed_at) <= p_as_of
                            ORDER BY t.id LIMIT 1) t
        WHERE e.job_id = p_job_id AND e.event_type <> 'call.transcript_completed'
          AND (e.channel = 'call' OR e.event_type IN ('client.call_logged', 'client.call_complete'))
          AND e.provider_message_id LIKE 'ghl:%' AND public.context_linked_status(e.attribution_status))),
  p_as_of, p_since) AS story
 WHERE EXISTS (SELECT 1 FROM public.jobs jb WHERE jb.id = p_job_id)) st
 CROSS JOIN LATERAL (SELECT CASE WHEN coalesce(p_record_only, false) THEN NULL
                                 ELSE public.context_job_story_held(p_job_id, p_as_of) END AS held) hm
$function$;

COMMENT ON FUNCTION public.context_job_story(uuid,timestamp with time zone,uuid,timestamp with time zone,boolean) IS 'Job story (20261006014000), lead cutoff (20261007010000): (story settled notes, 20261011120000) (held messages, 20261012100000) the story also carries held_messages (context_job_story_held as of p_as_of): the messages placed on no job that could be this job''s, nearly always because the customer has several jobs, each marked job not certain, newest first; the key is there only when the job has any (a job with none reads exactly as before) and never in the records-only read. They are shown, never counted as this job''s messages, never cited by a note, and their placement is not changed. Earlier (story settled notes) meta also carries call_transcripts: each call log on the job whose transcript is on the job by p_as_of (linked, landed by then; the transcript''s payload.ghl_call_id or key ghltx:<id> names the call''s ghl:<id>), call row id to transcript id, which the assembler reads to leave out an event written from the call log alone. Earlier (lead cutoff) the record part also carries lead (context_lead_monitored_jobs for the job as of p_as_of: monitored, state, quote_sent_at, customer_at, cutoff_at), which the assembler reads. Earlier: job-story-v1 for one job: now line, money, loops, checks, timeline, phase notes, agreements, events, who, last exchange, handling, not known, changes since p_since, meta. Record parts from the job record layer, the live ledger generation (or p_generation_id in any status), every line cited. p_record_only: the records alone (the ledger is not read: meta.ledger.status omitted, no not_known line about the reader, no ledger item, attachment or words anywhere), for the reader''s own prompt; RPC only, never a door parameter. NULL for an unknown job. Service role only. Story card causes (20261014120000): the known uninvoiced balance is explicitly held while R8 says not_due. Held notes (20261015100000): the story''s loops, agreements, events, settled and disputed entries for an item a held message still holds up carry job_certain false and certainty job_not_certain (context_job_story_held_marks); a story with none is unchanged. CTX-T24 placement freshness (20261030161813): canonical placement, preserved unresolved review, snapshot acknowledgement; activation separate.';

DROP FUNCTION IF EXISTS public.context_job_story_rest(jsonb, jsonb, timestamptz);
DROP FUNCTION IF EXISTS public.context_job_story_rest_policy();

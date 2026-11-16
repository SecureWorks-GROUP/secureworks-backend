-- Down for 20261116060000_context_story_finished_notes: the story, the rest rule and its numbers as
-- 20261115130000 left them, word for word; context_job_story_closed_paid and context_job_story_money_settled dropped. Nothing else changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.context_job_story_rest_policy()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $fn$
 SELECT jsonb_build_object(
  -- an AI note this many days old (from the later of the day it was opened and its due day) that
  -- nothing has confirmed since is not treated as owed now
  'max_age_days', 30,
  -- the last step of quote(1), acceptance(2), deposit(3), booking(4), install(5), completion(6),
  -- payment(7) that a job in each phase has passed; a phase not listed has passed none
  'passed', jsonb_build_object('accepted', 2, 'deposit', 2, 'approvals', 2, 'materials', 2,
                               'scheduled', 4, 'install', 4, 'rectification', 4,
                               'invoice', 5, 'payment', 5, 'complete', 5))
$fn$;

COMMENT ON FUNCTION public.context_job_story_rest_policy() IS
 'Rested notes (20261115130000): every number the job story uses to set an AI note aside. max_age_days: the age (from the later of its opening day and its due day) past which an unconfirmed AI note is not treated as owed now. passed: for each job phase, the last step (quote 1, acceptance 2, deposit 3, booking 4, install 5, completion 6, payment 7) the job has passed. Changed only by migration. Service role only.';

CREATE OR REPLACE FUNCTION public.context_job_story_rest(p_ledger jsonb, p_story jsonb, p_as_of timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $fn$
 WITH pol AS (SELECT public.context_job_story_rest_policy() AS p),
 ph AS (
  SELECT p_story -> 'now' ->> 'phase' AS phase,
         nullif(p_story -> 'now' ->> 'phase_since', '')::date AS phase_since,
         (p_as_of AT TIME ZONE 'Australia/Perth')::date AS today,
         (pol.p -> 'passed' ->> (p_story -> 'now' ->> 'phase'))::int AS passed,
         (pol.p ->> 'max_age_days')::int AS max_age
  FROM pol
 ),
 -- the reader's own notes only: never one a person wrote or locked
 it AS (
  SELECT x ->> 'item_key' AS item_key, (x ->> 'needs_reply')::boolean AS needs_reply
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_ledger -> 'items') = 'array' THEN p_ledger -> 'items' ELSE '[]'::jsonb END) x
  WHERE coalesce(x ->> 'written_by', '') NOT LIKE 'person:%' AND NOT coalesce((x ->> 'person_locked')::boolean, false)
 ),
 -- the card's open items that are an AI note on its own (a note attached to a record item is part
 -- of that record item and is never set aside)
 lp AS (
  SELECT l.v, l.v ->> 'key' AS key, l.v ->> 'rule' AS rule, nullif(l.v ->> 'blocks', '') AS blocks,
         nullif(l.v ->> 'since', '')::timestamptz AS since, nullif(l.v ->> 'due', '')::date AS due, it.needs_reply,
         l.v ->> 'status' AS status,
         (coalesce(l.v ->> 'blocks', '') IN ('payment', 'deposit') OR coalesce(l.v ->> 'about_key', '') LIKE 'invoice:%'
          OR coalesce(l.v ->> 'about_key', '') LIKE 'payment:%' OR coalesce(l.v ->> 'about_key', '') LIKE 'refund:%'
          OR coalesce(l.v ->> 'what', '') ~ '\$ ?[0-9]') AS money
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_story -> 'loops') = 'array' THEN p_story -> 'loops' ELSE '[]'::jsonb END) l(v)
  JOIN it ON it.item_key = l.v ->> 'key'
  WHERE l.v ->> 'source' = 'ledger' AND l.v ->> 'status' IN ('open', 'closing_evidence')
 ),
 rs AS (
  SELECT lp.*, ph.phase, ph.today,
   CASE
    -- money is never set aside: what is owed is the records' to say
    WHEN lp.money THEN NULL
    -- something a person said, the reader marked no reply owed and holding up no step: background,
    -- not a thing anyone owes (a claim with the mark unset, or one that blocks a step, stays)
    WHEN lp.rule = 'claim' AND lp.needs_reply IS FALSE AND coalesce(lp.blocks, 'none') = 'none' THEN 'said'
    -- it held up a step the job has passed since it was raised
    WHEN ph.passed IS NOT NULL AND ph.phase_since IS NOT NULL AND (lp.since AT TIME ZONE 'Australia/Perth')::date < ph.phase_since
         AND array_position(ARRAY['quote', 'acceptance', 'deposit', 'booking', 'install', 'completion', 'payment'], lp.blocks) <= ph.passed
     THEN 'stage_passed'
    -- old: still plainly open (not one with closing evidence waiting), opened, and due if it has a
    -- due day, more than the policy's days ago
    WHEN lp.status = 'open' AND lp.since IS NOT NULL
         AND greatest((lp.since AT TIME ZONE 'Australia/Perth')::date, coalesce(lp.due, (lp.since AT TIME ZONE 'Australia/Perth')::date))
             < ph.today - ph.max_age
     THEN 'old'
   END AS reason
  FROM lp, ph
 )
 SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM rs WHERE rs.reason IS NOT NULL) THEN NULL ELSE jsonb_build_object(
  'ledger', jsonb_set(p_ledger, '{items}',
    (SELECT jsonb_agg(CASE WHEN EXISTS (SELECT 1 FROM rs WHERE rs.reason IS NOT NULL AND rs.key = x.v ->> 'item_key')
                           THEN x.v || jsonb_build_object('status', 'rested') ELSE x.v END ORDER BY x.o)
     FROM jsonb_array_elements(p_ledger -> 'items') WITH ORDINALITY x(v, o))),
  'rested', (SELECT jsonb_agg(jsonb_build_object(
      'key', rs.key, 'type', rs.rule, 'what', rs.v -> 'what', 'since', rs.v -> 'since',
      'age_days', (rs.today - (rs.since AT TIME ZONE 'Australia/Perth')::date),
      'reason', rs.reason,
      'why', CASE rs.reason
        WHEN 'said' THEN 'Something a person said, kept as background. Nobody owes anything on it, so it is never the next move.'
        WHEN 'stage_passed' THEN 'It held up ' || CASE rs.blocks WHEN 'quote' THEN 'the quote' WHEN 'acceptance' THEN 'acceptance of the quote'
              WHEN 'deposit' THEN 'the deposit' WHEN 'booking' THEN 'the booking' WHEN 'install' THEN 'the install'
              WHEN 'completion' THEN 'completion' ELSE 'payment' END
             || ', and the job has since moved on to ' || CASE rs.phase WHEN 'accepted' THEN 'an accepted quote' WHEN 'deposit' THEN 'the deposit'
                  WHEN 'approvals' THEN 'approvals' WHEN 'materials' THEN 'materials' WHEN 'scheduled' THEN 'a booked install'
                  WHEN 'install' THEN 'the install' WHEN 'rectification' THEN 'rectification' WHEN 'invoice' THEN 'invoicing'
                  WHEN 'payment' THEN 'payment' ELSE 'finished work' END || '. Not treated as owed now.'
        ELSE 'Opened ' || (rs.today - (rs.since AT TIME ZONE 'Australia/Perth')::date)
             || ' days ago in the AI notes and nothing since has confirmed it either way. Not treated as owed now; check before relying on it.' END,
      'owner', rs.v -> 'owner', 'owner_name', rs.v -> 'owner_name', 'counterparty', rs.v -> 'counterparty',
      'blocks', rs.v -> 'blocks', 'about_key', rs.v -> 'about_key', 'cites', coalesce(rs.v -> 'cites', '[]'::jsonb),
      'customer_reported', coalesce(rs.v -> 'customer_reported', 'false'::jsonb))
      ORDER BY rs.since DESC NULLS LAST, rs.key COLLATE "C")
     FROM rs WHERE rs.reason IS NOT NULL)) END
$fn$;

COMMENT ON FUNCTION public.context_job_story_rest(jsonb, jsonb, timestamptz) IS
 'Rested notes (20261115130000): given the story''s ledger read and the card assembled from it, the open AI notes that are not something anyone owes now, and the ledger with those items'' status set to rested (so the assembler no longer opens them). A note is set aside when it is the reader''s own (never a person''s or a locked one), stands on its own on the card (source ledger; never one attached to a record item), is not about money (blocks payment or deposit, about an invoice, a payment or a refund, or its words carry a dollar amount), and one of: said (a claim the reader marked as needing no reply, blocking no step), stage_passed (it blocks a step the job''s phase has passed, and was opened before that phase began), old (still plainly open, not closing_evidence, and opened, and due if it has a due day, more than context_job_story_rest_policy max_age_days ago). Returns NULL when there is none, else ledger and rested (key, type, what, since, age_days, reason, why, owner, owner_name, counterparty, blocks, about_key, cites, customer_reported; newest first). Pure: reads no table. Nothing is written; the notes themselves are unchanged. Service role only.';

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
 -- (rested notes, 20261115130000) the four inputs are read once; the card is assembled; the AI notes
 -- that are not something anyone owes now (context_job_story_rest: a thing somebody said, a matter
 -- for a step the job has passed, a note older than the policy's days) are worked out from that
 -- card; and only when there are any the card is assembled again without them as open items and
 -- carries them under rested. A job with none reads exactly as before; never in the records-only read
 WITH inp AS MATERIALIZED (
  SELECT
  (SELECT jsonb_build_object('id', jb.id, 'job_number', jb.job_number, 'type', jb.type, 'status', jb.status,
          'client_name', jb.client_name, 'site_suburb', jb.site_suburb, 'created_at', jb.created_at,
          'ghl_contact_id', nullif(btrim(jb.ghl_contact_id), ''))
   FROM public.jobs jb WHERE jb.id = p_job_id) AS job,
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
   'lead', (SELECT to_jsonb(m) FROM public.context_lead_monitored_jobs(ARRAY[p_job_id], p_as_of) m)) AS rec,
  -- record_only: the records alone, for the reader's own prompt; the ledger is
  -- not read, so no item, attachment or ledger word reaches the output.
  CASE WHEN coalesce(p_record_only, false) THEN jsonb_build_object('status', 'omitted', 'items', '[]'::jsonb, 'transitions', '[]'::jsonb)
       ELSE public.context_job_story_ledger(p_job_id, p_generation_id, p_as_of) END AS led,
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
          AND e.provider_message_id LIKE 'ghl:%' AND public.context_linked_status(e.attribution_status))) AS meta
  WHERE EXISTS (SELECT 1 FROM public.jobs jb WHERE jb.id = p_job_id)),
 first AS MATERIALIZED (
  SELECT public.context_job_story_assemble(inp.job, inp.rec, inp.led, inp.meta, p_as_of, p_since) AS story FROM inp),
 rest AS MATERIALIZED (
  SELECT CASE WHEN coalesce(p_record_only, false) THEN NULL
              ELSE public.context_job_story_rest(inp.led, first.story, p_as_of) END AS r FROM inp, first),
 st AS (
  SELECT CASE WHEN rest.r IS NULL THEN first.story
              ELSE public.context_job_story_assemble(inp.job, inp.rec, rest.r -> 'ledger', inp.meta, p_as_of, p_since)
                   -- a set aside note a held message still holds up keeps its job not certain mark
                   || jsonb_build_object('rested', public.context_job_story_held_marks(
                        jsonb_build_object('loops', rest.r -> 'rested', 'meta', first.story -> 'meta'), p_job_id, p_as_of) -> 'loops') END AS story
  FROM inp, first, rest)
 SELECT public.context_job_story_placement_review(public.context_job_story_held_marks(public.context_job_story_payment_terms(st.story), p_job_id, p_as_of) || CASE WHEN hm.held IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('held_messages', hm.held) END,p_job_id,p_generation_id,p_as_of,p_record_only)
 FROM st
 CROSS JOIN LATERAL (SELECT CASE WHEN coalesce(p_record_only, false) THEN NULL
                                 ELSE public.context_job_story_held(p_job_id, p_as_of) END AS held) hm
$function$;

COMMENT ON FUNCTION public.context_job_story(uuid,timestamp with time zone,uuid,timestamp with time zone,boolean) IS 'Job story (20261006014000), lead cutoff (20261007010000): (story settled notes, 20261011120000) (held messages, 20261012100000) the story also carries held_messages (context_job_story_held as of p_as_of): the messages placed on no job that could be this job''s, nearly always because the customer has several jobs, each marked job not certain, newest first; the key is there only when the job has any (a job with none reads exactly as before) and never in the records-only read. They are shown, never counted as this job''s messages, never cited by a note, and their placement is not changed. Earlier (story settled notes) meta also carries call_transcripts: each call log on the job whose transcript is on the job by p_as_of (linked, landed by then; the transcript''s payload.ghl_call_id or key ghltx:<id> names the call''s ghl:<id>), call row id to transcript id, which the assembler reads to leave out an event written from the call log alone. Earlier (lead cutoff) the record part also carries lead (context_lead_monitored_jobs for the job as of p_as_of: monitored, state, quote_sent_at, customer_at, cutoff_at), which the assembler reads. Earlier: job-story-v1 for one job: now line, money, loops, checks, timeline, phase notes, agreements, events, who, last exchange, handling, not known, changes since p_since, meta. Record parts from the job record layer, the live ledger generation (or p_generation_id in any status), every line cited. p_record_only: the records alone (the ledger is not read: meta.ledger.status omitted, no not_known line about the reader, no ledger item, attachment or words anywhere), for the reader''s own prompt; RPC only, never a door parameter. NULL for an unknown job. Service role only. Story card causes (20261014120000): the known uninvoiced balance is explicitly held while R8 says not_due. Held notes (20261015100000): the story''s loops, agreements, events, settled and disputed entries for an item a held message still holds up carry job_certain false and certainty job_not_certain (context_job_story_held_marks); a story with none is unchanged. CTX-T24 placement freshness (20261030161813): canonical placement, preserved unresolved review, snapshot acknowledgement; activation separate. Rested notes (20261115130000): the card is assembled, then the AI notes that are not something anyone owes now (context_job_story_rest: something a person said with no reply owed; a matter that held up a step the job has since passed; a note older than context_job_story_rest_policy max_age_days with no later due day; never money, never a person''s own note, never a note attached to a record item) leave the open items, whose move, the next step and the blockers, and are listed under rested, each with its reason and why (one a held message still holds up keeps job_certain false, as context_job_story_held_marks marks it). The key is there only when the job has any (a job with none reads exactly as before) and never in the records-only read.';

DROP FUNCTION IF EXISTS public.context_job_story_closed_paid(jsonb);
DROP FUNCTION IF EXISTS public.context_job_story_money_settled(jsonb);

REVOKE ALL ON FUNCTION public.context_job_story_rest_policy() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_story_rest(jsonb, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_story(uuid, timestamptz, uuid, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_story_rest_policy() TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_story_rest(jsonb, jsonb, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_story(uuid, timestamptz, uuid, timestamptz, boolean) TO service_role;

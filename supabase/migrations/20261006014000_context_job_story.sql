-- The job story: one cited read of a job, start to finish (story slice S2, 6 Oct 2026).
--
-- Why. The owner orients himself on a job by reading its whole story: where it
-- sits, what money is owed, what is open with whom and why, what was agreed,
-- and what is not known (done-definition rows 11 and 12). The record layer
-- (20261006011000) gives the record half; the ledger (20261006010000, written
-- by the store 20261006013000) gives what the words add. This migration joins
-- them into one jsonb read, code-assembled, every line cited. It stores nothing.
-- It runs after the store (renumbered from 20261006012000 when the slices were
-- joined): how far the reader has read a job is the store's own evidence
-- definition, context_ledger_evidence_rows, never the fact pass's unread count
-- (context_job_freshness says nothing about what the ledger reader has read).
--
--   context_job_story_assemble(job, record, ledger, meta, as_of, since)
--        PURE: builds the job-story-v1 document from its four inputs and reads
--        no table, so the whole story can be checked on synthetic fixtures and,
--        by inlining, read-only on production.
--   context_job_story_facts(job, as_of)      record facts the assembler needs in
--        structured form (bookings, quotes, closing candidates, parties).
--   context_job_story_ledger(job, generation, as_of)  the ledger to show: the
--        live generation (or the one asked for), every item's citations
--        re-checked (on this job, linked, not retracted), its transitions, and
--        how many messages landed after that reading (its reader's own unread
--        count, from the store's evidence definition).
--   context_job_story_meta(job, as_of)       evidence lanes, unplaced messages
--        and the CRM contact, for the gaps the story must name.
--   context_job_story(job, as_of, generation, since)   the read: the four
--        readers plus the record functions, then the assembler.
--   context_client_story(job, as_of)         every job of the same client
--        (CRM contact, else exact client email; never a name).
--   context_story_scorecard(as_of)           done-definition rows 1 to 14.
--
-- Rules the assembler keeps (contract section 5.1): the now line is built only
-- from record facts and visible ledger items, Perth dates written like
-- "Wed 7 Oct", no em dashes; phase comes from evidence and status together
-- (status lags); a ledger item about the same object as a record loop (the
-- exact about_key, never a prefix) is attached to it, not listed twice; an R5 "customer wrote last" candidate is a
-- loop only when a visible ledger item says a reply is owed; closing evidence is
-- shown as closing_evidence and never as closed; nothing closes on a clock; an
-- item whose cited message moved off the job is hidden and the story says it
-- needs a rebuild.
--
-- Unchanged: every existing table, function and reader.
-- Rollback: supabase/rollbacks/20261006014000_context_job_story_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Guard: the record layer, the ledger model and the store's evidence read
-- exist; each function here is absent or this migration's.
DO $guard$
DECLARE problems text[] := '{}'; f text;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_job_record_timeline(uuid[],timestamptz)','public.context_job_record_loops(uuid[],timestamptz)',
   'public.context_job_record_money(uuid[],timestamptz)','public.context_job_record_contact(uuid[],timestamptz)',
   'public.context_job_record_messages(uuid[],timestamptz)','public.context_job_record_legacy_mail(uuid[],timestamptz)',
   'public.context_linked_status(text)','public.context_ledger_evidence_rows(uuid[],timestamptz)','public.context_ledger_failures(uuid[])',
   'public.context_unplaced_for_job(uuid)','public.context_source_freshness()','public.context_pipeline_status()',
   'public.context_document_text_status()','public.context_ghl_history_progress()','public.context_email_history_status()',
   'public.context_coverage()'] LOOP
  IF to_regprocedure(f) IS NULL THEN problems := problems || format('%s is missing', f); END IF;
 END LOOP;
 IF to_regclass('public.context_ledger_items') IS NULL OR to_regclass('public.context_ledger_generations') IS NULL
    OR to_regclass('public.context_ledger_transitions') IS NULL THEN
  problems := problems || 'the ledger model (20261006010000) is missing'::text;
 END IF;
 IF to_regclass('public.job_contacts') IS NULL THEN problems := problems || 'public.job_contacts is missing'::text; END IF;
 FOREACH f IN ARRAY ARRAY['public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)',
   'public.context_job_story_facts(uuid,timestamptz)','public.context_job_story_ledger(uuid,uuid,timestamptz)',
   'public.context_job_story_meta(uuid,timestamptz)','public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)',
   'public.context_job_story(uuid,timestamptz,uuid,timestamptz)',
   'public.context_client_story(uuid,timestamptz)','public.context_story_scorecard(timestamptz)',
   'public.context_story_scorecard_jobs(uuid,integer)'] LOOP
  IF to_regprocedure(f) IS NOT NULL AND coalesce(obj_description(to_regprocedure(f), 'pg_proc'), '')
     NOT LIKE 'Job story (20261006014000)%' THEN
   problems := problems || format('%s exists and is not this migration''s', f);
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_job_story_preimage_mismatch: %', array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The pure assembler.
CREATE OR REPLACE FUNCTION public.context_job_story_assemble(p_job jsonb, p_record jsonb, p_ledger jsonb, p_meta jsonb,
 p_as_of timestamptz, p_since timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql STABLE
AS $fn$
 WITH inp AS MATERIALIZED (
  SELECT p_job AS job, coalesce(p_record, '{}'::jsonb) AS rec, coalesce(p_ledger, '{}'::jsonb) AS led,
         coalesce(p_meta, '{}'::jsonb) AS meta, p_as_of AS as_of, (p_as_of AT TIME ZONE 'Australia/Perth')::date AS today,
         p_since AS since
 ),
 tl AS MATERIALIZED (
  SELECT t.* FROM inp, jsonb_to_recordset(coalesce(inp.rec->'timeline', '[]'::jsonb))
   AS t(at timestamptz, perth_date date, time_basis text, kind text, what text, amount numeric, party text, placement text,
        source_table text, source_id text, state text, made_at timestamptz)
 ),
 rl AS MATERIALIZED (
  SELECT l.* FROM inp, jsonb_to_recordset(coalesce(inp.rec->'loops', '[]'::jsonb))
   AS l(rule text, loop_key text, shown_as text, owner text, counterparty text, what text, why text, opened_at timestamptz,
        due_date date, amount numeric, about_key text, closes_when text, source_table text, source_id text)
 ),
 mo AS MATERIALIZED (
  SELECT m.* FROM inp, jsonb_to_recordset(coalesce(inp.rec->'money', '[]'::jsonb))
   AS m(party text, xero_contact_id text, invoiced numeric, paid numeric, credited numeric, owing numeric, overdue numeric,
        oldest_overdue_due date, drafts integer, draft_total numeric, invoices jsonb, job_value numeric, job_value_basis text,
        not_yet_invoiced numeric, supplier_bills jsonb)
 ),
 bk AS MATERIALIZED (  -- crew bookings (observer mirrors are not passed in)
  SELECT b.* FROM inp, jsonb_to_recordset(coalesce(inp.rec->'facts'->'bookings', '[]'::jsonb))
   AS b(id text, scheduled_date date, status text, assignment_type text, crew_name text, created_at timestamptz,
        started_at timestamptz, completed_at timestamptz)
 ),
 qd AS MATERIALIZED (
  SELECT q.* FROM inp, jsonb_to_recordset(coalesce(inp.rec->'facts'->'quotes', '[]'::jsonb))
   AS q(id text, quote_number text, version integer, sent_at timestamptz, accepted_at timestamptz, declined_at timestamptz,
        superseded_at timestamptz)
 ),
 cc AS MATERIALIZED (  -- records that may close a ledger item (closing evidence only)
  SELECT c.* FROM inp, jsonb_to_recordset(coalesce(inp.rec->'facts'->'closing', '[]'::jsonb))
   AS c(closes_on text, about_key text, at timestamptz, t text, id text, what text)
 ),
 li AS MATERIALIZED (  -- ledger items of the generation shown, with the citation re-check result
                       -- (what with em and en dashes replaced, as the store now writes it)
  SELECT i.* FROM inp, jsonb_to_recordset((SELECT coalesce(jsonb_agg(x || jsonb_build_object('what',
            btrim(replace(regexp_replace(x->>'what', '\s*' || chr(8212) || '\s*', ', ', 'g'), chr(8211), '-')))), '[]'::jsonb)
          FROM jsonb_array_elements(coalesce(inp.led->'items', '[]'::jsonb)) x))
   AS i(item_key text, item_type text, status text, from_role text, from_name text, to_role text, to_name text, what text,
        about_key text, modality text, phase text, due_date date, opened_at timestamptz, opened_by jsonb, closed_at timestamptz,
        closed_by jsonb, closes_on text, supersedes_key text, blocks text, needs_reply boolean, written_by text,
        person_locked boolean, cites_ok boolean, cited jsonb)
 ),
 vis AS MATERIALIZED (SELECT li.* FROM li WHERE coalesce(li.cites_ok, true)),
 led AS (  -- the generation shown (a JSON null generation is none), what its reader has not read yet,
           -- and the customer rows it has read (a candidate is judged only when its row is one)
  SELECT x.*,
         CASE WHEN x.gen IS NOT NULL THEN (inp.led->>'unread_rows')::integer END AS unread,
         CASE WHEN x.gen IS NOT NULL THEN coalesce(inp.led->'unread_ids', '[]'::jsonb) END AS unread_ids,
         CASE WHEN x.gen IS NOT NULL THEN coalesce(inp.led->'read_ids', '[]'::jsonb) END AS read_ids
  FROM inp, LATERAL (
   SELECT coalesce(nullif(inp.led->>'status', ''), 'none') AS status, nullif(inp.led->'generation', 'null'::jsonb) AS gen,
          (inp.led->'generation'->>'evidence_until')::timestamptz AS evidence_until,
          (SELECT count(*) FROM vis) AS items, (SELECT count(*) FROM li WHERE NOT coalesce(li.cites_ok, true)) AS hidden,
          (SELECT count(*) FROM li WHERE NOT coalesce(li.cites_ok, true) AND coalesce(li.person_locked, false)) AS hidden_locked) x
 ),
 -- money totals
 mt AS (
  SELECT coalesce(sum(mo.invoiced), 0) AS invoiced, coalesce(sum(mo.paid), 0) AS paid, coalesce(sum(mo.credited), 0) AS credited,
         coalesce(sum(mo.owing), 0) AS owing, coalesce(sum(mo.overdue), 0) AS overdue, min(mo.oldest_overdue_due) AS oldest_overdue,
         coalesce(sum(mo.drafts), 0) AS drafts, coalesce(sum(mo.draft_total), 0) AS draft_total,
         max(mo.job_value) AS job_value, max(mo.job_value_basis) AS job_value_basis, max(mo.not_yet_invoiced) AS nyi,
         count(*) FILTER (WHERE mo.party IS NOT NULL) AS parties,
         (SELECT m2.supplier_bills FROM mo m2 LIMIT 1) AS bills
  FROM mo
 ),
 -- evidence for the phase
 -- the newest standing crew booking up to today, and whether one is still ahead:
 -- work is done only when that booking is complete and nothing is ahead (a booking
 -- stands unless cancelled, deleted, draft, disputed or declined; crew planning's
 -- confirmation is never read)
 bkn AS (
  SELECT (SELECT to_jsonb(b) FROM bk b, inp WHERE b.scheduled_date <= inp.today
            AND lower(coalesce(b.status, '')) NOT IN ('cancelled', 'deleted', 'draft', 'disputed', 'declined')
          ORDER BY b.scheduled_date DESC, b.id DESC LIMIT 1) AS nb,
         EXISTS (SELECT 1 FROM bk b, inp WHERE b.scheduled_date > inp.today
                   AND lower(coalesce(b.status, '')) NOT IN ('cancelled', 'deleted', 'draft', 'disputed', 'declined')) AS ahead
 ),
 ev AS (
  SELECT
   -- attendance timed as a closing reads it: completed, else started, else (a
   -- status-only completion) the end of the booked Perth day
   (SELECT CASE WHEN NOT bkn.ahead AND bkn.nb IS NOT NULL
                 AND (lower(coalesce(bkn.nb->>'status', '')) IN ('complete', 'completed') OR bkn.nb->>'completed_at' IS NOT NULL)
            THEN (SELECT max(coalesce(b.completed_at, b.started_at,
                                      ((b.scheduled_date + 1)::timestamp AT TIME ZONE 'Australia/Perth') - interval '1 second')) FROM bk b
                  WHERE lower(coalesce(b.status, '')) IN ('complete', 'completed') OR b.completed_at IS NOT NULL) END FROM bkn) AS done_at,
   (SELECT bkn.ahead FROM bkn) AS bk_ahead,
   -- a passed booking nobody marked started or complete
   (SELECT (bkn.nb->>'scheduled_date')::date FROM bkn, inp
    WHERE bkn.nb IS NOT NULL AND (bkn.nb->>'scheduled_date')::date < inp.today
      AND lower(coalesce(bkn.nb->>'status', '')) NOT IN ('complete', 'completed', 'in_progress')
      AND bkn.nb->>'completed_at' IS NULL AND bkn.nb->>'started_at' IS NULL) AS unattended_on,
   (SELECT min(coalesce(b.completed_at, b.started_at, b.scheduled_date::timestamp AT TIME ZONE 'Australia/Perth')) FROM bk b
    WHERE b.status IN ('complete', 'in_progress') OR b.completed_at IS NOT NULL OR b.started_at IS NOT NULL) AS started_at,
   (inp.rec->'facts'->>'report_sent_at')::timestamptz AS report_sent_at,
   (SELECT to_jsonb(b) FROM bk b WHERE b.scheduled_date >= inp.today
      AND lower(coalesce(b.status, '')) NOT IN ('cancelled', 'deleted', 'draft', 'disputed', 'declined', 'complete', 'completed')
    ORDER BY b.scheduled_date, b.id LIMIT 1) AS next_bk,
   (SELECT min(q.accepted_at) FROM qd q) AS accepted_at,
   (SELECT min(q.sent_at) FROM qd q) AS first_sent,
   (SELECT max(q.sent_at) FROM qd q) AS last_sent,
   (SELECT min(t.at) FROM tl t WHERE t.kind = 'site_visit') AS scoped_at,
   (SELECT max(t.at) FROM tl t WHERE t.kind IN ('status', 'rectification') AND t.time_basis = 'observed') AS status_at,
   inp.job->>'status' AS status, inp.job->>'type' AS type, inp.today
  FROM inp
 ),
 ph0 AS (
  SELECT ev.*,
   CASE ev.status
    WHEN 'quoted' THEN 'quote' WHEN 'accepted' THEN 'accepted' WHEN 'partially_accepted' THEN 'accepted'
    WHEN 'awaiting_deposit' THEN 'deposit' WHEN 'deposit' THEN 'deposit' WHEN 'approvals' THEN 'approvals'
    WHEN 'order_materials' THEN 'materials' WHEN 'awaiting_supplier' THEN 'materials' WHEN 'schedule_install' THEN 'scheduled'
    WHEN 'scheduled' THEN 'scheduled' WHEN 'in_progress' THEN 'install' WHEN 'invoiced' THEN 'invoice'
    WHEN 'final_payment' THEN 'payment' WHEN 'get_review' THEN 'complete' WHEN 'complete' THEN 'complete'
    WHEN 'completed' THEN 'complete' WHEN 'rectification' THEN 'rectification' WHEN 'lead' THEN 'enquiry' WHEN 'new' THEN 'enquiry'
    WHEN 'processing' THEN CASE WHEN ev.type = 'makesafe' THEN 'makesafe' ELSE 'other' END
    ELSE 'other' END AS status_phase,
   CASE WHEN ev.bk_ahead THEN NULL ELSE coalesce(ev.done_at, ev.report_sent_at) END AS work_done_at,
   (mt.owing > 0) AS owing, (coalesce(mt.nyi, 0) > 1) AS uninvoiced
  FROM ev, mt
 ),
 ph AS (
  SELECT p.*,
   CASE
    WHEN p.status_phase = 'rectification' THEN 'rectification'
    WHEN p.started_at IS NOT NULL AND p.next_bk IS NOT NULL THEN 'install'
    WHEN p.unattended_on IS NOT NULL AND p.work_done_at IS NULL THEN 'install'
    WHEN p.work_done_at IS NOT NULL AND p.owing THEN 'payment'
    WHEN p.work_done_at IS NOT NULL AND p.uninvoiced THEN 'invoice'
    WHEN p.work_done_at IS NOT NULL THEN 'complete'
    WHEN p.status_phase IN ('install', 'complete', 'invoice', 'payment') THEN p.status_phase
    WHEN p.type = 'makesafe' THEN 'makesafe'
    WHEN p.next_bk IS NOT NULL THEN 'scheduled'
    ELSE (SELECT x.ph FROM (VALUES
           (CASE WHEN p.accepted_at IS NOT NULL THEN 'accepted' WHEN p.first_sent IS NOT NULL THEN 'quote'
                 WHEN p.scoped_at IS NOT NULL THEN 'scope' ELSE 'enquiry' END), (p.status_phase)) x(ph)
          ORDER BY array_position(ARRAY['other','enquiry','scope','quote','accepted','deposit','approvals','materials','scheduled'], x.ph) DESC NULLS LAST
          LIMIT 1)
   END AS phase
  FROM ph0 p
 ),
 phs AS (
  SELECT ph.*,
   CASE
    WHEN ph.phase = 'install' THEN coalesce(ph.started_at, ph.unattended_on::timestamp AT TIME ZONE 'Australia/Perth')
    WHEN ph.phase IN ('payment', 'invoice', 'complete') AND ph.work_done_at IS NOT NULL THEN ph.work_done_at
    WHEN ph.phase = 'scheduled' AND ph.next_bk IS NOT NULL
     THEN CASE WHEN ph.status_phase = 'scheduled' THEN coalesce(ph.status_at, (ph.next_bk->>'created_at')::timestamptz)
               ELSE (ph.next_bk->>'created_at')::timestamptz END
    WHEN ph.phase = 'accepted' THEN coalesce(ph.accepted_at, ph.status_at)
    WHEN ph.phase = 'quote' THEN coalesce(ph.last_sent, ph.status_at)
    WHEN ph.phase = 'scope' THEN ph.scoped_at
    WHEN ph.phase = ph.status_phase THEN ph.status_at
   END AS phase_since_at
  FROM ph
 ),
 -- R5 / C11 candidates, and whether a visible open ledger item says a reply is owed
 cand AS (
  SELECT r.*, (SELECT v.item_key FROM vis v
               WHERE v.status = 'open' AND (coalesce(v.needs_reply, false) OR v.item_type = 'request')
                 AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(v.cited, v.opened_by)) c
                             WHERE (c->>'id' = r.source_id)
                                OR (coalesce((c->>'customer')::boolean, false) AND (c->>'at')::timestamptz >= r.opened_at))
               ORDER BY v.opened_at LIMIT 1) AS promoted_by
  FROM rl r WHERE r.shown_as = 'candidate'
 ),
 -- record loops shown as loops, merged per object (about_key), with promoted candidates
 rec AS (
  SELECT r.rule, r.loop_key, r.owner, r.counterparty, r.what, r.why, r.opened_at, r.due_date, r.amount, r.about_key, r.closes_when,
         r.source_table, r.source_id, NULL::text AS promoted_by
  FROM rl r WHERE r.shown_as = 'loop'
  UNION ALL
  SELECT c.rule, c.loop_key, c.owner, c.counterparty, c.what, c.why, c.opened_at, c.due_date, c.amount, c.about_key, c.closes_when,
         c.source_table, c.source_id, c.promoted_by
  FROM cand c WHERE c.promoted_by IS NOT NULL
 ),
 recg AS (
  SELECT r.about_key,
         (array_agg(r.loop_key ORDER BY array_position(ARRAY['R1_overdue','M1_money_due','R2_part_paid','R3_draft','R8_not_yet_invoiced',
                    'R4_missed_call','R5_customer_wrote_last','C11_customer_mail_unanswered','R7_quote_waiting'], r.rule) NULLS LAST, r.loop_key))[1] AS key,
         (array_agg(r.rule ORDER BY array_position(ARRAY['R1_overdue','M1_money_due','R2_part_paid','R3_draft','R8_not_yet_invoiced',
                    'R4_missed_call','R5_customer_wrote_last','C11_customer_mail_unanswered','R7_quote_waiting'], r.rule) NULLS LAST, r.loop_key))[1] AS rule,
         string_agg(DISTINCT r.rule, '+') AS rules,
         (array_agg(r.owner ORDER BY array_position(ARRAY['R1_overdue','M1_money_due','R2_part_paid','R3_draft','R8_not_yet_invoiced'], r.rule) NULLS LAST, r.loop_key))[1] AS owner,
         (array_agg(r.counterparty ORDER BY array_position(ARRAY['R1_overdue','M1_money_due','R2_part_paid','R3_draft','R8_not_yet_invoiced'], r.rule) NULLS LAST, r.loop_key))[1] AS counterparty,
         (array_agg(r.what ORDER BY array_position(ARRAY['R1_overdue','M1_money_due','R2_part_paid','R3_draft','R8_not_yet_invoiced'], r.rule) NULLS LAST, r.loop_key))[1] AS what,
         string_agg(r.why, '; ' ORDER BY r.rule) AS why,
         min(r.opened_at) AS since, min(r.due_date) AS due, max(r.amount) AS amount,
         (array_agg(r.closes_when ORDER BY r.rule))[1] AS closes_when,
         jsonb_agg(DISTINCT jsonb_build_object('t', r.source_table, 'id', r.source_id)) AS cites,
         array_agg(r.promoted_by) FILTER (WHERE r.promoted_by IS NOT NULL) AS promoted_by
  FROM rec r GROUP BY r.about_key
 ),
 -- open ledger items that are loops
 lop AS (
  SELECT v.* FROM vis v
  WHERE v.status = 'open'
    AND (v.item_type IN ('commitment', 'request', 'claim', 'issue', 'constraint', 'dependency')
         OR (v.item_type = 'agreement' AND v.modality IN ('requested', 'offered')))
 ),
 -- which ledger items attach to a record loop (same object, or the item that promoted a candidate)
 att AS (
  SELECT l.item_key, g.about_key AS loop_about
  FROM lop l JOIN recg g ON g.about_key = l.about_key OR l.item_key = ANY (coalesce(g.promoted_by, '{}'::text[]))
 ),
 lrole AS (
  SELECT l.*,
   CASE
    WHEN l.item_type = 'commitment' THEN l.from_role
    WHEN l.item_type = 'request' THEN coalesce(l.to_role, 'us')
    WHEN l.item_type = 'dependency' THEN CASE WHEN coalesce(l.to_role, 'third_party') IN ('us', 'crew') THEN 'third_party' ELSE l.to_role END
    WHEN l.item_type = 'agreement' THEN CASE WHEN l.from_role IN ('us', 'crew') THEN coalesce(l.to_role, 'customer') ELSE 'us' END
    ELSE 'us' END AS owner_role,
   CASE
    WHEN l.item_type = 'commitment' THEN l.from_name
    WHEN l.item_type = 'request' THEN l.to_name
    WHEN l.item_type = 'dependency' THEN l.to_name
    WHEN l.item_type = 'agreement' THEN CASE WHEN l.from_role IN ('us', 'crew') THEN l.to_name ELSE NULL END
   END AS owner_name,
   CASE
    WHEN l.item_type = 'commitment' THEN l.to_role
    WHEN l.item_type IN ('request', 'claim', 'issue', 'constraint') THEN l.from_role
    WHEN l.item_type = 'agreement' THEN CASE WHEN l.from_role IN ('us', 'crew') THEN 'us' ELSE l.from_role END
    ELSE 'us' END AS counter_role,
   (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(l.opened_by) c) AS cites,
   (SELECT c->>'excerpt' FROM jsonb_array_elements(l.opened_by) c LIMIT 1) AS excerpt,
   (SELECT jsonb_agg(jsonb_build_object('t', x.t, 'id', x.id, 'what', x.what) ORDER BY x.at)
    FROM cc x
    WHERE l.closes_on IN ('quote_sent', 'invoice_issued', 'payment', 'booking_made', 'visit') AND x.closes_on = l.closes_on
      AND x.at > l.opened_at
      -- exact object only: a slug (quote:rear-fence) never matches some other quote by prefix
      AND x.about_key = l.about_key) AS closing
  FROM lop l
 ),
 norm AS (  -- role words to the loop owner vocabulary
  SELECT r.*,
   CASE WHEN r.owner_role IN ('us', 'crew') THEN 'us' WHEN r.owner_role IN ('customer', 'insurer_builder') THEN 'customer'
        WHEN r.owner_role IN ('supplier', 'third_party') THEN 'third_party' ELSE 'unknown' END AS owner,
   CASE WHEN r.counter_role IN ('us', 'crew') THEN 'us' WHEN r.counter_role IN ('customer', 'insurer_builder') THEN 'customer'
        WHEN r.counter_role IN ('supplier', 'third_party') THEN 'third_party' ELSE 'unknown' END AS counterparty
  FROM lrole r
 ),
 loops0 AS (
  -- record loops (with attached ledger items)
  SELECT g.key, 'record'::text AS source, g.rules AS rule, g.owner, NULL::text AS owner_name, g.counterparty,
         g.what,
         concat_ws('; ', g.why, (SELECT string_agg(n.what || coalesce(' ("' || left(n.excerpt, 160) || '")', ''), '; ' ORDER BY n.opened_at)
                                 FROM norm n JOIN att a ON a.item_key = n.item_key AND a.loop_about = g.about_key)) AS why,
         g.since, coalesce(g.due, (SELECT min(n.due_date) FROM norm n JOIN att a ON a.item_key = n.item_key AND a.loop_about = g.about_key)) AS due,
         -- the record rule still fires, so the loop is open: closing evidence is shown on ledger items only
         'open'::text AS status,
         g.closes_when,
         (SELECT max(n.blocks) FROM norm n JOIN att a ON a.item_key = n.item_key AND a.loop_about = g.about_key WHERE n.blocks <> 'none') AS blocks,
         NULL::jsonb AS closing_evidence,
         (SELECT jsonb_agg(DISTINCT c) FROM jsonb_array_elements(g.cites || coalesce((SELECT jsonb_agg(c2) FROM norm n
              JOIN att a ON a.item_key = n.item_key AND a.loop_about = g.about_key, jsonb_array_elements(n.cites) c2), '[]'::jsonb)) c) AS cites,
         g.about_key, g.amount,
         (g.rule IN ('R4_missed_call', 'R5_customer_wrote_last', 'C11_customer_mail_unanswered')) AS customer_waiting,
         (g.rule IN ('R1_overdue', 'M1_money_due', 'R2_part_paid', 'R3_draft', 'R8_not_yet_invoiced')) AS money
  FROM recg g
  UNION ALL
  -- ledger loops not attached to a record loop
  SELECT n.item_key, CASE WHEN n.written_by LIKE 'person:%' THEN 'person' ELSE 'ledger' END, n.item_type, n.owner, n.owner_name,
         n.counterparty, n.what, coalesce('"' || left(n.excerpt, 200) || '"', NULL), n.opened_at, n.due_date,
         CASE WHEN n.closing IS NOT NULL THEN 'closing_evidence' ELSE 'open' END,
         CASE n.closes_on WHEN 'reply' THEN 'A reply that answers it' WHEN 'call' THEN 'A call that deals with it'
              WHEN 'quote_sent' THEN 'The quote is sent' WHEN 'invoice_issued' THEN 'The invoice is issued'
              WHEN 'payment' THEN 'The payment is received' WHEN 'booking_made' THEN 'A booking is made'
              WHEN 'visit' THEN 'The visit happens' WHEN 'work_done' THEN 'The work is done' WHEN 'record' THEN 'A record shows it done'
              WHEN 'person' THEN 'A person closes it' ELSE 'Words or a record that show it done' END,
         nullif(n.blocks, 'none'), n.closing, coalesce(n.cites, '[]'::jsonb), n.about_key, NULL::numeric,
         (n.owner = 'us' AND n.counterparty = 'customer' AND (coalesce(n.needs_reply, false) OR n.item_type = 'request')),
         (n.blocks IN ('payment', 'deposit') OR n.about_key LIKE 'invoice:%' OR n.about_key LIKE 'payment:%')
  FROM norm n WHERE NOT EXISTS (SELECT 1 FROM att a WHERE a.item_key = n.item_key)
 ),
 loops AS (
  SELECT l.*, (inp.today - (l.since AT TIME ZONE 'Australia/Perth')::date) AS age_days,
         row_number() OVER (ORDER BY
           CASE WHEN l.owner = 'us' AND l.customer_waiting THEN 0 WHEN l.money THEN 1 WHEN l.owner = 'us' THEN 2 ELSE 3 END,
           l.since NULLS LAST, l.key) AS rank
  FROM loops0 l, inp
 ),
 -- unpromoted R5 / C11 candidates, and whether the reading shown has read the row
 -- (the row is in its read set: admitted to its evidence and landed by its evidence_until)
 wr AS (
  SELECT c.*, (led.gen IS NOT NULL AND coalesce(led.read_ids ? c.source_id, false)) AS read_by_reader
  FROM cand c, led WHERE c.promoted_by IS NULL
 ),
 -- the customer wrote last and nobody has read it yet: the now line and whose move say so
 wl AS (SELECT max(w.opened_at) AS at FROM wr w WHERE NOT w.read_by_reader HAVING count(*) > 0),
 -- checks: record checks, plus candidates nobody promoted
 checks AS (
  SELECT r.rule, r.what, jsonb_build_array(jsonb_build_object('t', r.source_table, 'id', r.source_id)) AS cites, r.opened_at
  FROM rl r WHERE r.shown_as = 'check'
  UNION ALL
  SELECT c.rule,
         CASE WHEN c.read_by_reader
              THEN 'Customer wrote last; the reader judged no reply is needed. ' || c.what
              ELSE 'Customer wrote last; not yet read by the reader. ' || c.what END,
         jsonb_build_array(jsonb_build_object('t', c.source_table, 'id', c.source_id)), c.opened_at
  FROM wr c
 ),
 top AS (SELECT l.* FROM loops l ORDER BY l.rank LIMIT 1),
 -- whose move: ours when we owe something; unclear while the customer wrote last unread
 wm AS (
  SELECT CASE
          WHEN EXISTS (SELECT 1 FROM loops l WHERE l.owner = 'us') THEN 'us'
          WHEN EXISTS (SELECT 1 FROM wl) THEN 'unknown'
          WHEN EXISTS (SELECT 1 FROM loops l WHERE l.owner = 'customer') THEN 'customer'
          WHEN EXISTS (SELECT 1 FROM loops l WHERE l.owner = 'third_party') THEN 'third_party'
          WHEN EXISTS (SELECT 1 FROM loops l) THEN 'unknown'
          ELSE 'nobody' END AS whose
 ),
 -- day words: Perth dates like "Wed 7 Oct" (year added when it is not the current year)
 nx AS (
  SELECT phs.next_bk AS b,
         CASE WHEN phs.next_bk IS NULL THEN NULL
              ELSE to_char((phs.next_bk->>'scheduled_date')::date, 'Dy FMDD Mon')
                   || CASE WHEN extract(year FROM (phs.next_bk->>'scheduled_date')::date) <> extract(year FROM phs.today)
                           THEN ' ' || extract(year FROM (phs.next_bk->>'scheduled_date')::date) ELSE '' END END AS day
  FROM phs
 ),
 nowp AS (
  SELECT phs.phase, phs.phase_since_at,
   -- phase words say where the job is, never whose move it is (the move words do);
   -- invoicing and payment words follow the money, not the status
   CASE phs.phase
    WHEN 'enquiry' THEN 'New enquiry' WHEN 'scope' THEN 'Scoping' WHEN 'quote' THEN 'Quoted'
    WHEN 'accepted' THEN 'Accepted' WHEN 'deposit' THEN 'Deposit stage' WHEN 'approvals' THEN 'In approvals'
    WHEN 'materials' THEN 'Materials being ordered' WHEN 'scheduled' THEN 'Scheduled' WHEN 'install' THEN 'Install under way'
    WHEN 'complete' THEN 'Work complete'
    WHEN 'invoice' THEN CASE WHEN phs.uninvoiced AND phs.work_done_at IS NOT NULL THEN 'Work done, not fully invoiced'
                             WHEN phs.uninvoiced THEN 'Not fully invoiced' ELSE 'Invoiced' END
    WHEN 'payment' THEN CASE WHEN phs.owing AND phs.work_done_at IS NOT NULL THEN 'Work done, payment owing'
                             WHEN phs.owing THEN 'Payment owing' ELSE 'Final payment stage' END
    WHEN 'rectification' THEN 'In rectification'
    WHEN 'makesafe' THEN 'Make-safe in progress' ELSE 'In progress' END
   || coalesce(' since ' || to_char((phs.phase_since_at AT TIME ZONE 'Australia/Perth')::date, 'Dy FMDD Mon')
               || CASE WHEN extract(year FROM (phs.phase_since_at AT TIME ZONE 'Australia/Perth')) <> extract(year FROM phs.today)
                       THEN ' ' || extract(year FROM (phs.phase_since_at AT TIME ZONE 'Australia/Perth')) ELSE '' END, '') AS phase_words,
   CASE WHEN nx.b IS NOT NULL THEN 'next visit ' || coalesce(replace(nx.b->>'assignment_type', '_', ' ') || ' ', '') || 'booked ' || nx.day END AS next_words,
   CASE WHEN phs.phase = 'install' AND phs.unattended_on IS NOT NULL
        THEN 'attendance not recorded for ' || to_char(phs.unattended_on, 'Dy FMDD Mon')
             || CASE WHEN extract(year FROM phs.unattended_on) <> extract(year FROM phs.today) THEN ' ' || extract(year FROM phs.unattended_on) ELSE '' END
   END AS att_words,
   (SELECT CASE WHEN t.owner = 'us' THEN 'we owe: ' WHEN t.owner = 'customer' THEN 'the customer owes: '
                WHEN t.owner = 'third_party' THEN 'waiting on another party: ' ELSE 'open: ' END
           || left(regexp_replace(t.what, '\s+', ' ', 'g'), 140) FROM top t) AS top_words,
   CASE WHEN mt.owing > 0 THEN 'owing ' || to_char(mt.owing, 'FM$999,999,990.00')
            || CASE WHEN mt.overdue > 0 THEN ' (' || to_char(mt.overdue, 'FM$999,999,990.00') || ' overdue)' ELSE '' END END AS owing_words,
   CASE WHEN mt.drafts > 0 THEN mt.drafts || CASE WHEN mt.drafts = 1 THEN ' draft invoice' ELSE ' draft invoices' END || ' not issued' END AS draft_words,
   CASE WHEN coalesce(mt.nyi, 0) > 1 THEN to_char(mt.nyi, 'FM$999,999,990.00') || ' not yet invoiced' END AS nyi_words,
   CASE wm.whose WHEN 'us' THEN 'Our move' WHEN 'customer' THEN 'The customer''s move'
        WHEN 'third_party' THEN 'Waiting on another party' WHEN 'unknown' THEN 'Whose move is unclear'
        ELSE CASE WHEN nx.b IS NOT NULL THEN 'Nothing open until the visit' ELSE 'Nothing open on record' END END AS move_words,
   (SELECT 'the customer wrote last on ' || to_char((wl.at AT TIME ZONE 'Australia/Perth')::date, 'Dy FMDD Mon')
           || CASE WHEN extract(year FROM (wl.at AT TIME ZONE 'Australia/Perth')) <> extract(year FROM phs.today)
                   THEN ' ' || extract(year FROM (wl.at AT TIME ZONE 'Australia/Perth')) ELSE '' END
           || '; not read yet' FROM wl) AS wrote_words
  FROM phs, nx, mt, wm
 ),
 nowl AS (
  SELECT n.*, (SELECT string_agg(upper(left(x.s, 1)) || substr(x.s, 2), '. ' ORDER BY x.o) FROM (VALUES
           (1, n.phase_words || coalesce(': ' || n.next_words, '') || coalesce('; ' || n.att_words, '')),
           (2, nullif(concat_ws(', ', n.owing_words, n.draft_words, n.nyi_words), '')),
           (3, n.move_words || coalesce(', ' || n.top_words, '')),
           (4, n.wrote_words)) x(o, s) WHERE x.s IS NOT NULL) AS line0
  FROM nowp n
 ),
 nowline AS (
  SELECT n.*, CASE WHEN length(n.line0) <= 399 THEN n.line0 || CASE WHEN n.line0 ~ '[.!?"]$' THEN '' ELSE '.' END
                   ELSE left(n.line0, 396 - position(' ' IN reverse(left(n.line0, 396)))) || '...' END AS line
  FROM nowl n
 ),
 blockers AS (
  SELECT l.what, l.cites FROM loops l WHERE l.blocks IS NOT NULL
  UNION ALL
  SELECT r.what, jsonb_build_array(jsonb_build_object('t', r.source_table, 'id', r.source_id)) FROM rl r WHERE r.rule = 'R3_draft'
 ),
 -- not known
 nk AS (
  SELECT x.what, x.why, x.ord FROM inp, led, LATERAL (VALUES
   (1, CASE WHEN coalesce((inp.meta->'lanes'->>'texts')::int, 0) = 0 THEN 'No texts are on record for this job.' END,
       'Texts reach a job only through its CRM contact or a job reference.'),
   (2, CASE WHEN coalesce((inp.meta->'lanes'->>'emails')::int, 0) = 0 THEN 'No emails are on record for this job.' END,
       'Emails reach a job by thread, sender or job reference.'),
   (3, CASE WHEN coalesce((inp.meta->'lanes'->>'calls')::int, 0) = 0 THEN 'No calls are on record for this job.' END,
       'Only calls logged by the phone system are captured.'),
   (4, CASE WHEN coalesce((inp.meta->'lanes'->>'documents')::int, 0) = 0 THEN 'No documents have been read into evidence for this job.' END,
       'Only documents whose text was extracted are evidence.'),
   (5, CASE WHEN (inp.meta->>'history_start')::timestamptz > (inp.job->>'created_at')::timestamptz + interval '2 days'
            THEN 'Message history on record starts ' || to_char(((inp.meta->>'history_start')::timestamptz AT TIME ZONE 'Australia/Perth')::date, 'Dy FMDD Mon YYYY')
                 || ', after the job began ' || to_char(((inp.job->>'created_at')::timestamptz AT TIME ZONE 'Australia/Perth')::date, 'Dy FMDD Mon YYYY') || '.' END,
       'Earlier messages were not captured.'),
   (6, CASE WHEN led.gen IS NOT NULL AND coalesce(led.unread, 0) > 0
            THEN led.unread || CASE WHEN led.unread = 1 THEN ' newer message on this job has' ELSE ' newer messages on this job have' END
                 || ' not been read by the reader yet.' END,
       'The reader reads new evidence on its own schedule.'),
   (7, CASE WHEN coalesce((inp.meta->'unplaced'->>'count')::int, 0) > 0
            THEN (inp.meta->'unplaced'->>'count') || CASE WHEN (inp.meta->'unplaced'->>'count')::int = 1 THEN ' message' ELSE ' messages' END
                 || ' from this customer are not placed on any job yet.' END,
       'They may belong to this job; they wait in the placement queue.'),
   (8, CASE WHEN EXISTS (SELECT 1 FROM rl r WHERE r.rule = 'C4_booking_attendance_unrecorded')
            THEN 'Attendance is not recorded for a booking that has passed.' END,
       'The crew did not mark it started or complete.'),
   (9, CASE WHEN led.status = 'none' THEN 'No reader has read this job''s messages yet, so promises, requests and agreements in the words are not shown.'
            WHEN led.status IN ('shadow', 'building') AND led.gen IS NULL THEN 'The reader''s ledger for this job is not live yet, so the words are not shown.' END,
       'The ledger is written by the reader and shown once live.'),
   (10, CASE WHEN led.hidden - led.hidden_locked > 0 THEN (led.hidden - led.hidden_locked)
             || CASE WHEN led.hidden - led.hidden_locked = 1 THEN ' reader item was' ELSE ' reader items were' END
             || ' hidden because messages it cited moved off this job; the story needs a rebuild.' END,
        'A ledger item is shown only while every message it cites is still on this job.'),
   (14, CASE WHEN led.hidden_locked > 0 THEN led.hidden_locked
             || CASE WHEN led.hidden_locked = 1 THEN ' staff correction cites a message' ELSE ' staff corrections cite messages' END
             || ' that moved off this job; a person needs to check '
             || CASE WHEN led.hidden_locked = 1 THEN 'it.' ELSE 'them.' END END,
        'A rebuild keeps staff corrections as they are, so only a person can fix this.'),
   (11, CASE WHEN coalesce((inp.meta->>'contact_missing')::boolean, false) THEN 'This job has no CRM contact, so texts and calls may not reach it.' END,
        'Texts and calls are placed by the CRM contact.'),
   (12, CASE WHEN led.status = 'shadow' AND led.gen IS NOT NULL THEN 'This story shows a shadow reading that is not live yet.'
             WHEN led.gen IS NOT NULL AND led.gen->>'status' IN ('failed', 'retired', 'building')
             THEN 'This story shows a ' || (led.gen->>'status') || ' reading, not the live one.' END,
        'A shadow generation is checked before it is promoted; a failed, retired or unfinished one is never shown by default.'),
   (13, 'Phone calls that were not recorded are not here.', 'Only calls the phone system logged are captured.')
  ) x(ord, what, why)
  WHERE x.what IS NOT NULL
 ),
 -- who
 who AS (
  SELECT DISTINCT ON (lower(w.name), w.role) w.name, w.role, w.contact_ref, w.cites, w.ord FROM (
   SELECT inp.job->>'client_name' AS name, CASE WHEN inp.job->>'type' = 'makesafe' THEN 'insured' ELSE 'customer' END AS role,
          inp.job->>'ghl_contact_id' AS contact_ref, jsonb_build_array(jsonb_build_object('t', 'jobs', 'id', inp.job->>'id')) AS cites, 1 AS ord
   FROM inp WHERE nullif(btrim(inp.job->>'client_name'), '') IS NOT NULL
   UNION ALL
   SELECT m.party, 'payer', m.xero_contact_id,
          (SELECT jsonb_agg(jsonb_build_object('t', 'xero_invoices', 'id', i->>'id')) FROM jsonb_array_elements(m.invoices) i), 2
   FROM mo m WHERE m.party IS NOT NULL  -- a payer has an issued invoice; drafts alone make nobody a payer
     AND (coalesce(m.invoiced, 0) > 0 OR coalesce(m.paid, 0) > 0 OR coalesce(m.credited, 0) > 0)
   UNION ALL
   SELECT p->>'name', coalesce(p->>'role', 'party'), p->>'contact_ref', jsonb_build_array(jsonb_build_object('t', 'job_contacts', 'id', p->>'id')), 3
   FROM inp, jsonb_array_elements(coalesce(inp.rec->'facts'->'parties', '[]'::jsonb)) p WHERE nullif(btrim(p->>'name'), '') IS NOT NULL
   UNION ALL
   SELECT n.nm, n.rl, NULL, (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(n.ob) c), 4
   FROM (SELECT v.from_name AS nm, v.from_role AS rl, v.opened_by AS ob FROM vis v WHERE v.status NOT IN ('disputed', 'superseded', 'declined')
         UNION ALL SELECT v.to_name, v.to_role, v.opened_by FROM vis v WHERE v.status NOT IN ('disputed', 'superseded', 'declined')) n
   WHERE nullif(btrim(n.nm), '') IS NOT NULL
  ) w ORDER BY lower(w.name), w.role, w.ord
 ),
 cm AS (
  SELECT
   (SELECT count(*) FROM vis v WHERE v.item_type = 'commitment' AND v.status = 'closed' AND (v.due_date IS NULL OR (v.closed_at AT TIME ZONE 'Australia/Perth')::date <= v.due_date)) AS kept,
   (SELECT count(*) FROM vis v WHERE v.item_type = 'commitment' AND v.status = 'closed' AND v.due_date IS NOT NULL AND (v.closed_at AT TIME ZONE 'Australia/Perth')::date > v.due_date) AS late,
   (SELECT count(*) FROM vis v, inp WHERE v.item_type = 'commitment' AND v.status = 'open' AND (v.due_date IS NULL OR v.due_date >= inp.today)) AS open_,
   (SELECT count(*) FROM vis v, inp WHERE v.item_type = 'commitment' AND v.status = 'open' AND v.due_date < inp.today) AS overdue
 ),
 tlout AS (
  SELECT t.*,
   CASE t.kind WHEN 'quote' THEN 'quote' WHEN 'invoice' THEN 'invoice' WHEN 'payment' THEN 'payment' WHEN 'credit' THEN 'payment'
        WHEN 'booking' THEN 'scheduled' WHEN 'attendance' THEN 'install' WHEN 'site_visit' THEN 'scope' WHEN 'first_contact' THEN 'enquiry'
        WHEN 'job_created' THEN 'enquiry' WHEN 'rectification' THEN 'rectification' WHEN 'makesafe' THEN 'makesafe' END AS phase
  FROM tl t WHERE t.kind <> 'booking_mirror'
 )
 SELECT jsonb_build_object(
  'version', 'job-story-v1',
  'job', (SELECT jsonb_build_object('id', inp.job->'id', 'job_number', inp.job->'job_number', 'type', inp.job->'type',
                 'status', inp.job->'status', 'client_name', inp.job->'client_name', 'site_suburb', inp.job->'site_suburb',
                 'created_at', inp.job->'created_at') FROM inp),
  'as_of', (SELECT inp.as_of FROM inp),
  'now', (SELECT jsonb_build_object(
            'line', n.line, 'phase', n.phase,
            'phase_since', (n.phase_since_at AT TIME ZONE 'Australia/Perth')::date,
            'whose_move', (SELECT wm.whose FROM wm),
            'next', CASE WHEN (SELECT nx.b FROM nx) IS NOT NULL
                         THEN (SELECT jsonb_build_object('what', 'Visit booked: ' || replace(coalesce(nx.b->>'assignment_type', 'visit'), '_', ' ')
                                                         || coalesce(' (' || nullif(btrim(nx.b->>'crew_name'), '') || ')', ''),
                                                         'when', nx.b->'scheduled_date', 'day', nx.day,
                                                         'cites', jsonb_build_array(jsonb_build_object('t', 'job_assignments', 'id', nx.b->>'id'))) FROM nx)
                         WHEN EXISTS (SELECT 1 FROM top)
                         THEN (SELECT jsonb_build_object('what', t.what, 'when', t.due, 'cites', t.cites) FROM top t) END,
            'blockers', coalesce((SELECT jsonb_agg(jsonb_build_object('what', b.what, 'cites', b.cites)) FROM blockers b), '[]'::jsonb),
            'cites', coalesce((SELECT jsonb_agg(DISTINCT z.c) FROM (
                       SELECT c FROM top t, jsonb_array_elements(t.cites) c
                       UNION ALL SELECT jsonb_build_object('t', 'job_assignments', 'id', nx.b->>'id') FROM nx WHERE nx.b IS NOT NULL
                       UNION ALL SELECT jsonb_build_object('t', 'jobs', 'id', inp.job->>'id') FROM inp) z), '[]'::jsonb))
          FROM nowline n),
  'money', (SELECT jsonb_build_object(
             'line', CASE WHEN mt.invoiced = 0 AND mt.drafts = 0 THEN 'No invoices issued'
                          ELSE 'Invoiced ' || to_char(mt.invoiced, 'FM$999,999,990.00') || ', paid ' || to_char(mt.paid, 'FM$999,999,990.00')
                               || CASE WHEN mt.credited > 0 THEN ', credited ' || to_char(mt.credited, 'FM$999,999,990.00') ELSE '' END
                               || ', owing ' || to_char(mt.owing, 'FM$999,999,990.00') END
                     || CASE WHEN mt.overdue > 0 THEN ' (' || to_char(mt.overdue, 'FM$999,999,990.00') || ' overdue since '
                                                     || to_char(mt.oldest_overdue, 'Dy FMDD Mon') || ')' ELSE '' END
                     || CASE WHEN mt.drafts > 0 THEN '; ' || mt.drafts || ' draft ' || CASE WHEN mt.drafts = 1 THEN 'invoice' ELSE 'invoices' END
                                                     || ' of ' || to_char(mt.draft_total, 'FM$999,999,990.00') || ' not issued' ELSE '' END
                     || CASE WHEN coalesce(mt.nyi, 0) > 1 THEN '; ' || to_char(mt.nyi, 'FM$999,999,990.00') || ' of the job value not yet invoiced' ELSE '' END
                     || CASE WHEN mt.parties > 1 THEN '; ' || mt.parties || ' paying parties' ELSE '' END || '.',
             'job_value', jsonb_build_object('amount', mt.job_value, 'basis', mt.job_value_basis),
             'parties', coalesce((SELECT jsonb_agg(jsonb_build_object('party', m.party, 'xero_contact_id', m.xero_contact_id,
                          'invoiced', m.invoiced, 'paid', m.paid, 'credited', m.credited, 'owing', m.owing, 'overdue', m.overdue,
                          'oldest_overdue_due', m.oldest_overdue_due, 'drafts', m.drafts, 'draft_total', m.draft_total,
                          'invoices', m.invoices) ORDER BY m.owing DESC, m.party) FROM mo m WHERE m.party IS NOT NULL), '[]'::jsonb),
             'not_yet_invoiced', CASE WHEN coalesce(mt.nyi, 0) > 1
                                      THEN jsonb_build_object('amount', mt.nyi, 'basis', 'job value (' || coalesce(mt.job_value_basis, 'unknown')
                                                              || ') minus issued customer invoices',
                                                              'cites', jsonb_build_array(jsonb_build_object('t', 'jobs', 'id', inp.job->>'id'))) END,
             'supplier_bills', coalesce(mt.bills, '[]'::jsonb))
           FROM mt, inp),
  'loops', coalesce((SELECT jsonb_agg(jsonb_build_object('key', l.key, 'source', l.source, 'rule', l.rule, 'about_key', l.about_key,
             'owner', l.owner, 'owner_name', l.owner_name, 'counterparty', l.counterparty, 'what', l.what, 'why', l.why, 'since', l.since,
             'due', l.due, 'age_days', l.age_days, 'status', l.status, 'closes_when', l.closes_when, 'blocks', l.blocks,
             'closing_evidence', l.closing_evidence, 'cites', l.cites, 'rank', l.rank) ORDER BY l.rank) FROM loops l), '[]'::jsonb),
  'checks', coalesce((SELECT jsonb_agg(jsonb_build_object('rule', c.rule, 'what', c.what, 'cites', c.cites) ORDER BY c.opened_at, c.rule)
                      FROM checks c), '[]'::jsonb),
  -- each line names its record and that record's state (and a booking when it was made),
  -- so nothing downstream reads them from the words
  'timeline', coalesce((SELECT jsonb_agg(jsonb_build_object('at', t.at, 'date', t.perth_date, 'kind', t.kind, 'what', t.what,
                         'amount', t.amount, 'phase', t.phase, 'source_table', t.source_table, 'source_id', t.source_id,
                         'state', t.state, 'made_at', t.made_at,
                         'cites', jsonb_build_array(jsonb_build_object('t', t.source_table, 'id', t.source_id)))
                         ORDER BY t.at, t.kind, t.source_id) FROM tlout t), '[]'::jsonb),
  'phase_notes', coalesce((SELECT jsonb_agg(jsonb_build_object('phase', v.phase, 'what', v.what,
                   'cites', (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(v.opened_by) c))
                   ORDER BY v.opened_at) FROM vis v WHERE v.item_type = 'phase_note'
                   AND v.status NOT IN ('disputed', 'superseded', 'declined')), '[]'::jsonb),
  'agreements', coalesce((SELECT jsonb_agg(jsonb_build_object('key', v.item_key, 'what', v.what, 'modality', v.modality, 'since', v.opened_at,
                  'status', v.status, 'supersedes', v.supersedes_key,
                  'cites', (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(v.opened_by) c))
                  ORDER BY v.opened_at) FROM vis v WHERE v.item_type = 'agreement'), '[]'::jsonb),
  'events', coalesce((SELECT jsonb_agg(jsonb_build_object('key', v.item_key, 'what', v.what, 'at', v.opened_at,
              'cites', (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(v.opened_by) c))
              ORDER BY v.opened_at) FROM vis v WHERE v.item_type = 'event'
              AND v.status NOT IN ('disputed', 'superseded', 'declined')), '[]'::jsonb),
  'who', coalesce((SELECT jsonb_agg(jsonb_build_object('name', w.name, 'role', w.role, 'contact_ref', w.contact_ref, 'cites', w.cites)
                   ORDER BY w.ord, w.name) FROM who w), '[]'::jsonb),
  'last_exchange', (SELECT jsonb_build_object('customer_said', inp.rec->'contact'->'last_customer_message',
                     'we_told_customer', inp.rec->'contact'->'last_to_customer', 'internal', inp.rec->'contact'->'last_internal') FROM inp),
  'handling', (SELECT jsonb_build_object('customer_messages', coalesce((inp.rec->'contact'->>'customer_messages')::int, 0),
                'replies', coalesce((inp.rec->'contact'->>'replies')::int, 0),
                'median_reply_hours', (inp.rec->'contact'->>'median_reply_hours')::numeric,
                'unanswered', coalesce((inp.rec->'contact'->>'unanswered')::int, 0),
                'commitments', jsonb_build_object('kept', cm.kept, 'late', cm.late, 'open', cm.open_, 'overdue', cm.overdue))
               FROM inp, cm),
  'not_known', coalesce((SELECT jsonb_agg(jsonb_build_object('what', k.what, 'why', k.why) ORDER BY k.ord) FROM nk k), '[]'::jsonb),
  'changes', (SELECT CASE WHEN inp.since IS NULL THEN NULL ELSE coalesce((SELECT jsonb_agg(x.o ORDER BY x.at) FROM (
               SELECT t.at, jsonb_build_object('at', t.at, 'kind', t.kind, 'what', t.what,
                      'cites', jsonb_build_array(jsonb_build_object('t', t.source_table, 'id', t.source_id))) AS o
               FROM tlout t WHERE t.at > inp.since AND t.at <= inp.as_of
               UNION ALL
               SELECT l.since, jsonb_build_object('at', l.since, 'kind', 'loop_opened', 'what', l.what, 'cites', l.cites)
               FROM loops l WHERE l.since > inp.since
               UNION ALL
               SELECT (x->>'at')::timestamptz, jsonb_build_object('at', x->'at', 'kind', 'ledger_' || coalesce(x->>'to_status', 'change'),
                      'what', coalesce(x->>'reason', 'Ledger item ' || coalesce(x->>'item_key', '') || ' moved to ' || coalesce(x->>'to_status', '?')),
                      'cites', coalesce(x->'evidence', '[]'::jsonb))
               FROM jsonb_array_elements(coalesce(inp.led->'transitions', '[]'::jsonb)) x WHERE (x->>'at')::timestamptz > inp.since
              ) x), '[]'::jsonb) END FROM inp),
  'meta', (SELECT jsonb_build_object(
             'ledger', jsonb_build_object('status', led.status, 'generation_id', led.gen->'id', 'evidence_until', led.gen->'evidence_until',
                         'reader', led.gen->'reader', 'items', led.items, 'hidden_items', led.hidden, 'unread_rows', led.unread,
                         'needs_rebuild', led.hidden - led.hidden_locked > 0,
                         'stale', led.hidden - led.hidden_locked > 0 OR coalesce(led.unread, 0) > 0),
             'sources', coalesce(inp.meta->'sources', '{}'::jsonb), 'evidence_rows', coalesce((inp.meta->>'evidence_rows')::int, 0),
             'built_at', now())
           FROM inp, led)
 )
$fn$;
COMMENT ON FUNCTION public.context_job_story_assemble(jsonb, jsonb, jsonb, jsonb, timestamptz, timestamptz) IS
 'Job story (20261006014000): the pure assembler of job-story-v1. Reads no table: job header, record parts (timeline, loops, money, contact, facts), ledger (generation, items with citation re-check result, transitions, its reader''s unread rows) and meta in; the cited story out. meta.ledger = {status, generation_id, evidence_until, reader, items, hidden_items, unread_rows, needs_rebuild, stale}. Inlinable (no SET). Service role only.';

-- 2. Record facts the assembler needs in structured form.
CREATE OR REPLACE FUNCTION public.context_job_story_facts(p_job_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 SELECT jsonb_build_object(
  'bookings', coalesce((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'scheduled_date', a.scheduled_date, 'status', a.status,
                'assignment_type', a.assignment_type, 'crew_name', a.crew_name, 'created_at', a.created_at,
                'started_at', CASE WHEN a.started_at <= p_as_of THEN a.started_at END,
                'completed_at', CASE WHEN a.completed_at <= p_as_of THEN a.completed_at END) ORDER BY a.scheduled_date, a.id)
              FROM public.job_assignments a
              WHERE a.job_id = p_job_id AND a.created_at <= p_as_of AND NOT coalesce(a.is_ghost, false) AND coalesce(a.role, '') <> 'observer'),
             '[]'::jsonb),
  'quotes', coalesce((SELECT jsonb_agg(jsonb_build_object('id', d.id, 'quote_number', d.quote_number, 'version', d.version,
                'sent_at', CASE WHEN d.sent_at <= p_as_of THEN d.sent_at END,
                'accepted_at', CASE WHEN d.accepted_at <= p_as_of THEN d.accepted_at END,
                'declined_at', CASE WHEN d.declined_at <= p_as_of THEN d.declined_at END,
                'superseded_at', CASE WHEN d.superseded_at <= p_as_of THEN d.superseded_at END) ORDER BY d.created_at, d.id)
              FROM public.job_documents d WHERE d.job_id = p_job_id AND d.type = 'quote' AND d.created_at <= p_as_of), '[]'::jsonb),
  'report_sent_at', (SELECT min(je.created_at) FROM public.job_events je
                     WHERE je.job_id = p_job_id AND je.created_at <= p_as_of
                       AND je.event_type IN ('makesafe_report_sent_at_derived', 'makesafe_pack_sent_at_derived')),
  'parties', coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.client_name,
                'role', CASE WHEN coalesce(c.is_primary, false) OR c.contact_type = 'primary' THEN 'customer' ELSE coalesce(c.contact_type, 'party') END,
                'contact_ref', c.ghl_contact_id) ORDER BY c.created_at, c.id)
              FROM public.job_contacts c WHERE c.job_id = p_job_id AND c.removed_at IS NULL), '[]'::jsonb),
  'closing', coalesce((SELECT jsonb_agg(x) FROM (
     SELECT jsonb_build_object('closes_on', 'quote_sent', 'about_key', 'quote:' || lower(coalesce(nullif(btrim(d.quote_number), ''), 'doc-' || left(d.id::text, 8))),
            'at', d.sent_at, 't', 'job_documents', 'id', d.id, 'what', 'Quote ' || coalesce(d.quote_number, 'without a number') || ' sent') AS x
     FROM public.job_documents d WHERE d.job_id = p_job_id AND d.type = 'quote' AND d.sent_at <= p_as_of
     UNION ALL
     SELECT jsonb_build_object('closes_on', 'invoice_issued', 'about_key', 'invoice:' || lower(coalesce(nullif(btrim(x.invoice_number), ''), 'id-' || left(x.id::text, 8))),
            'at', coalesce(x.created_at, x.invoice_date::timestamp AT TIME ZONE 'Australia/Perth'), 't', 'xero_invoices', 'id', x.id,
            'what', 'Invoice ' || coalesce(x.invoice_number, 'without a number') || ' issued')
     FROM public.xero_invoices x
     WHERE x.job_id = p_job_id AND upper(coalesce(x.invoice_type, 'ACCREC')) = 'ACCREC'
       AND upper(coalesce(x.status, '')) IN ('AUTHORISED', 'SUBMITTED', 'PAID') AND coalesce(x.created_at, '-infinity'::timestamptz) <= p_as_of
     UNION ALL
     -- a payment closes only when the invoice is cleared: the payment that cleared it
     SELECT jsonb_build_object('closes_on', 'payment', 'about_key', 'invoice:' || lower(coalesce(nullif(btrim(x.invoice_number), ''), 'id-' || left(x.id::text, 8))),
            'at', pc.at, 't', 'xero_invoices', 'id', x.id,
            'what', 'Invoice ' || coalesce(x.invoice_number, 'without a number') || ' paid in full')
     FROM public.xero_invoices x
     CROSS JOIN LATERAL (
      SELECT coalesce(max(to_timestamp(substring(p->>'Date' FROM '^/Date\((-?[0-9]+)')::numeric / 1000)),
                      x.fully_paid_on::timestamp AT TIME ZONE 'Australia/Perth') AS at
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(x.raw_json->'Payments') = 'array' THEN x.raw_json->'Payments' ELSE '[]'::jsonb END) p
      WHERE p->>'Date' ~ '^/Date\(-?[0-9]+') pc
     WHERE x.job_id = p_job_id AND upper(coalesce(x.invoice_type, 'ACCREC')) = 'ACCREC' AND upper(coalesce(x.status, '')) = 'PAID'
       AND pc.at <= p_as_of
     UNION ALL
     -- a booking is made while it stands (not cancelled, deleted, draft, disputed or
     -- declined; crew planning's confirmation is never read), at its created time
     SELECT jsonb_build_object('closes_on', 'booking_made', 'about_key', 'booking:' || a.scheduled_date, 'at', a.created_at,
            't', 'job_assignments', 'id', a.id, 'what', 'Booking made for ' || to_char(a.scheduled_date, 'Dy FMDD Mon YYYY'))
     FROM public.job_assignments a
     WHERE a.job_id = p_job_id AND a.created_at <= p_as_of AND a.scheduled_date IS NOT NULL
       AND NOT coalesce(a.is_ghost, false) AND coalesce(a.role, '') <> 'observer'
       AND lower(coalesce(a.status, '')) NOT IN ('cancelled', 'deleted', 'draft', 'disputed', 'declined')
     UNION ALL
     -- a visit is attendance: completed_at, else started_at, else a status-only
     -- completion at the end of the booked Perth day
     SELECT jsonb_build_object('closes_on', 'visit', 'about_key', 'booking:' || a.scheduled_date,
            'at', v.at, 't', 'job_assignments', 'id', a.id,
            'what', CASE WHEN a.completed_at IS NOT NULL OR a.started_at IS NOT NULL
                         THEN 'Crew recorded the ' || to_char(a.scheduled_date, 'Dy FMDD Mon YYYY') || ' visit'
                         ELSE 'Booking status complete for ' || to_char(a.scheduled_date, 'Dy FMDD Mon YYYY') || ' (who and when not recorded)' END)
     FROM public.job_assignments a
     CROSS JOIN LATERAL (SELECT coalesce(a.completed_at, a.started_at,
       CASE WHEN lower(coalesce(a.status, '')) IN ('complete', 'completed') AND a.scheduled_date IS NOT NULL
            THEN ((a.scheduled_date + 1)::timestamp AT TIME ZONE 'Australia/Perth') - interval '1 second' END) AS at) v
     WHERE a.job_id = p_job_id AND v.at <= p_as_of
       AND NOT coalesce(a.is_ghost, false) AND coalesce(a.role, '') <> 'observer'
  ) z), '[]'::jsonb)
 )
$fn$;
COMMENT ON FUNCTION public.context_job_story_facts(uuid, timestamptz) IS
 'Job story (20261006014000): structured record facts for the story assembler: crew bookings (observer mirrors excluded), quote versions, make-safe report sent time, parties (job_contacts), and closing candidates (quote sent, invoice issued, payment, booking made, visit) keyed by the ledger about_key vocabulary. Service role only.';

-- 3. The ledger to show, with every citation re-checked.
CREATE OR REPLACE FUNCTION public.context_job_story_ledger(p_job_id uuid, p_generation_id uuid DEFAULT NULL, p_as_of timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH g AS (  -- the generation asked for, else the one live at p_as_of (the newest promoted by then)
  SELECT x.* FROM public.context_ledger_generations x
  WHERE x.job_id = p_job_id
    AND CASE WHEN p_generation_id IS NOT NULL THEN x.id = p_generation_id
             ELSE x.status IN ('live', 'retired') AND x.promoted_at <= p_as_of END
  ORDER BY x.promoted_at DESC NULLS LAST, x.created_at DESC LIMIT 1
 ),
 other AS (  -- with no generation to show, say whether one is being built or waits in shadow
  SELECT x.status FROM public.context_ledger_generations x
  WHERE x.job_id = p_job_id AND x.status IN ('building', 'shadow') AND NOT EXISTS (SELECT 1 FROM g)
  ORDER BY x.created_at DESC LIMIT 1
 ),
 evr AS MATERIALIZED (  -- the store's own evidence against the shown generation's evidence_until:
                       -- read when it landed by then (nothing is read when no generation is shown)
  SELECT r.src_id, r.copy_of, r.direction, (g.evidence_until IS NOT NULL AND r.landed_at <= g.evidence_until) AS was_read
  FROM g CROSS JOIN LATERAL public.context_ledger_evidence_rows(ARRAY[g.job_id], p_as_of) r
 ),
 unread AS (  -- what the shown generation's reader has not read; copies are listed by id
              -- but not counted as new messages
  SELECT e.src_id, e.copy_of FROM evr e WHERE NOT e.was_read
 ),
 it0 AS (  -- replay: items written by p_as_of, each with its status then
  SELECT i.*, coalesce((SELECT t.to_status FROM public.context_ledger_transitions t WHERE t.item_id = i.id AND t.at <= p_as_of
                         ORDER BY t.at DESC, t.id DESC LIMIT 1), i.status) AS status_then
  FROM public.context_ledger_items i JOIN g ON g.id = i.generation_id
  WHERE i.created_at <= p_as_of
 ),
 it AS (
  SELECT i.*,
   (SELECT jsonb_agg(jsonb_build_object('table', c->>'table', 'id', c->>'id', 'excerpt', c->>'excerpt',
            'at', coalesce(e.event_at, e.occurred_at),
            'ok', CASE WHEN c->>'table' <> 'business_events' THEN true
                       ELSE e.id IS NOT NULL AND e.job_id = p_job_id AND public.context_linked_status(e.attribution_status)
                            AND e.metadata->>'retracted_at' IS NULL AND coalesce(e.metadata->>'retracted', 'false') <> 'true' END,
            'customer', (e.metadata->'party_roles'->>'sender_role' = 'customer')))
    FROM jsonb_array_elements(i.opened_by || CASE WHEN i.closed_at <= p_as_of THEN coalesce(i.closed_by, '[]'::jsonb) ELSE '[]'::jsonb END) c
    LEFT JOIN public.business_events e ON c->>'table' = 'business_events'
     AND e.id = CASE WHEN c->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (c->>'id')::uuid END) AS cited
  FROM it0 i
 )
 SELECT jsonb_build_object(
  'status', coalesce((SELECT g.status FROM g), (SELECT other.status FROM other), 'none'),
  'generation', (SELECT jsonb_build_object('id', g.id, 'status', g.status, 'kind', g.kind, 'reader', g.reader, 'model', g.model,
                  'evidence_until', g.evidence_until, 'evidence_rows', g.evidence_rows, 'created_at', g.created_at,
                  'promoted_at', g.promoted_at) FROM g),
  'items', coalesce((SELECT jsonb_agg(jsonb_build_object('item_key', it.item_key, 'item_type', it.item_type, 'status', it.status_then,
              'from_role', it.from_role, 'from_name', it.from_name, 'to_role', it.to_role, 'to_name', it.to_name, 'what', it.what,
              'about_key', it.about_key, 'modality', it.modality, 'phase', it.phase, 'due_date', it.due_date, 'opened_at', it.opened_at,
              'opened_by', it.opened_by,
              'closed_at', CASE WHEN it.closed_at <= p_as_of AND it.status_then IN ('closed', 'declined', 'superseded') THEN it.closed_at END,
              'closed_by', CASE WHEN it.closed_at <= p_as_of AND it.status_then IN ('closed', 'declined', 'superseded') THEN it.closed_by END,
              'closes_on', it.closes_on,
              'supersedes_key', it.supersedes_key, 'blocks', it.blocks, 'needs_reply', it.needs_reply, 'written_by', it.written_by,
              'person_locked', it.person_locked, 'cited', it.cited,
              'cites_ok', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(it.cited, '[]'::jsonb)) c WHERE NOT (c->>'ok')::boolean))
              ORDER BY it.opened_at, it.item_key) FROM it), '[]'::jsonb),
  'transitions', coalesce((SELECT jsonb_agg(jsonb_build_object('item_key', i.item_key, 'from_status', t.from_status,
                   'to_status', t.to_status, 'at', t.at, 'by', t.by, 'reason', t.reason, 'evidence', t.evidence) ORDER BY t.at, t.id)
                 FROM public.context_ledger_transitions t JOIN public.context_ledger_items i ON i.id = t.item_id
                 JOIN g ON g.id = t.generation_id WHERE t.at <= p_as_of), '[]'::jsonb),
  'unread_rows', CASE WHEN EXISTS (SELECT 1 FROM g) THEN (SELECT count(*)::integer FROM unread u WHERE u.copy_of IS NULL) END,
  'unread_ids', CASE WHEN EXISTS (SELECT 1 FROM g) THEN coalesce((SELECT jsonb_agg(u.src_id::text ORDER BY u.src_id) FROM unread u), '[]'::jsonb) END,
  -- the inbound rows it has read: the story says the reader judged a customer message only for these
  'read_ids', CASE WHEN EXISTS (SELECT 1 FROM g) THEN coalesce((SELECT jsonb_agg(e.src_id::text ORDER BY e.src_id) FROM evr e
                    WHERE e.was_read AND e.direction = 'inbound'), '[]'::jsonb) END
 )
$fn$;
COMMENT ON FUNCTION public.context_job_story_ledger(uuid, uuid, timestamptz) IS
 'Job story (20261006014000): the ledger generation the story shows (the one live at p_as_of, or the one asked for in any status) with the items written by p_as_of, each at its status then, and the transitions by then; every business_events citation is re-checked (still on this job, linked, not retracted) and the item carries cites_ok. unread_rows: the store''s evidence (context_ledger_evidence_rows as of p_as_of, copies not counted) that landed after the shown generation''s evidence_until, so the story says how far its own reader has read; unread_ids: those rows and their copies by id; read_ids: the inbound evidence rows it has read (landed by its evidence_until), so a customer message is called judged only when the reader read it; all three null when no generation is shown. With no generation to show, status says building or shadow when one exists, else none. Service role only.';

-- 4. Evidence lanes, unplaced messages and the CRM contact: what the story must
-- say it does not know. How far the reader has read is the ledger's (3), never
-- the fact pass's unread count.
CREATE OR REPLACE FUNCTION public.context_job_story_meta(p_job_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH e AS (
  SELECT CASE WHEN x.event_type = 'call.transcript_completed' THEN 'transcripts'
              WHEN x.channel = 'sms' OR x.event_type IN ('client.reply', 'client.sms_in', 'client.sms_out') THEN 'texts'
              WHEN x.channel = 'email' OR x.event_type IN ('client.email_in', 'client.email_out', 'supplier.email_in', 'staff.email_internal') THEN 'emails'
              WHEN x.channel = 'call' OR x.event_type IN ('client.call_logged', 'client.call_complete') THEN 'calls'
              WHEN x.event_type IN ('note.added', 'ghl.internal_comment') OR x.channel = 'note' THEN 'notes'
              WHEN x.event_type = 'document.text_extracted' THEN 'documents' END AS lane,
         coalesce(x.event_at, x.occurred_at) AS at
  FROM public.business_events x
  -- the rows the record shows (every row on the job), so "no texts" never sits beside texts
  WHERE x.job_id = p_job_id AND coalesce(x.recorded_at, x.occurred_at) <= p_as_of
 ),
 l AS (SELECT e.lane, count(*) AS n, max(e.at) AS newest, min(e.at) AS oldest FROM e WHERE e.lane IS NOT NULL GROUP BY e.lane),
 lg AS (  -- legacy inbox mail the record layer reads counts as email
  SELECT count(*) AS n, max(m.received_at) AS newest, min(m.received_at) AS oldest
  FROM public.context_job_record_legacy_mail(ARRAY[p_job_id], p_as_of) m
 ),
 un AS (  -- this customer's messages not placed on any job yet that could be this job's
  SELECT count(*) AS n, max(coalesce(u.event_at, u.occurred_at)) AS newest FROM public.context_unplaced_for_job(p_job_id) u
 ),
 jb AS (SELECT nullif(btrim(j.ghl_contact_id), '') IS NULL AS contact_missing FROM public.jobs j WHERE j.id = p_job_id)
 SELECT jsonb_build_object(
  'lanes', jsonb_build_object(
     'texts', coalesce((SELECT l.n FROM l WHERE l.lane = 'texts'), 0),
     'emails', coalesce((SELECT l.n FROM l WHERE l.lane = 'emails'), 0) + (SELECT lg.n FROM lg),
     'calls', coalesce((SELECT l.n FROM l WHERE l.lane = 'calls'), 0) + coalesce((SELECT l.n FROM l WHERE l.lane = 'transcripts'), 0),
     'transcripts', coalesce((SELECT l.n FROM l WHERE l.lane = 'transcripts'), 0),
     'notes', coalesce((SELECT l.n FROM l WHERE l.lane = 'notes'), 0),
     'documents', coalesce((SELECT l.n FROM l WHERE l.lane = 'documents'), 0)),
  'sources', coalesce((SELECT jsonb_object_agg(l.lane, l.newest) FROM l), '{}'::jsonb)
             || CASE WHEN (SELECT lg.n FROM lg) > 0 THEN jsonb_build_object('legacy_inbox', (SELECT lg.newest FROM lg)) ELSE '{}'::jsonb END,
  'history_start', (SELECT min(x) FROM (SELECT l.oldest AS x FROM l WHERE l.lane IN ('texts', 'emails', 'calls', 'transcripts')
                                       UNION ALL SELECT lg.oldest FROM lg) z),
  'evidence_rows', (SELECT coalesce(sum(l.n), 0) FROM l) + (SELECT lg.n FROM lg),
  'unplaced', (SELECT jsonb_build_object('count', un.n, 'newest_at', un.newest) FROM un),
  'contact_missing', coalesce((SELECT jb.contact_missing FROM jb), false)
 )
$fn$;
COMMENT ON FUNCTION public.context_job_story_meta(uuid, timestamptz) IS
 'Job story (20261006014000): evidence lanes on the job (linked rows only; counts and newest time per lane, legacy inbox mail counted as email), history start, this customer''s unplaced messages (context_unplaced_for_job) and whether the job has a CRM contact. Unplaced messages are read as now. How far the reader has read comes from the ledger read, never the fact pass. Service role only.';

-- 5. The story read. An earlier draft of this slice had four arguments; it goes
-- (the guard above refuses one that is not this slice's), so a call by name
-- never finds two candidates.
DROP FUNCTION IF EXISTS public.context_job_story(uuid, timestamptz, uuid, timestamptz);
CREATE OR REPLACE FUNCTION public.context_job_story(p_job_id uuid, p_as_of timestamptz DEFAULT now(),
 p_generation_id uuid DEFAULT NULL, p_since timestamptz DEFAULT NULL, p_record_only boolean DEFAULT false)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 SELECT public.context_job_story_assemble(
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
   'facts', public.context_job_story_facts(p_job_id, p_as_of)),
  -- record_only: the records alone, for the reader's own prompt; the ledger is
  -- not read, so no item, attachment or ledger word reaches the output.
  CASE WHEN coalesce(p_record_only, false) THEN jsonb_build_object('status', 'omitted', 'items', '[]'::jsonb, 'transitions', '[]'::jsonb)
       ELSE public.context_job_story_ledger(p_job_id, p_generation_id, p_as_of) END,
  public.context_job_story_meta(p_job_id, p_as_of),
  p_as_of, p_since)
 WHERE EXISTS (SELECT 1 FROM public.jobs jb WHERE jb.id = p_job_id)
$fn$;
COMMENT ON FUNCTION public.context_job_story(uuid, timestamptz, uuid, timestamptz, boolean) IS
 'Job story (20261006014000): job-story-v1 for one job: now line, money, loops, checks, timeline, phase notes, agreements, events, who, last exchange, handling, not known, changes since p_since, meta. Record parts from the job record layer, the live ledger generation (or p_generation_id in any status), every line cited. p_record_only: the records alone (the ledger is not read: meta.ledger.status omitted, no not_known line about the reader, no ledger item, attachment or words anywhere), for the reader''s own prompt; RPC only, never a door parameter. NULL for an unknown job. Service role only.';

-- 6. The client story: every job of the same client (CRM contact, else exact
-- client email; never a name), money and loops across them, past issues and
-- standing preferences from the ledger, and the other parties on each job.
CREATE OR REPLACE FUNCTION public.context_client_story(p_job_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH me AS (
  SELECT jb.id, nullif(btrim(jb.ghl_contact_id), '') AS contact, lower(nullif(btrim(jb.client_email), '')) AS email
  FROM public.jobs jb WHERE jb.id = p_job_id
 ),
 ident AS (
  SELECT me.*, CASE WHEN me.contact IS NOT NULL THEN 'ghl_contact_id' WHEN me.email IS NOT NULL THEN 'client_email' END AS basis FROM me
 ),
 cj AS (  -- the client's jobs, newest first; the first 20 get a full story
  SELECT jb.id, jb.job_number, jb.type, jb.status::text AS status, jb.created_at,
         jb.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost') AS live,
         row_number() OVER (ORDER BY jb.created_at DESC, jb.id) AS n
  FROM ident i JOIN public.jobs jb
    ON (i.basis = 'ghl_contact_id' AND nullif(btrim(jb.ghl_contact_id), '') = i.contact)
    OR (i.basis = 'client_email' AND lower(nullif(btrim(jb.client_email), '')) = i.email)
  WHERE jb.created_at <= p_as_of
 ),
 st AS (SELECT cj.id, public.context_job_story(cj.id, p_as_of) AS s FROM cj WHERE cj.n <= 20),
 mon AS (SELECT m.* FROM public.context_job_record_money((SELECT array_agg(cj.id) FROM cj), p_as_of) m),
 lp AS (
  SELECT cj.job_number, l AS loop FROM st JOIN cj ON cj.id = st.id, jsonb_array_elements(st.s->'loops') l
 ),
 li AS (  -- visible ledger items across the shown stories' live generations
  SELECT cj.job_number, i.*
  FROM cj JOIN public.context_ledger_generations g ON g.job_id = cj.id AND g.status = 'live'
  JOIN public.context_ledger_items i ON i.generation_id = g.id
  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(i.opened_by) c
                    LEFT JOIN public.business_events e
                      ON e.id = CASE WHEN c->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (c->>'id')::uuid END
                    WHERE c->>'table' = 'business_events'
                      AND (e.id IS NULL OR e.job_id IS DISTINCT FROM cj.id OR NOT public.context_linked_status(e.attribution_status)
                           OR e.metadata->>'retracted_at' IS NOT NULL))
 )
 SELECT jsonb_build_object(
  'version', 'client-story-v1',
  'as_of', p_as_of,
  'job_id', p_job_id,
  'identity', (SELECT jsonb_build_object('basis', i.basis, 'contact_ref', i.contact, 'email_known', i.email IS NOT NULL) FROM ident i),
  'jobs', coalesce((SELECT jsonb_agg(jsonb_build_object('job_id', cj.id, 'job_number', cj.job_number, 'type', cj.type, 'status', cj.status,
             'live', cj.live, 'created_at', cj.created_at, 'phase', st.s->'now'->'phase',
             'now', left(st.s->'now'->>'line', 200),
             'owing', (SELECT coalesce(sum(m.owing), 0) FROM mon m WHERE m.job_id = cj.id),
             'overdue', (SELECT coalesce(sum(m.overdue), 0) FROM mon m WHERE m.job_id = cj.id),
             'cites', jsonb_build_array(jsonb_build_object('t', 'jobs', 'id', cj.id))) ORDER BY cj.created_at DESC)
           FROM cj LEFT JOIN st ON st.id = cj.id), '[]'::jsonb),
  'money', jsonb_build_object('owing', (SELECT coalesce(sum(m.owing), 0) FROM mon m), 'overdue', (SELECT coalesce(sum(m.overdue), 0) FROM mon m),
             'not_yet_invoiced', (SELECT coalesce(sum(x.nyi), 0) FROM (SELECT max(m.not_yet_invoiced) AS nyi FROM mon m GROUP BY m.job_id) x),
             'parties', coalesce((SELECT jsonb_agg(DISTINCT m.party) FROM mon m WHERE m.party IS NOT NULL), '[]'::jsonb),
             -- each paying party on its own: a neighbour's debt is never the client's
             'by_party', coalesce((SELECT jsonb_agg(jsonb_build_object('party', x.party, 'xero_contact_id', x.xero_contact_id,
                            'owing', x.owing, 'overdue', x.overdue, 'job_numbers', x.jobs) ORDER BY x.owing DESC, x.party)
                          FROM (SELECT m.party, m.xero_contact_id, sum(m.owing) AS owing, sum(m.overdue) AS overdue,
                                       jsonb_agg(DISTINCT cj.job_number) AS jobs
                                FROM mon m JOIN cj ON cj.id = m.job_id WHERE m.party IS NOT NULL
                                GROUP BY m.party, m.xero_contact_id) x), '[]'::jsonb)),
  'open_loops', coalesce((SELECT jsonb_agg(x.o) FROM (
                   SELECT lp.loop || jsonb_build_object('job_number', lp.job_number) AS o FROM lp
                   ORDER BY (lp.loop->>'rank')::int, (lp.loop->>'since') LIMIT 10) x), '[]'::jsonb),
  'past_issues', coalesce((SELECT jsonb_agg(jsonb_build_object('job_number', li.job_number, 'what', li.what, 'status', li.status,
                   'since', li.opened_at, 'closed_at', li.closed_at,
                   'cites', (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(li.opened_by) c))
                   ORDER BY li.opened_at) FROM li WHERE li.item_type = 'issue'), '[]'::jsonb),
  'preferences', coalesce((SELECT jsonb_agg(jsonb_build_object('job_number', li.job_number, 'type', li.item_type, 'what', li.what,
                   'about_key', li.about_key, 'status', li.status, 'since', li.opened_at,
                   'cites', (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(li.opened_by) c))
                   ORDER BY li.opened_at)
                 FROM li WHERE li.item_type IN ('agreement', 'constraint') AND (li.about_key LIKE 'preference:%' OR li.about_key LIKE 'access:%')
                   AND li.status IN ('open', 'info')), '[]'::jsonb),
  'other_parties', coalesce((SELECT jsonb_agg(jsonb_build_object('job_number', cj.job_number, 'name', c.client_name, 'role', c.contact_type,
                   'contact_ref', c.ghl_contact_id, 'cites', jsonb_build_array(jsonb_build_object('t', 'job_contacts', 'id', c.id)))
                   ORDER BY cj.created_at DESC, c.created_at)
                 FROM cj JOIN public.job_contacts c ON c.job_id = cj.id
                 WHERE c.removed_at IS NULL AND NOT coalesce(c.is_primary, false) AND coalesce(c.contact_type, '') <> 'primary'), '[]'::jsonb),
  'not_known', coalesce((SELECT jsonb_agg(x.o ORDER BY x.ord) FROM (
                   SELECT 1 AS ord, jsonb_build_object('what', 'This job has no CRM contact and no client email, so the client''s other jobs cannot be found.',
                          'why', 'Clients are matched by CRM contact or exact email, never by name.') AS o
                   FROM ident i WHERE i.basis IS NULL
                   UNION ALL
                   SELECT 2, jsonb_build_object('what', (SELECT count(*) FROM cj WHERE cj.n > 20) || ' older jobs are listed without a full story.',
                          'why', 'At most 20 stories are assembled in one read.')
                   WHERE (SELECT count(*) FROM cj WHERE cj.n > 20) > 0
                   UNION ALL
                   SELECT 3, jsonb_build_object('what', 'Matched by client email only; jobs under a different email or contact are not included.',
                          'why', 'This job has no CRM contact.')
                   FROM ident i WHERE i.basis = 'client_email'
                   UNION ALL
                   SELECT 5, jsonb_build_object('what', 'Owing and overdue add up every paying party on these jobs; money.by_party has each party on its own.',
                          'why', 'Shared work can have more than one payer.')
                   WHERE (SELECT count(DISTINCT coalesce(m.xero_contact_id, m.party)) FROM mon m WHERE m.party IS NOT NULL) > 1
                   UNION ALL
                   SELECT 4, jsonb_build_object('what', 'Past issues and preferences come only from jobs whose ledger is live.',
                          'why', 'The reader has not read every job yet.')
                   WHERE EXISTS (SELECT 1 FROM cj WHERE NOT EXISTS (SELECT 1 FROM public.context_ledger_generations g WHERE g.job_id = cj.id AND g.status = 'live'))
                  ) x), '[]'::jsonb)
 )
 WHERE EXISTS (SELECT 1 FROM me)
$fn$;
COMMENT ON FUNCTION public.context_client_story(uuid, timestamptz) IS
 'Job story (20261006014000): client-story-v1 for the client of one job: identity (CRM contact, else exact client email, never a name), every job of that client with phase, short now line and owing (full story for the newest 20), money across jobs (and by_party, each payer on its own), top 10 open loops, past issues and standing preferences or access constraints from live ledgers, other parties per job, and not_known. Service role only.';

-- 7. Scorecard, cheap rows: the owner's done definition rows 1 to 14 from the live
-- status functions (called, never re-derived). Rows 11 to 13 need every live job's
-- story parts and come from context_story_scorecard_jobs pages (the ops-api door
-- folds them in); here they carry green null and say so.
CREATE OR REPLACE FUNCTION public.context_story_scorecard(p_as_of timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH live AS (
  SELECT jb.id, jb.created_at, coalesce(jb.archived, false) AS archived
  FROM public.jobs jb WHERE jb.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
 ),
 sf AS (SELECT public.context_source_freshness() AS s),
 ps AS (SELECT public.context_pipeline_status() AS s),
 dt AS (SELECT public.context_document_text_status() AS s),
 gh AS (SELECT public.context_ghl_history_progress() AS s),
 eh AS (SELECT public.context_email_history_status() AS s),
 cv AS (SELECT public.context_coverage() AS s),
 msg AS (  -- message rows on live jobs, for who-to-whom
  SELECT e.metadata->'party_roles' AS pr, e.event_type
  FROM public.business_events e JOIN live ON live.id = e.job_id
  WHERE e.channel IN ('sms', 'email', 'call')
     OR e.event_type IN ('client.reply', 'client.email_in', 'client.email_out', 'client.sms_in', 'client.sms_out', 'client.call_complete',
                         'client.call_logged', 'client.message_in', 'supplier.email_in', 'staff.email_internal', 'call.transcript_completed')
 ),
 who AS (
  SELECT count(*) AS n, count(*) FILTER (WHERE m.pr IS NOT NULL) AS stamped,
         count(*) FILTER (WHERE m.pr->>'sender_role' NOT IN ('unknown', '') AND m.pr->>'recipient_role' NOT IN ('unknown', '')) AS both_known
  FROM msg m
 ),
 rows_ AS (
  SELECT 1 AS row, 'Capture: every lane live' AS name,
         jsonb_array_length(coalesce((SELECT sf.s->'alarms' FROM sf), '[]'::jsonb)) = 0 AS green,
         jsonb_array_length(coalesce((SELECT sf.s->'alarms' FROM sf), '[]'::jsonb)) || ' quiet-source alarms' AS value,
         'no quiet-source alarm' AS target,
         coalesce((SELECT string_agg(a->>'source', ', ') FROM sf, jsonb_array_elements(sf.s->'alarms') a), 'none') AS detail
  UNION ALL
  SELECT 2, 'Who-to-whom', (SELECT who.n > 0 AND who.both_known = who.n FROM who),
         (SELECT coalesce(round(100.0 * who.both_known / nullif(who.n, 0), 1) || '% of ' || who.n || ' messages on live jobs name both sides',
                          'no messages on live jobs') FROM who),
         '100% of messages carry sender and recipient role',
         (SELECT (who.n - who.stamped) || ' unstamped (notes are not stamped by design); ' || (who.stamped - who.both_known) || ' with an unknown side' FROM who)
  UNION ALL
  SELECT 3, 'Placement', NULL,
         (SELECT coalesce(ps.s->>'admin_bucket_size', '?') || ' rows in the review bucket' FROM ps),
         '95% of customer-facing and Xero/quote items on the right job',
         'Right-job accuracy needs a graded sample; SQL can count placed rows only (context_pipeline_status evidence_by_attribution_status)'
  UNION ALL
  SELECT 4, 'History', (SELECT (gh.s->>'history_not_started')::int = 0 AND (gh.s->>'history_failed')::int = 0
                               AND coalesce((eh.s->>'finished')::boolean, false) FROM gh, eh),
         (SELECT 'CRM history ' || coalesce(gh.s->>'history_done', '?') || ' of ' || coalesce(gh.s->>'with_contact', '?') || ' jobs with a contact done; email history '
                 || coalesce(eh.s->'by_state'->>'succeeded', '0') || ' of ' || coalesce(eh.s->>'sources', '?') || ' sources finished' FROM gh, eh),
         'every live job''s CRM, email and Xero history loaded',
         (SELECT 'not started ' || coalesce(gh.s->>'history_not_started', '?') || ', failed ' || coalesce(gh.s->>'history_failed', '?')
                 || ', jobs with no contact ' || coalesce(gh.s->>'no_contact', '?') FROM gh)
  UNION ALL
  SELECT 5, 'Documents', (SELECT (dt.s->'documents'->>'never_tried')::int = 0 AND jsonb_array_length(coalesce(dt.s->'alarms', '[]'::jsonb)) = 0 FROM dt),
         (SELECT coalesce(dt.s->'documents'->>'with_text', '?') || ' of ' || coalesce(dt.s->'documents'->>'total', '?') || ' documents read; '
                 || coalesce(dt.s->'documents'->>'never_tried', '?') || ' not tried yet' FROM dt),
         'every document read, no alarms',
         (SELECT 'no text layer ' || coalesce(dt.s->'documents'->>'no_text_layer', '?') || ', too large ' || coalesce(dt.s->'documents'->>'too_large', '?') FROM dt)
  UNION ALL
  SELECT 6, 'Reading', (SELECT (ps.s->>'oldest_pending_event_at')::timestamptz IS NULL
                               OR (ps.s->>'oldest_pending_event_at')::timestamptz > p_as_of - interval '2 hours' FROM ps),
         (SELECT 'oldest unread item ' || coalesce(to_char(((ps.s->>'oldest_pending_event_at')::timestamptz AT TIME ZONE 'Australia/Perth'), 'Dy FMDD Mon HH24:MI'), 'none')
                 || '; ' || coalesce(ps.s->>'ready_jobs', '?') || ' jobs due a read' FROM ps),
         'every placed item read within 2 hours',
         'from context_pipeline_status'
  UNION ALL
  SELECT 7, 'Facts', NULL, (SELECT coalesce(cv.s->'jobs'->>'with_current_fact', '?') || ' jobs with a current fact' FROM cv),
         'independent grader passes 95% on a 10-job sample', 'Needs a graded sample; not measurable in SQL'
  UNION ALL
  SELECT 8, 'Job answer', NULL, 'not measured', 'correct on a 10-job graded sample', 'Needs a graded sample; not measurable in SQL'
  UNION ALL
  SELECT 9, 'Agent use', NULL, 'not measured', 'agent answers correctly for the 10-job test set', 'Needs the agent test run; not measurable in SQL'
  UNION ALL
  SELECT 10, 'Health', NULL, 'this scorecard', 'one scorecard, run hourly, red rows reported',
         'Whether it runs hourly is a schedule outside the database; not measurable here'
  UNION ALL
  SELECT 11, 'Job story', NULL, 'see per-job pages', 'every live job has a timeline, a cited summary per phase and a first line',
         'Measured per job by context_story_scorecard_jobs (paged); the ops-api door folds the pages into this row'
  UNION ALL
  SELECT 12, 'Open loops', NULL, 'see per-job pages', 'every live job lists promises, unanswered asks, money owed and unconfirmed dates, each cited',
         'Measured per job by context_story_scorecard_jobs (paged)'
  UNION ALL
  SELECT 13, 'Client view', NULL, 'see per-job pages', 'every client with a live job has one view across their jobs',
         'Measured per job by context_story_scorecard_jobs (paged): a job without a CRM contact or client email cannot be matched to its client'
  UNION ALL
  SELECT 14, 'History depth', (SELECT coalesce((eh.s->>'finished')::boolean, false)
                                      AND (SELECT min((p->>'window_from')::timestamptz) FROM jsonb_array_elements(eh.s->'plan') p) <= (SELECT min(live.created_at) FROM live)
                                      AND (gh.s->>'history_not_started')::int = 0 FROM eh, gh),
         (SELECT 'email history from ' || coalesce(to_char(((SELECT min((p->>'window_from')::timestamptz) FROM jsonb_array_elements(eh.s->'plan') p) AT TIME ZONE 'Australia/Perth')::date, 'FMDD Mon YYYY'), 'not started')
                 || '; oldest live job started ' || to_char(((SELECT min(live.created_at) FROM live) AT TIME ZONE 'Australia/Perth')::date, 'FMDD Mon YYYY') FROM eh),
         'every lane loaded back to each live job''s start',
         'Email history windows from context_email_history_status; CRM history from context_ghl_history_progress'
 )
 SELECT jsonb_build_object(
  'version', 'story-scorecard-v1', 'as_of', p_as_of,
  'live_jobs', (SELECT count(*) FROM live), 'live_jobs_archived_flag', (SELECT count(*) FROM live WHERE live.archived),
  'rows', (SELECT jsonb_agg(jsonb_build_object('row', r.row, 'name', r.name, 'green', r.green, 'value', r.value, 'target', r.target,
                  'detail', r.detail) ORDER BY r.row) FROM rows_ r),
  'per_job', jsonb_build_object('function', 'context_story_scorecard_jobs', 'page_size', 150,
                                'pages', ceil((SELECT count(*) FROM live) / 150.0)))
$fn$;
COMMENT ON FUNCTION public.context_story_scorecard(timestamptz) IS
 'Job story (20261006014000): the owner''s done definition rows 1 to 14 (story-scorecard-v1) from the live status functions (context_source_freshness, context_pipeline_status, context_document_text_status, context_ghl_history_progress, context_email_history_status, context_coverage), called not re-derived. green null = not measurable in SQL, with the reason. Rows 11 to 13 are measured per job by context_story_scorecard_jobs. Live jobs = status not cancelled, draft, archived, complete, completed, lost; archived-flag live jobs counted separately. Service role only.';

-- 8. Scorecard, per-job rows (paged, under the 8 s API statement timeout).
CREATE OR REPLACE FUNCTION public.context_story_scorecard_jobs(p_after uuid DEFAULT NULL, p_limit integer DEFAULT 150)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH pg AS (
  SELECT jb.id, jb.job_number, coalesce(jb.archived, false) AS archived,
         (nullif(btrim(jb.ghl_contact_id), '') IS NOT NULL OR nullif(btrim(jb.client_email), '') IS NOT NULL) AS identity
  FROM public.jobs jb
  WHERE jb.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
    AND (p_after IS NULL OR jb.id > p_after)
  ORDER BY jb.id LIMIT least(greatest(coalesce(p_limit, 150), 1), 300)
 ),
 ids AS (SELECT array_agg(pg.id) AS a FROM pg),
 np AS (SELECT f.job_id, f.needs_person, f.failed_builds FROM public.context_ledger_failures((SELECT a FROM ids)) f),
 tl AS (SELECT t.job_id, count(*) AS n, count(DISTINCT t.kind) AS kinds FROM public.context_job_record_timeline((SELECT a FROM ids), now()) t GROUP BY t.job_id),
 lp AS (SELECT l.job_id, count(*) FILTER (WHERE l.shown_as = 'loop') AS loops, count(*) FILTER (WHERE l.shown_as = 'candidate') AS candidates,
               count(*) FILTER (WHERE l.shown_as = 'check') AS checks
        FROM public.context_job_record_loops((SELECT a FROM ids), now()) l GROUP BY l.job_id),
 lg AS (SELECT g.job_id, g.status, g.evidence_until,
               (SELECT count(*) FROM public.context_ledger_items i WHERE i.generation_id = g.id) AS items,
               (SELECT count(*) FROM public.context_ledger_items i WHERE i.generation_id = g.id AND i.item_type = 'phase_note') AS phase_notes
        FROM public.context_ledger_generations g WHERE g.job_id = ANY ((SELECT a FROM ids)::uuid[]) AND g.status = 'live')
 SELECT jsonb_build_object(
  'version', 'story-scorecard-jobs-v1',
  'jobs', coalesce((SELECT jsonb_agg(jsonb_build_object('job_id', pg.id, 'job_number', pg.job_number, 'archived_flag', pg.archived,
            'identity', pg.identity, 'timeline_rows', coalesce(tl.n, 0), 'timeline_kinds', coalesce(tl.kinds, 0),
            'record_loops', coalesce(lp.loops, 0), 'candidates', coalesce(lp.candidates, 0), 'checks', coalesce(lp.checks, 0),
            'ledger', coalesce(lg.status, 'none'), 'ledger_items', coalesce(lg.items, 0), 'phase_notes', coalesce(lg.phase_notes, 0),
            'ledger_needs_person', coalesce(np.needs_person, false),
            'row11_green', coalesce(tl.n, 0) >= 2 AND lg.status = 'live' AND coalesce(lg.phase_notes, 0) > 0,
            'row12_green', lg.status = 'live',
            'row13_green', pg.identity) ORDER BY pg.id)
          FROM pg LEFT JOIN tl ON tl.job_id = pg.id LEFT JOIN lp ON lp.job_id = pg.id LEFT JOIN lg ON lg.job_id = pg.id
          LEFT JOIN np ON np.job_id = pg.id), '[]'::jsonb),
  'next', (SELECT CASE WHEN count(*) = least(greatest(coalesce(p_limit, 150), 1), 300) THEN max(pg.id::text) END FROM pg)
 )
$fn$;
COMMENT ON FUNCTION public.context_story_scorecard_jobs(uuid, integer) IS
 'Job story (20261006014000): per-job scorecard rows for done-definition rows 11 to 13, one page of live jobs ordered by id after p_after (at most 300): timeline rows and kinds, record loops, candidates and checks, live ledger items and phase notes, client identity, and ledger_needs_person (three ledger builds in a row failed their checks: context_ledger_failures). row11 green = timeline plus a live ledger with phase notes; row12 green = live ledger (promises and asks come from the words); row13 green = the job can be matched to its client. next = the cursor for the following page, null at the end. Service role only.';

-- 9. Access: service role only.
REVOKE ALL ON FUNCTION public.context_job_story_assemble(jsonb, jsonb, jsonb, jsonb, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_story_facts(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_story_ledger(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_story_meta(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_story(uuid, timestamptz, uuid, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_client_story(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_story_scorecard(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_story_scorecard_jobs(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_story_assemble(jsonb, jsonb, jsonb, jsonb, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_story_facts(uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_story_ledger(uuid, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_story_meta(uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_story(uuid, timestamptz, uuid, timestamptz, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_client_story(uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_story_scorecard(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_story_scorecard_jobs(uuid, integer) TO service_role;

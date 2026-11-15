-- Finished notes: on a job whose work is done, the card stops treating as owed the AI notes that the
-- records already answer, and a job the office closed with every invoice paid reads as complete.
--
-- Graded on production, 15 to 16 Nov 2026, on the 15 jobs Marnin checks by hand: 2 of 15 cards were
-- right. On the rest the first line and whose move named a note the records had already answered:
--  - "Invoice record: INV-1648 PAID; owing $0.00. Matter remains unresolved." (SWF-261209, SWF-261413,
--    SWF-261387): Xero says the invoice is paid, yet the note leads the card as our move, because a note
--    with money in it was never set aside;
--  - a deposit screenshot or "will pay the balance on completion" on a job long past its deposit, or
--    archived with every invoice paid (SWF-261209, SWF-261387, SWF-261397);
--  - "the crew will contact her closer to the Mon 9 Nov installation" a week after the install
--    (SWF-261372, SWF-261306): a note about a visit with no step named stayed open after the visit;
--  - "the crew will come Wed 4 Nov to finish the side panels" on a job complete since Wed 4 Nov
--    (SWF-261387): the policy said a complete job had passed the install but not completion;
--  - a contractor's bill to us (Azzi Clear's clearance certificate) as "we owe" on the customer's job,
--    and a supplier order that names another job (SWF-261387, SWF-261551): Finance's, not the job's;
--  - "SecureWorks asked Rick to leave a review" as the customer's move (SWF-261463, SWF-261577,
--    SWF-261372): nobody owes a review;
--  - a job archived by the office with every invoice paid read "Work done, what is left to invoice is
--    unconfirmed" (SWF-261397, SWF-261334).
--
-- This changes how the card reads the notes, never the notes: nothing is closed, deleted or rewritten,
-- and every note set aside is still listed under rested with its reason. What a note says is owed is
-- never set aside on the note's own say: only where Xero's own record (the invoice paid in full, every
-- invoice on the job paid) or the job's phase answers it. A person's own note, a locked note and a note
-- attached to a record item are never set aside, as before.
--
-- Undo: supabase/rollbacks/20261116060000_context_story_finished_notes_down.sql (the three functions as
-- 20261115130000 left them, word for word; the new one dropped).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE h text;
BEGIN
 SELECT md5(p.prosrc) INTO h FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_job_story_rest(jsonb,jsonb,timestamp with time zone)');
 IF h IS DISTINCT FROM '40b194570828d7cc834ab8d1a39a390a' AND position('Finished notes (20261116060000)' IN coalesce(obj_description(to_regprocedure('public.context_job_story_rest(jsonb,jsonb,timestamp with time zone)'), 'pg_proc'), '')) = 0 THEN
  RAISE EXCEPTION 'finished_notes_preimage_mismatch: context_job_story_rest %', h;
 END IF;
 SELECT md5(p.prosrc) INTO h FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_job_story_rest_policy()');
 IF h IS DISTINCT FROM '0d01289c00335ed8822d73bc103ae6b0' AND position('Finished notes (20261116060000)' IN coalesce(obj_description(to_regprocedure('public.context_job_story_rest_policy()'), 'pg_proc'), '')) = 0 THEN
  RAISE EXCEPTION 'finished_notes_preimage_mismatch: context_job_story_rest_policy %', h;
 END IF;
 SELECT md5(p.prosrc) INTO h FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_job_story(uuid,timestamp with time zone,uuid,timestamp with time zone,boolean)');
 IF h IS DISTINCT FROM '8d3084454a285899dcf477018c8f7a3d' AND position('Finished notes (20261116060000)' IN coalesce(obj_description(to_regprocedure('public.context_job_story(uuid,timestamp with time zone,uuid,timestamp with time zone,boolean)'), 'pg_proc'), '')) = 0 THEN
  RAISE EXCEPTION 'finished_notes_preimage_mismatch: context_job_story %', h;
 END IF;
 IF to_regprocedure('public.context_job_story_payment_terms(jsonb)') IS NULL THEN
  RAISE EXCEPTION 'finished_notes_payment_terms_missing';
 END IF;
END
$guard$;

-- 1. The numbers. A job whose work is done (invoice, payment, complete) has passed completion (6); it
--    was 5 (install), so a note that held up completion stayed open on a finished job. A visit note
--    with no step named is read as holding up the install.
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
                               'invoice', 6, 'payment', 6, 'complete', 6),
  -- a note that names no step but is about one of these (its about_key's first word) is read as
  -- holding up that step: arrangements for a visit hold up the install, a deposit holds up the deposit
  'about_step', jsonb_build_object('booking', 'install', 'access', 'install', 'schedule', 'install',
                                   'visit', 'install', 'delivery', 'install', 'arrival', 'install'),
  -- job statuses the office sets when it has closed a job
  'closed_statuses', jsonb_build_array('archived', 'complete', 'completed'))
$fn$;
COMMENT ON FUNCTION public.context_job_story_rest_policy() IS
 'Rested notes (20261115130000), Finished notes (20261116060000): every number the job story uses to set an AI note aside. max_age_days: the age (from the later of its opening day and its due day) past which an unconfirmed AI note is not treated as owed now. passed: for each job phase, the last step (quote 1, acceptance 2, deposit 3, booking 4, install 5, completion 6, payment 7) the job has passed; a job whose work is done (invoice, payment, complete) has passed completion. about_step: the step a note with no step of its own holds up, by its about_key''s first word (a visit''s arrangements: the install). closed_statuses: the job statuses the office sets when it has closed a job. Changed only by migration. Service role only.';

-- 1b. Whether the card's money says nothing more is coming: no known amount left to invoice (an
--     unconfirmed job value, check C2, is not a known amount) and no invoice of theirs on no job.
CREATE OR REPLACE FUNCTION public.context_job_story_money_settled(p_story jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $fn$
 SELECT (jsonb_typeof(p_story -> 'money' -> 'not_yet_invoiced') IS DISTINCT FROM 'object'
         OR coalesce((p_story -> 'money' -> 'not_yet_invoiced' ->> 'unconfirmed')::boolean, false)
         OR coalesce(nullif(p_story -> 'money' -> 'not_yet_invoiced' ->> 'amount', '')::numeric, 0) <= 0)
    AND coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(p_story -> 'money' -> 'placed_on_no_job') = 'array'
                                         THEN p_story -> 'money' -> 'placed_on_no_job' END), 0) = 0
$fn$;
COMMENT ON FUNCTION public.context_job_story_money_settled(jsonb) IS
 'Finished notes (20261116060000): true when the card''s money says nothing more is coming: money.not_yet_invoiced is absent, marked unconfirmed (a C2 check: the value is not known) or carries no amount above zero, and money.placed_on_no_job lists nothing. Pure. Service role only.';

-- 2. Which open AI notes on a card are not something anyone owes now.
CREATE OR REPLACE FUNCTION public.context_job_story_rest(p_ledger jsonb, p_story jsonb, p_as_of timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $fn$
 WITH pol AS (SELECT public.context_job_story_rest_policy() AS p),
 inv AS (
  -- the job's own customer invoices, as the card's money shows them from Xero
  SELECT lower(btrim(i ->> 'number')) AS number, upper(coalesce(i ->> 'status', '')) AS status,
         coalesce((i ->> 'owing')::numeric, 0) AS owing, i ->> 'fully_paid_on' AS paid_on, i ->> 'number' AS shown
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_story -> 'money' -> 'parties') = 'array' THEN p_story -> 'money' -> 'parties' ELSE '[]'::jsonb END) pa
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(pa -> 'invoices') = 'array' THEN pa -> 'invoices' ELSE '[]'::jsonb END) i
  WHERE nullif(btrim(i ->> 'number'), '') IS NOT NULL
 ),
 -- the job's supplier bills, as the card's money shows them from Xero
 sb AS (
  SELECT DISTINCT lower(btrim(x)) AS number
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_story -> 'money' -> 'supplier_bills') = 'array' THEN p_story -> 'money' -> 'supplier_bills' ELSE '[]'::jsonb END) b
  CROSS JOIN LATERAL (VALUES (b ->> 'number')) v(x)
  WHERE nullif(btrim(x), '') IS NOT NULL
 ),
 ph AS (
  SELECT p_story -> 'now' ->> 'phase' AS phase,
         nullif(p_story -> 'now' ->> 'phase_since', '')::date AS phase_since,
         (p_as_of AT TIME ZONE 'Australia/Perth')::date AS today,
         (pol.p -> 'passed' ->> (p_story -> 'now' ->> 'phase'))::int AS passed,
         (pol.p ->> 'max_age_days')::int AS max_age,
         pol.p -> 'about_step' AS about_step,
         -- every invoice on the job paid in Xero: at least one, nothing owing, no draft waiting
         (EXISTS (SELECT 1 FROM inv)
          AND NOT EXISTS (SELECT 1 FROM inv WHERE inv.owing <> 0 OR inv.status NOT IN ('PAID'))
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_story -> 'money' -> 'parties') = 'array' THEN p_story -> 'money' -> 'parties' ELSE '[]'::jsonb END) pa
                          WHERE coalesce((pa ->> 'drafts')::numeric, 0) <> 0 OR coalesce((pa ->> 'owing')::numeric, 0) <> 0)
          -- and nothing known left to invoice, and no invoice of theirs placed on no job
          AND public.context_job_story_money_settled(p_story)) AS all_paid,
         (pol.p -> 'closed_statuses') ? lower(coalesce(p_story -> 'job' ->> 'status', '')) AS office_closed,
         EXISTS (SELECT 1 FROM inv) AS any_invoice,
         EXISTS (SELECT 1 FROM inv WHERE inv.owing <> 0) AS any_owing
  FROM pol
 ),
 it AS (
  SELECT x ->> 'item_key' AS item_key, (x ->> 'needs_reply')::boolean AS needs_reply
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_ledger -> 'items') = 'array' THEN p_ledger -> 'items' ELSE '[]'::jsonb END) x
  WHERE coalesce(x ->> 'written_by', '') NOT LIKE 'person:%' AND NOT coalesce((x ->> 'person_locked')::boolean, false)
 ),
 lp AS (
  SELECT l.v, l.v ->> 'key' AS key, l.v ->> 'rule' AS rule, nullif(nullif(l.v ->> 'blocks', ''), 'none') AS blocks,
         nullif(l.v ->> 'since', '')::timestamptz AS since, nullif(l.v ->> 'due', '')::date AS due, it.needs_reply,
         l.v ->> 'status' AS status, lower(coalesce(l.v ->> 'about_key', '')) AS about,
         lower(coalesce(l.v ->> 'owner', '')) AS owner, lower(coalesce(l.v ->> 'counterparty', '')) AS counterparty,
         (coalesce(l.v ->> 'blocks', '') IN ('payment', 'deposit') OR coalesce(l.v ->> 'about_key', '') LIKE 'invoice:%'
          OR coalesce(l.v ->> 'about_key', '') LIKE 'payment:%' OR coalesce(l.v ->> 'about_key', '') LIKE 'refund:%'
          OR coalesce(l.v ->> 'what', '') ~ '\$ ?[0-9]') AS money,
         -- a refund, an overpayment, a credit or a double payment: never set aside by the paid rules
         (coalesce(l.v ->> 'about_key', '') ~* '^(refund|credit)' OR coalesce(l.v ->> 'what', '') ~* '(refund|overpa|over-pa|paid twice|twice|double|money back|credit|reimburs|overcharg|over-charg|pay back|paid back|charge ?back|dispute|rebate|discount|return|owed back|short ?paid|underpa)') AS refund_words
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_story -> 'loops') = 'array' THEN p_story -> 'loops' ELSE '[]'::jsonb END) l(v)
  JOIN it ON it.item_key = l.v ->> 'key'
  WHERE l.v ->> 'source' = 'ledger' AND l.v ->> 'status' IN ('open', 'closing_evidence')
 ),
 lq AS (
  SELECT lp.*,
   CASE WHEN lp.about LIKE 'invoice:%' THEN btrim(substr(lp.about, 9)) END AS about_invoice,
   coalesce(lp.blocks, ph.about_step ->> split_part(lp.about, ':', 1),
            CASE WHEN lp.about LIKE 'payment:deposit%' THEN 'deposit' END) AS step
  FROM lp, ph
 ),
 rs AS (
  SELECT lq.*, ph.phase, ph.today, pi.shown AS paid_number, pi.paid_on,
   CASE
    -- Xero says the invoice the note is about is paid in full: the record answers it (a thing the
    -- customer or another party owes on it, something said about it, or the reader's copy of the
    -- invoice record; never a thing we owe on a paid invoice, a receipt or a refund)
    WHEN pi.number IS NOT NULL AND NOT lq.refund_words
         AND (lq.owner <> 'us' OR (lq.rule = 'claim' AND lq.needs_reply IS FALSE) OR coalesce(lq.v ->> 'what', '') LIKE 'Invoice record:%') THEN 'paid'
    -- a note about the customer paying, on a job the office has closed with every invoice paid in Xero
    WHEN lq.about LIKE 'payment:%' AND lq.owner <> 'us' AND NOT lq.refund_words AND ph.all_paid AND ph.office_closed THEN 'paid'
    -- something said about money, on a job the office has closed with every invoice paid in Xero
    WHEN lq.rule = 'claim' AND lq.needs_reply IS FALSE AND lq.money AND NOT lq.refund_words AND ph.all_paid AND ph.office_closed THEN 'paid'
    -- a bill to us from a supplier or contractor (an invoice that is not one of the job's own),
    -- or a supplier's paper that names another job: Finance's to place and pay, not owed on the job
    WHEN lq.about_invoice IS NOT NULL AND EXISTS (SELECT 1 FROM sb WHERE sb.number = lq.about_invoice)
         AND NOT EXISTS (SELECT 1 FROM inv WHERE inv.number = lq.about_invoice) AND NOT lq.refund_words
         AND lq.owner = 'us' AND lq.counterparty <> 'customer' THEN 'supplier'
    WHEN lq.about LIKE 'other:other-job%' THEN 'office'
    -- we asked the customer for a review: nobody owes one
    WHEN lq.rule = 'request' AND lq.owner = 'customer' AND (lq.about LIKE 'other:review%' OR lq.about LIKE 'review:%') THEN 'courtesy'
    -- (deposit) the work is done and nothing is owing in Xero: the deposit note is answered
    WHEN lq.step = 'deposit' AND lq.owner <> 'us' AND NOT lq.refund_words
         AND ph.passed IS NOT NULL AND ph.passed >= 6 AND ph.any_invoice AND NOT ph.any_owing
         AND public.context_job_story_money_settled(p_story) THEN 'stage_passed'
    -- money is never set aside on the note's own say: what is owed is the records' to say
    WHEN lq.money THEN NULL
    WHEN lq.rule = 'claim' AND lq.needs_reply IS FALSE AND lq.blocks IS NULL THEN 'said'
    -- it held up a step (its own, or by what it is about) the job has passed since it was raised
    WHEN ph.passed IS NOT NULL AND ph.phase_since IS NOT NULL AND (lq.since AT TIME ZONE 'Australia/Perth')::date < ph.phase_since
         AND array_position(ARRAY['quote', 'acceptance', 'deposit', 'booking', 'install', 'completion', 'payment'], lq.step) <= ph.passed
         -- a fix we owe is answered by the office closing the job, not by invoicing alone
         AND (lq.owner <> 'us' OR ph.office_closed
              -- (its own step, not completion) or a dated visit that was on or before the work was done
              OR (lq.blocks IS NOT NULL AND lq.step IS DISTINCT FROM 'completion')
              OR (lq.blocks IS NULL AND lq.about ~ '^booking:[0-9]{4}-[0-9]{2}-[0-9]{2}'
                  AND substr(lq.about, 9, 10)::date <= ph.phase_since))
     THEN 'stage_passed'
    WHEN lq.status = 'open' AND lq.since IS NOT NULL
         AND greatest((lq.since AT TIME ZONE 'Australia/Perth')::date, coalesce(lq.due, (lq.since AT TIME ZONE 'Australia/Perth')::date))
             < ph.today - ph.max_age
     THEN 'old'
   END AS reason
  FROM lq
  CROSS JOIN ph
  LEFT JOIN LATERAL (SELECT inv.number, inv.shown, inv.paid_on FROM inv
                     WHERE inv.number = lq.about_invoice AND inv.status = 'PAID' AND inv.owing = 0 LIMIT 1) pi ON true
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
        WHEN 'paid' THEN CASE WHEN rs.paid_number IS NOT NULL
              THEN 'Xero shows ' || rs.paid_number || ' paid in full' || coalesce(' on ' || to_char(rs.paid_on::date, 'FMDy FMDD Mon'), '') || '. Not owed now.'
              ELSE 'The office has closed this job and Xero shows every invoice on it paid in full. Not owed now.' END
        WHEN 'supplier' THEN 'A bill to us from a supplier or contractor, not one of this job''s customer invoices: Finance places and pays it, and Job Profit counts it. Not owed on the customer''s job.'
        WHEN 'office' THEN 'A note about a supplier''s paper that names another job: for the office to sort out, not owed on this job.'
        WHEN 'courtesy' THEN 'We asked the customer for a review. Nobody owes one, so it is never the next move.'
        WHEN 'stage_passed' THEN 'It held up ' || CASE rs.step WHEN 'quote' THEN 'the quote' WHEN 'acceptance' THEN 'acceptance of the quote'
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
 'Rested notes (20261115130000), Finished notes (20261116060000): given the story''s ledger read and the card assembled from it, the open AI notes that are not something anyone owes now, and the ledger with those items'' status set to rested (so the assembler no longer opens them). Only the reader''s own notes (never a person''s or a locked one) that stand on their own on the card (source ledger). In order, the first that holds: paid (the note is about one of the job''s own invoices that Xero shows PAID with nothing owing, and is owed by someone other than us, is something said that needs no reply, or is the reader''s copy of the invoice record; or it is about a payment someone other than us owes, on a job the office closed, a status in the policy''s closed_statuses, with every invoice on the job paid, no draft, nothing known left to invoice and nothing placed on no job (context_job_story_money_settled); or it is something said about money that needs no reply on such a job); supplier (about a bill the card''s money lists as this job''s supplier bill, by number, not one of its customer invoices, owed by us to someone other than the customer); office (about a supplier''s paper that names another job, other:other-job); courtesy (we asked the customer for a review); stage_passed for a deposit note someone other than us owes on a job whose work is done with an invoice and nothing owing in Xero; a refund, overpayment, overcharge, reimbursement, credit, chargeback, dispute, discount, rebate, return or double payment in the about-key or words is never set aside by these, nor a deposit note while money is not settled; then, as before, nothing about money (blocks payment or deposit, about an invoice, a payment or a refund, or a dollar amount in its words); said (a claim marked needing no reply, blocking no step); stage_passed (it holds up a step, its own or by its about_key''s first word in the policy''s about_step, that the job''s phase has passed, and was opened before that phase began; something we owe at completion, or a visit we owe with no step of its own, only once the office has closed the job or, for a dated booking:YYYY-MM-DD, once that day is on or before the phase began); old (plainly open, opened and due more than max_age_days ago). Returns NULL when there is none, else ledger and rested (key, type, what, since, age_days, reason, why, owner, owner_name, counterparty, blocks, about_key, cites, customer_reported; newest first). Pure: reads no table. Nothing is written; the notes themselves are unchanged. Service role only.';

-- 3. A job the office closed with every invoice paid reads as complete, not as invoicing or payment.
CREATE OR REPLACE FUNCTION public.context_job_story_closed_paid(p_story jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $fn$
 WITH m AS (
  SELECT
   (public.context_job_story_rest_policy() -> 'closed_statuses') ? lower(coalesce(p_story -> 'job' ->> 'status', '')) AS closed,
   EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_story -> 'money' -> 'parties') = 'array' THEN p_story -> 'money' -> 'parties' ELSE '[]'::jsonb END) pa
           CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(pa -> 'invoices') = 'array' THEN pa -> 'invoices' ELSE '[]'::jsonb END) i) AS any_invoice,
   NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_story -> 'money' -> 'parties') = 'array' THEN p_story -> 'money' -> 'parties' ELSE '[]'::jsonb END) pa
               LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(pa -> 'invoices') = 'array' THEN pa -> 'invoices' ELSE '[]'::jsonb END) i ON true
               WHERE coalesce((pa ->> 'owing')::numeric, 0) <> 0 OR coalesce((pa ->> 'drafts')::numeric, 0) <> 0
                  OR coalesce((i ->> 'owing')::numeric, 0) <> 0 OR upper(coalesce(i ->> 'status', 'PAID')) <> 'PAID')
   AND public.context_job_story_money_settled(p_story) AS all_paid,
   coalesce(p_story -> 'now' ->> 'line', '') AS line)
 SELECT CASE
  WHEN p_story IS NULL OR coalesce(jsonb_typeof(p_story -> 'now'), '') <> 'object' THEN p_story
  WHEN NOT (m.closed AND m.any_invoice AND m.all_paid AND coalesce(p_story -> 'now' ->> 'phase', '') IN ('invoice', 'payment')) THEN p_story
  ELSE jsonb_set(p_story, '{now}', (p_story -> 'now') || jsonb_build_object(
   'phase', 'complete',
   'closed_paid', true,
   'line', CASE WHEN m.line ~ '^Work done, [^.]* since [^.]+\. '
     THEN regexp_replace(
           regexp_replace(m.line, '^Work done, [^.]* since ([^.]+)\. ', 'Work complete and paid in full: the office has closed the job and Xero shows every invoice paid (work done since \1). '),
           'What is left to invoice is unconfirmed \(check C2\)\. ', 'The job value is unconfirmed (check C2), so whether anything is left to invoice is not known. ')
     ELSE 'Work complete and paid in full: the office has closed the job and Xero shows every invoice paid. ' || m.line END))
 END
 FROM m
$fn$;
COMMENT ON FUNCTION public.context_job_story_closed_paid(jsonb) IS
 'Finished notes (20261116060000): a story whose job the office has closed (a status in context_job_story_rest_policy closed_statuses) with at least one customer invoice, every invoice PAID with nothing owing and no draft, nothing known left to invoice and nothing placed on no job (context_job_story_money_settled), and whose phase reads invoice or payment, reads phase complete (now.closed_paid true), and its first line says the work is complete and paid in full, keeping what it said about an unconfirmed job value (check C2). Anything else is returned unchanged. Pure: reads no table. Service role only.';

-- 4. The story: as 20261115130000 left it, with a closed and paid job read as complete.
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
 -- (finished notes, 20261116060000) a job the office closed with every invoice paid reads complete
 -- (context_job_story_closed_paid), and the rest rule also reads Xero's own invoice record
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
 SELECT public.context_job_story_placement_review(public.context_job_story_held_marks(public.context_job_story_closed_paid(public.context_job_story_payment_terms(st.story)), p_job_id, p_as_of) || CASE WHEN hm.held IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('held_messages', hm.held) END,p_job_id,p_generation_id,p_as_of,p_record_only)
 FROM st
 CROSS JOIN LATERAL (SELECT CASE WHEN coalesce(p_record_only, false) THEN NULL
                                 ELSE public.context_job_story_held(p_job_id, p_as_of) END AS held) hm
$function$;

DO $c$
DECLARE c text;
BEGIN
 c := coalesce(obj_description('public.context_job_story(uuid,timestamp with time zone,uuid,timestamp with time zone,boolean)'::regprocedure, 'pg_proc'), '');
 IF position('Finished notes (20261116060000)' IN c) = 0 THEN
  EXECUTE format('COMMENT ON FUNCTION public.context_job_story(uuid,timestamp with time zone,uuid,timestamp with time zone,boolean) IS %L',
   c || ' Finished notes (20261116060000): the notes the records already answer are set aside too (context_job_story_rest: an invoice Xero shows paid, paying on a closed job with every invoice paid, a supplier''s bill to us, a supplier paper naming another job, a review request, a deposit on a job past it, a visit''s arrangements after the work is done, a completion matter on a finished job), and a job the office closed with every invoice paid reads as complete (context_job_story_closed_paid).');
 END IF;
END
$c$;

-- 5. Access: service role only.
REVOKE ALL ON FUNCTION public.context_job_story_rest_policy() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_story_rest(jsonb, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_story_closed_paid(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_story_money_settled(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_story(uuid, timestamptz, uuid, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_story_rest_policy() TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_story_rest(jsonb, jsonb, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_story_closed_paid(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_story_money_settled(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_story(uuid, timestamptz, uuid, timestamptz, boolean) TO service_role;

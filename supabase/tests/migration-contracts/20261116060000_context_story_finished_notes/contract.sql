-- Finished notes contract: on a finished job the card sets aside the AI notes the records already
-- answer (an invoice Xero shows paid, the customer paying on a closed job with every invoice paid, a
-- supplier's bill to us, a supplier paper naming another job, a review request, a visit's arrangements
-- after the work, a completion matter on a finished job), keeps what we still owe and every refund,
-- and a job the office closed with every invoice paid reads complete. Fixed as-of instant: Mon 16 Nov
-- 2026 08:00 Perth. Invented words, pure functions, nothing is written.
BEGIN;
CREATE FUNCTION pg_temp.li(p_key text, p_by text DEFAULT 'luna-ledger:v2', p_reply boolean DEFAULT true) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $f$
 SELECT jsonb_build_object('item_key', p_key, 'written_by', p_by, 'needs_reply', p_reply)
$f$;
CREATE FUNCTION pg_temp.lp(p_key text, p_rule text, p_owner text, p_cp text, p_about text, p_what text, p_since text, p_blocks text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $f$
 SELECT jsonb_build_object('key', p_key, 'rule', p_rule, 'owner', p_owner, 'counterparty', p_cp, 'about_key', p_about,
  'what', p_what, 'since', p_since, 'blocks', p_blocks, 'source', 'ledger', 'status', 'open', 'cites', '[]'::jsonb)
$f$;
CREATE FUNCTION pg_temp.story(p_status text, p_owing numeric, p_left numeric DEFAULT NULL) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $f$
 SELECT jsonb_build_object(
  'job', jsonb_build_object('status', p_status),
  'now', jsonb_build_object('phase', 'invoice', 'phase_since', '2026-11-01', 'whose_move', 'us',
         'line', 'Work done, what is left to invoice is unconfirmed since Sun 1 Nov. What is left to invoice is unconfirmed (check C2). Our move, we owe: words.'),
  'money', jsonb_build_object(
   'not_yet_invoiced', CASE WHEN p_left IS NULL THEN jsonb_build_object('unconfirmed', true) ELSE jsonb_build_object('amount', p_left) END,
   'supplier_bills', jsonb_build_array(jsonb_build_object('number', 'AZ-77', 'supplier', 'A Contractor', 'status', 'AUTHORISED')),
   'parties', jsonb_build_array(jsonb_build_object('party', 'Customer A', 'owing', p_owing, 'drafts', 0,
     'invoices', jsonb_build_array(
       jsonb_build_object('number', 'INV-1', 'status', 'PAID', 'owing', 0, 'fully_paid_on', '2026-09-17'),
       jsonb_build_object('number', 'INV-3', 'status', 'PAID', 'owing', 0, 'fully_paid_on', '2026-02-31'),
       jsonb_build_object('number', 'INV-2', 'status', CASE WHEN p_owing = 0 THEN 'PAID' ELSE 'AUTHORISED' END, 'owing', p_owing))))),
  'loops', jsonb_build_array(
   pg_temp.lp('k-invrec', 'claim', 'us', 'us', 'invoice:inv-1', 'Invoice record: INV-1 PAID; owing $0.00. Matter remains unresolved.', '2026-09-20T02:00:00Z'),
   pg_temp.lp('k-receipt', 'request', 'us', 'customer', 'invoice:inv-1', 'The customer asked us to email a receipt for INV-1.', '2026-11-05T02:00:00Z'),
   pg_temp.lp('k-paybal', 'commitment', 'customer', 'us', 'payment:final', 'The customer said they would pay the balance on completion.', '2026-10-01T02:00:00Z', 'payment'),
   pg_temp.lp('k-supplier', 'request', 'us', 'third_party', 'invoice:az-77', 'A contractor invoiced SecureWorks $360 for a certificate.', '2026-11-03T02:00:00Z', 'payment'),
   pg_temp.lp('k-office', 'issue', 'us', 'unknown', 'other:other-job', 'The supplier order names another job.', '2026-10-19T02:00:00Z'),
   pg_temp.lp('k-review', 'request', 'customer', 'us', 'other:review', 'We asked the customer to leave a review.', '2026-11-10T02:00:00Z'),
   pg_temp.lp('k-visit', 'commitment', 'us', 'customer', 'booking:2026-10-12', 'The crew will call closer to the Mon 12 Oct install.', '2026-10-10T02:00:00Z'),
   pg_temp.lp('k-visitnew', 'commitment', 'us', 'customer', 'booking:2026-11-20', 'The crew will call before the Fri 20 Nov return visit.', '2026-11-01T02:00:00Z'),
   pg_temp.lp('k-moneyclaim', 'claim', 'us', 'customer', 'payment:neighbour', 'The customer said the neighbour pays him $500 of it.', '2026-11-02T02:00:00Z'),
   pg_temp.lp('k-refund', 'claim', 'us', 'customer', 'refund:overpaid', 'The customer says he paid $50 too much.', '2026-11-02T02:00:00Z'),
   pg_temp.lp('k-completion', 'issue', 'us', 'customer', 'defect:panel', 'The side panel is not finished.', '2026-10-20T02:00:00Z', 'completion'),
   pg_temp.lp('k-refundclaim', 'claim', 'us', 'customer', 'invoice:inv-1', 'The customer says he paid INV-1 twice and wants $880 back.', '2026-11-03T02:00:00Z'),
   pg_temp.lp('k-depositrefund', 'commitment', 'us', 'customer', 'refund:deposit', 'We will refund the $500 deposit.', '2026-10-01T02:00:00Z', 'deposit'),
   pg_temp.lp('k-neighbour', 'commitment', 'us', 'third_party', 'invoice:inv-2001', 'Send the neighbour his $1,450 invoice.', '2026-11-03T02:00:00Z'),
   pg_temp.lp('k-custinv', 'request', 'customer', 'us', 'invoice:az-77', 'We asked the customer to pay AZ-77.', '2026-11-03T02:00:00Z'),
   pg_temp.lp('k-overcharge', 'commitment', 'customer', 'us', 'invoice:inv-1', 'Send bank details so we can reimburse the $150 he was overcharged.', '2026-11-03T02:00:00Z'),
   pg_temp.lp('k-return', 'commitment', 'us', 'customer', 'visit:return', 'The crew will return to finish the side panels.', '2026-10-20T02:00:00Z'),
   pg_temp.lp('k-deposit', 'request', 'customer', 'us', 'payment:deposit', 'Please pay the deposit.', '2026-10-14T02:00:00Z'),
   pg_temp.lp('k-baddate', 'commitment', 'us', 'customer', 'booking:2026-11-31', 'The crew will call before the visit.', '2026-10-20T02:00:00Z'),
   pg_temp.lp('k-person', 'commitment', 'us', 'customer', 'booking:2026-10-12', 'Call the customer before the install.', '2026-10-01T02:00:00Z')))
$f$;
CREATE FUNCTION pg_temp.ledger() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $f$
 SELECT jsonb_build_object('status', 'live', 'items', jsonb_build_array(
  pg_temp.li('k-invrec'), pg_temp.li('k-receipt'), pg_temp.li('k-paybal'), pg_temp.li('k-supplier'), pg_temp.li('k-office'),
  pg_temp.li('k-review'), pg_temp.li('k-visit'), pg_temp.li('k-visitnew'), pg_temp.li('k-moneyclaim', 'luna-ledger:v2', false), pg_temp.li('k-refund'),
  pg_temp.li('k-refundclaim'), pg_temp.li('k-depositrefund'), pg_temp.li('k-neighbour'),
  pg_temp.li('k-baddate'), pg_temp.li('k-custinv'), pg_temp.li('k-overcharge'), pg_temp.li('k-return'), pg_temp.li('k-deposit'),
  pg_temp.li('k-completion'), pg_temp.li('k-person', 'person:00000000-0000-4000-8000-000000000001')))
$f$;
CREATE FUNCTION pg_temp.reasons(p_status text, p_owing numeric, p_left numeric DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE AS $f$
 SELECT coalesce(jsonb_object_agg(r ->> 'key', r ->> 'reason'), '{}'::jsonb)
 FROM jsonb_array_elements(coalesce(public.context_job_story_rest(pg_temp.ledger(), pg_temp.story(p_status, p_owing, p_left), '2026-11-16T00:00:00Z') -> 'rested', '[]'::jsonb)) r
$f$;

DO $c$
DECLARE r jsonb; s jsonb; w text;
BEGIN
 -- 1. Closed by the office, every invoice paid.
 r := pg_temp.reasons('archived', 0);
 IF r ->> 'k-invrec' IS DISTINCT FROM 'paid' THEN RAISE EXCEPTION 'finished notes contract: the reader''s copy of a paid invoice must be set aside as paid, got %', r; END IF;
 IF r ? 'k-receipt' THEN RAISE EXCEPTION 'finished notes contract: a receipt we owe on a paid invoice must stay open, got %', r; END IF;
 IF r ->> 'k-paybal' IS DISTINCT FROM 'paid' THEN RAISE EXCEPTION 'finished notes contract: the customer paying on a closed, paid job must be set aside as paid, got %', r; END IF;
 IF r ->> 'k-supplier' IS DISTINCT FROM 'supplier' THEN RAISE EXCEPTION 'finished notes contract: a contractor''s bill to us must be set aside as supplier, got %', r; END IF;
 IF r ->> 'k-office' IS DISTINCT FROM 'office' THEN RAISE EXCEPTION 'finished notes contract: a supplier paper naming another job must be set aside as office, got %', r; END IF;
 IF r ->> 'k-review' IS DISTINCT FROM 'courtesy' THEN RAISE EXCEPTION 'finished notes contract: a review request must be set aside as courtesy, got %', r; END IF;
 IF r ->> 'k-visit' IS DISTINCT FROM 'stage_passed' THEN RAISE EXCEPTION 'finished notes contract: a visit''s arrangements after the work is done must be set aside, got %', r; END IF;
 IF r ? 'k-visitnew' THEN RAISE EXCEPTION 'finished notes contract: a visit note opened after the work was done must stay open, got %', r; END IF;
 IF r ->> 'k-moneyclaim' IS DISTINCT FROM 'paid' THEN RAISE EXCEPTION 'finished notes contract: something said about money on a closed, paid job must be set aside as paid, got %', r; END IF;
 IF r ? 'k-refund' THEN RAISE EXCEPTION 'finished notes contract: a refund must never be set aside, got %', r; END IF;
 IF r ->> 'k-completion' IS DISTINCT FROM 'stage_passed' THEN RAISE EXCEPTION 'finished notes contract: a completion matter raised before the work was done must be set aside, got %', r; END IF;
 IF r ? 'k-person' THEN RAISE EXCEPTION 'finished notes contract: a person''s own note must never be set aside, got %', r; END IF;
 IF r ? 'k-refundclaim' OR r ? 'k-depositrefund' THEN RAISE EXCEPTION 'finished notes contract: a refund or double payment must never be set aside, got %', r; END IF;
 IF r ? 'k-custinv' OR r ? 'k-overcharge' THEN RAISE EXCEPTION 'finished notes contract: what the customer owes us or we owe back must stay open, got %', r; END IF;
 IF r ->> 'k-return' IS DISTINCT FROM 'stage_passed' OR NOT r ? 'k-deposit' THEN RAISE EXCEPTION 'finished notes contract: on a closed, paid job a return visit and the deposit are answered, got %', r; END IF;
 IF r ? 'k-neighbour' THEN RAISE EXCEPTION 'finished notes contract: an invoice that is not a supplier bill on the job must stay open, got %', r; END IF;
 IF (SELECT x ->> 'why' FROM jsonb_array_elements(public.context_job_story_rest(pg_temp.ledger(), pg_temp.story('archived', 0), '2026-11-16T00:00:00Z') -> 'rested') x
     WHERE x ->> 'key' = 'k-invrec') IS DISTINCT FROM 'Xero shows INV-1 paid in full on Thu 17 Sep. Not owed now.' THEN
  RAISE EXCEPTION 'finished notes contract: a paid invoice note must say which invoice Xero shows paid and when';
 END IF;

 -- 2. Still owing and open: only what Xero itself answers is set aside; the customer still owes.
 r := pg_temp.reasons('invoiced', 100);
 IF r ->> 'k-invrec' IS DISTINCT FROM 'paid' THEN RAISE EXCEPTION 'finished notes contract: a paid invoice is paid on an open job too, got %', r; END IF;
 IF r ? 'k-paybal' OR r ? 'k-moneyclaim' THEN RAISE EXCEPTION 'finished notes contract: on a job still owing, paying and money said must stay open, got %', r; END IF;
 IF r ? 'k-completion' OR r ? 'k-return' OR r ? 'k-baddate' THEN RAISE EXCEPTION 'finished notes contract: a fix or a visit we owe stays open until the office closes the job, got %', r; END IF;
 IF r ->> 'k-visit' IS DISTINCT FROM 'stage_passed' THEN RAISE EXCEPTION 'finished notes contract: a dated visit before the work was done is answered, got %', r; END IF;

 -- 3. Closed by the office but something still owing: the customer still owes.
 r := pg_temp.reasons('archived', 100);
 IF r ? 'k-paybal' THEN RAISE EXCEPTION 'finished notes contract: an archived job still owing keeps the payment note open, got %', r; END IF;
 -- Closed and paid, but a known amount is left to invoice: more is coming.
 r := pg_temp.reasons('archived', 0, 5000);
 IF r ? 'k-paybal' OR r ? 'k-moneyclaim' OR r ? 'k-deposit' THEN RAISE EXCEPTION 'finished notes contract: with an amount left to invoice, paying must stay open, got %', r; END IF;
 IF public.context_job_story_closed_paid(pg_temp.story('archived', 0, 5000)) IS DISTINCT FROM pg_temp.story('archived', 0, 5000) THEN
  RAISE EXCEPTION 'finished notes contract: a job with an amount left to invoice is not paid in full';
 END IF;

 -- 4. A job the office closed with every invoice paid reads complete; anything else is unchanged.
 s := public.context_job_story_closed_paid(pg_temp.story('archived', 0));
 IF s -> 'now' ->> 'phase' IS DISTINCT FROM 'complete' OR (s -> 'now' ->> 'closed_paid')::boolean IS NOT TRUE THEN
  RAISE EXCEPTION 'finished notes contract: a closed, paid job must read complete, got %', s -> 'now';
 END IF;
 IF s -> 'now' ->> 'line' IS DISTINCT FROM 'Work complete and paid in full: the office has closed the job and Xero shows every invoice paid (work done since Sun 1 Nov). The job value is unconfirmed (check C2), so whether anything is left to invoice is not known. Our move, we owe: words.' THEN
  RAISE EXCEPTION 'finished notes contract: the closed, paid line is wrong: %', s -> 'now' ->> 'line';
 END IF;
 IF public.context_job_story_closed_paid(pg_temp.story('archived', 100)) IS DISTINCT FROM pg_temp.story('archived', 100)
    OR public.context_job_story_closed_paid(pg_temp.story('invoiced', 0)) IS DISTINCT FROM pg_temp.story('invoiced', 0)
    OR public.context_job_story_closed_paid(jsonb_set(pg_temp.story('archived', 0), '{now,phase}', '"install"')) IS DISTINCT FROM jsonb_set(pg_temp.story('archived', 0), '{now,phase}', '"install"')
    OR public.context_job_story_closed_paid(jsonb_set(pg_temp.story('archived', 0), '{money,parties}', '[]')) IS DISTINCT FROM jsonb_set(pg_temp.story('archived', 0), '{money,parties}', '[]')
    OR public.context_job_story_closed_paid(NULL) IS NOT NULL
    OR public.context_job_story_closed_paid(pg_temp.story('archived', 0) - 'now') IS DISTINCT FROM pg_temp.story('archived', 0) - 'now'
    OR public.context_job_story_closed_paid(pg_temp.story('archived', 0) #- '{now,phase}') IS DISTINCT FROM pg_temp.story('archived', 0) #- '{now,phase}' THEN
  RAISE EXCEPTION 'finished notes contract: a job not closed, still owing, with no invoice or not at invoicing must be unchanged';
 END IF;

 -- 5. The story read uses it, and the policy says a finished job has passed completion.
 SELECT prosrc INTO w FROM pg_proc WHERE oid = 'public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)'::regprocedure;
 IF position('public.context_job_story_closed_paid(public.context_job_story_payment_terms(st.story))' IN w) = 0 THEN
  RAISE EXCEPTION 'finished notes contract: the story read must read a closed, paid job as complete';
 END IF;
 IF (public.context_job_story_rest_policy() -> 'passed' ->> 'complete')::int IS DISTINCT FROM 6 THEN
  RAISE EXCEPTION 'finished notes contract: a complete job has passed completion';
 END IF;

 -- 6. Service role only.
 IF has_function_privilege('anon', 'public.context_job_story_closed_paid(jsonb)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.context_job_story_rest(jsonb,jsonb,timestamptz)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.context_job_story_closed_paid(jsonb)', 'EXECUTE') THEN
  RAISE EXCEPTION 'finished notes contract: service role only';
 END IF;
END
$c$;
ROLLBACK;

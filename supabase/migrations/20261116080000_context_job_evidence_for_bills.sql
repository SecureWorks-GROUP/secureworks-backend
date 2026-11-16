-- Job evidence for bills (20261116080000), policy job-evidence-v1.
--
-- One shared read that says, for each supplier bill (Xero ACCPAY), which jobs the job context
-- points to and why. The costing thread's Bills to place and the job story read the same answer.
--
-- It names a job only on strong evidence:
--   job_number          our job number in the bill's own words (reference and line descriptions)
--   purchase_order      one of our purchase order numbers in the bill's words
--   dispatch_order_ref  a supplier order reference Dispatch linked to a job, in the bill's words
--   site_address        a job's site address in the bill's words (never one written after
--                       "Bill to" or "Billing address"), with the job's suburb named too or the
--                       address held by one job only
--   supplier_mail       the supplier's own mail carrying this bill's number, already placed on the job
-- A job is named only when it has more strong lanes than any other job. Weak evidence (orders to
-- that supplier, the supplier listed on a job's materials, the supplier's mail on a job without
-- this bill's number) is listed for the person who approves and never picks or breaks a tie.
--
-- It never reads the answer: not the bill's own job field, tracking or project, not any AI or
-- bookkeeping placement, not Job Profit. A holding job (metadata.do_not_schedule true) is never a
-- candidate. A draft, voided or deleted bill is never named. p_blind leaves out every lane that
-- reads the bill's own words (for measurement); the mail lane still reads the bill's number.
--
-- Mail guards: a mail whose subject or body reads as a statement, remittance or payment advice is no
-- evidence; an attachment that does is no evidence. When any part of a mail carries another of the
-- supplier's bills (or another bill being checked in the same call), that part, the mail body and
-- the mail's own placement are no evidence, but another attachment carrying this bill alone still
-- counts on the attachment's own placement. This bill's own number is blanked out before looking
-- for other bills, so its own suffix never trips the guard. Bill numbers with fewer than five
-- significant digits (leading zeros never count) are too short to look for and are reported.
--
-- Nothing is written. Every number is in context_job_evidence_policy().

DO $guard$
BEGIN
 IF to_regprocedure('public.context_address_mentions(text)') IS NULL
    OR to_regprocedure('public.context_address_key(text)') IS NULL
    OR to_regprocedure('public.context_job_ref_tokens(text)') IS NULL
    OR to_regprocedure('public.context_ref_jobs(text[])') IS NULL
    OR to_regprocedure('public.context_email_key(text)') IS NULL THEN
  RAISE EXCEPTION 'job_evidence_prerequisites_missing: the placement keys (20260924183000) must be live';
 END IF;
 IF to_regprocedure('public.context_job_evidence_for_bills(text[],boolean)') IS NOT NULL
    AND coalesce(obj_description(to_regprocedure('public.context_job_evidence_for_bills(text[],boolean)'), 'pg_proc'), '')
        NOT LIKE 'Job evidence for bills (20261116080000)%' THEN
  RAISE EXCEPTION 'job_evidence_preimage_mismatch: public.context_job_evidence_for_bills exists and is not this migration''s';
 END IF;
END
$guard$;

-- 1. The numbers.
CREATE OR REPLACE FUNCTION public.context_job_evidence_policy()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
 SELECT jsonb_build_object(
  'version', 'job-evidence-v1',
  'min_number_digits', 5,
  'mail_days_before', 60,
  'mail_days_after', 90,
  'order_days_before', 120,
  'order_days_after', 30,
  'sibling_bill_days', 365,
  'skip_statuses', jsonb_build_array('DRAFT', 'VOIDED', 'DELETED'),
  'free_mail_domains', jsonb_build_array(
    'gmail.com', 'googlemail.com', 'outlook.com', 'outlook.com.au', 'hotmail.com', 'hotmail.com.au',
    'live.com', 'live.com.au', 'yahoo.com', 'yahoo.com.au', 'icloud.com', 'me.com', 'bigpond.com',
    'bigpond.net.au', 'iinet.net.au', 'westnet.com.au', 'optusnet.com.au', 'tpg.com.au'),
  'strong_lanes', jsonb_build_array('job_number', 'purchase_order', 'dispatch_order_ref', 'site_address', 'supplier_mail'),
  'weak_lanes', jsonb_build_array('order_to_supplier', 'supplier_on_job_materials', 'supplier_mail_without_number')
 );
$$;

-- 2. A bill number as a key: the longest digit run (a lone year is not the number), leading zeros
-- dropped, and a short suffix kept (12345-2). Null when the number has fewer significant digits
-- than the policy's minimum. A key without a suffix is found in any digit run equal to it; a key
-- with one only where the same suffix follows.
CREATE OR REPLACE FUNCTION public.context_job_evidence_number_key(p_number text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
 WITH runs AS (
  SELECT r.m[1] AS run, r.ord
  FROM regexp_matches(coalesce(p_number, ''), '([0-9]+)', 'g') WITH ORDINALITY AS r(m, ord)
 ), keep AS (
  SELECT run, ord FROM runs
  WHERE NOT (run ~ '^(19|20)[0-9]{2}$' AND (SELECT count(*) FROM runs) > 1)
 ), core AS (
  SELECT run, ord FROM keep ORDER BY length(ltrim(run, '0')) DESC, ord LIMIT 1
 )
 SELECT CASE
   WHEN length(ltrim(c.run, '0')) < (public.context_job_evidence_policy()->>'min_number_digits')::int THEN NULL
   ELSE ltrim(c.run, '0')
        || coalesce('-' || (regexp_match(p_number, c.run || '[-/]([0-9]{1,3})[[:space:]]*$'))[1], '')
  END
 FROM core c;
$$;

-- 2b. Every number written in a text, as (core, full_key): leading zeros dropped, a short suffix kept.
CREATE OR REPLACE FUNCTION public.context_job_evidence_text_numbers(p_text text)
RETURNS TABLE(core text, full_key text)
LANGUAGE sql
IMMUTABLE
AS $$
 SELECT DISTINCT ltrim(t[1], '0'),
        ltrim(t[1], '0') || coalesce('-' || t[2], '')
 FROM regexp_matches(coalesce(p_text, ''), '([0-9]+)(?:[-/]([0-9]{1,3})(?![0-9]))?', 'g') AS t
 WHERE length(ltrim(t[1], '0')) >= (public.context_job_evidence_policy()->>'min_number_digits')::int;
$$;

-- 3. Statement, remittance and payment-advice words, across line breaks.
CREATE OR REPLACE FUNCTION public.context_job_evidence_is_statement(p_text text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
 SELECT coalesce(p_text, '') ~* '(\mstatement\M|\mremittance\M|payment[[:space:]]+advice|account[[:space:]]+summary|aged[[:space:]]+(balance|debtors|receivables)|\mactivity[[:space:]]+statement)';
$$;

-- 4. The read.
CREATE OR REPLACE FUNCTION public.context_job_evidence_for_bills(p_bill_ids text[], p_blind boolean DEFAULT false)
RETURNS TABLE(
 xero_invoice_id text,
 invoice_number text,
 decision text,
 job_id uuid,
 job_number text,
 reason text,
 strong jsonb,
 weak jsonb,
 notes jsonb,
 policy text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
WITH pol AS (
 SELECT public.context_job_evidence_policy() AS p
), asked AS (
 SELECT DISTINCT unnest(p_bill_ids) AS id
), b AS (
 SELECT x.xero_invoice_id AS id, x.invoice_number, upper(coalesce(x.status, '')) AS status,
        x.xero_contact_id, lower(btrim(coalesce(x.contact_name, ''))) AS contact,
        coalesce(x.invoice_date, x.created_at::date) AS bill_date,
        public.context_job_evidence_number_key(x.invoice_number) AS nkey,
        coalesce(x.reference, '') || E'\n' || coalesce((
          SELECT string_agg(coalesce(li->>'Description', ''), E'\n' ORDER BY o)
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(x.line_items) = 'array' THEN x.line_items ELSE '[]'::jsonb END)
               WITH ORDINALITY AS l(li, o)), '') AS words
 FROM public.xero_invoices x
 JOIN asked a ON a.id = x.xero_invoice_id
 WHERE x.invoice_type = 'ACCPAY'
), live AS (
 -- Every job but a holding job.
 SELECT j.id, j.job_number, j.site_address, j.site_suburb
 FROM public.jobs j
 WHERE lower(coalesce(j.metadata->>'do_not_schedule', '')) <> 'true'
), sup AS (
 SELECT DISTINCT b.id AS bill, s.id AS supplier_id, s.email
 FROM b JOIN public.suppliers s
   ON (b.xero_contact_id IS NOT NULL AND s.xero_contact_id = b.xero_contact_id)
   OR (b.contact <> '' AND lower(btrim(s.name)) = b.contact)
), sup_mail AS (
 SELECT DISTINCT sup.bill, public.context_email_key(e) AS key, lower(split_part(btrim(e), '@', 2)) AS domain
 FROM sup CROSS JOIN LATERAL regexp_split_to_table(coalesce(sup.email, ''), '[;,[:space:]]+') AS e
 WHERE e LIKE '%@%'
), sib_num AS (
 -- The supplier's other bills, and the other bills asked about in this call.
 SELECT DISTINCT b.id AS bill, o.invoice_number
 FROM b CROSS JOIN pol
 JOIN public.xero_invoices o
   ON o.invoice_type = 'ACCPAY' AND o.xero_invoice_id <> b.id
  AND ((b.xero_contact_id IS NOT NULL AND o.xero_contact_id = b.xero_contact_id)
       OR (b.contact <> '' AND lower(btrim(coalesce(o.contact_name, ''))) = b.contact))
  AND coalesce(o.invoice_date, o.created_at::date)
      BETWEEN b.bill_date - (pol.p->>'sibling_bill_days')::int AND b.bill_date + (pol.p->>'sibling_bill_days')::int
 UNION
 SELECT b.id, b2.invoice_number FROM b JOIN b b2 ON b2.id <> b.id
), sib_key AS (
 SELECT DISTINCT k.bill, k.nkey, split_part(k.nkey, '-', 1) AS core
 FROM (SELECT n.bill, public.context_job_evidence_number_key(n.invoice_number) AS nkey FROM sib_num n) k
 JOIN b ON b.id = k.bill
 WHERE k.nkey IS NOT NULL AND k.nkey IS DISTINCT FROM b.nkey
),
-- Strong lanes that read the bill's own words.
s_job AS (
 SELECT DISTINCT b.id AS bill, r.job_id, 'job_number'::text AS lane, r.token AS detail
 FROM b CROSS JOIN LATERAL public.context_ref_jobs(public.context_job_ref_tokens(b.words)) r
 JOIN live l ON l.id = r.job_id
 -- A purchase order number is the purchase order lane's alone, so one number never counts twice.
 WHERE NOT p_blind AND r.ref_kind <> 'purchase_order'
), s_po AS (
 SELECT DISTINCT b.id, po.job_id, 'purchase_order', po.po_number
 FROM b JOIN public.purchase_orders po ON po.job_id IS NOT NULL
  AND length(regexp_replace(coalesce(po.po_number, ''), '[^0-9A-Za-z]', '', 'g')) >= 6
  AND b.words ~* ('(^|[^0-9A-Za-z])' || regexp_replace(po.po_number, '([^0-9A-Za-z ])', '\\\1', 'g') || '($|[^0-9A-Za-z])')
 JOIN live l ON l.id = po.job_id
 WHERE NOT p_blind
), s_ref AS (
 SELECT DISTINCT b.id, r.job_id, 'dispatch_order_ref', r.ref
 FROM b JOIN public.dispatch_v2_supplier_order_refs r ON r.job_id IS NOT NULL
  AND EXISTS (
   SELECT 1 FROM public.context_job_evidence_text_numbers(b.words) t
   WHERE public.context_job_evidence_number_key(r.ref) IS NOT NULL
     AND t.core = split_part(public.context_job_evidence_number_key(r.ref), '-', 1)
     AND (position('-' IN public.context_job_evidence_number_key(r.ref)) = 0
          OR t.full_key = public.context_job_evidence_number_key(r.ref)))
 JOIN live l ON l.id = r.job_id
 WHERE NOT p_blind
), clean AS (
 -- The bill's words without whatever follows "Bill to" or "Billing address" on that line.
 SELECT b.id, regexp_replace(b.words, '(bill(ing)?[[:space:]]*(to|address)|invoice[[:space:]]+to)[^\n]{0,200}', ' ', 'gi') AS words
 FROM b
 WHERE NOT p_blind
), mention AS (
 SELECT DISTINCT c.id AS bill, c.words, m.address_key
 FROM clean c CROSS JOIN LATERAL public.context_address_mentions(c.words) m
 WHERE m.typed AND m.address_key IS NOT NULL
), job_keys AS MATERIALIZED (
 SELECT l.id, l.site_suburb, public.context_address_key(l.site_address) AS address_key
 FROM live l
 WHERE l.site_address IS NOT NULL AND EXISTS (SELECT 1 FROM mention)
), site_jobs AS (
 SELECT mention.bill, mention.words, mention.address_key, jk.id AS job_id, jk.site_suburb
 FROM mention JOIN job_keys jk ON jk.address_key = mention.address_key
), s_site AS (
 SELECT DISTINCT sj.bill, sj.job_id, 'site_address', sj.address_key
 FROM site_jobs sj
 WHERE (nullif(btrim(sj.site_suburb), '') IS NOT NULL
        AND sj.words ~* ('(^|[^A-Za-z])' || regexp_replace(btrim(sj.site_suburb), '([^0-9A-Za-z ])', '\\\1', 'g') || '($|[^A-Za-z])'))
    OR (SELECT count(DISTINCT sj2.job_id) FROM site_jobs sj2 WHERE sj2.bill = sj.bill AND sj2.address_key = sj.address_key) = 1
),
-- The supplier's mail.
inbox AS MATERIALIZED (
 SELECT e.id, e.job_id, e.occurred_at,
        public.context_email_key(coalesce(e.payload->>'email', e.payload->>'from')) AS key,
        lower(split_part(coalesce(e.payload->>'email', e.payload->>'from', ''), '@', 2)) AS domain,
        coalesce(e.payload->>'subject', '') || E'\n' || coalesce(e.payload->>'body', e.payload->>'body_preview', '') AS body
 FROM public.business_events e CROSS JOIN pol
 WHERE e.channel = 'email' AND e.event_type LIKE '%.email_in'
   AND e.occurred_at >= ((SELECT min(bill_date) FROM b) - (pol.p->>'mail_days_before')::int)::timestamptz
   AND e.occurred_at <  ((SELECT max(bill_date) FROM b) + (pol.p->>'mail_days_after')::int + 1)::timestamptz
), mail AS (
 SELECT DISTINCT b.id AS bill, b.nkey, i.id AS mail_id, i.job_id AS mail_job, i.body
 FROM b CROSS JOIN pol
 JOIN sup_mail sm ON sm.bill = b.id
 JOIN inbox i
   ON (i.key = sm.key
       OR (sm.domain <> '' AND NOT (pol.p->'free_mail_domains') ? sm.domain AND i.domain = sm.domain))
  AND i.occurred_at >= (b.bill_date - (pol.p->>'mail_days_before')::int)::timestamptz
  AND i.occurred_at <  (b.bill_date + (pol.p->>'mail_days_after')::int + 1)::timestamptz
), part AS (
 SELECT m.bill, m.nkey, m.mail_id, m.mail_job, 'body'::text AS kind, m.mail_id::text AS part_id, m.mail_job AS part_job, m.body AS words
 FROM mail m
 UNION ALL
 SELECT m.bill, m.nkey, m.mail_id, m.mail_job, 'attachment', d.id::text, d.job_id, coalesce(d.payload->>'text', '')
 FROM mail m
 JOIN public.context_email_attachments a ON a.business_event_id = m.mail_id
 JOIN public.context_document_texts dt ON dt.source_kind = 'email_attachment' AND dt.source_id = a.id AND dt.event_id IS NOT NULL
 JOIN public.business_events d ON d.id = dt.event_id
), part_num AS (
 -- Each part's numbers once, with this bill's own number taken out (its suffix included).
 SELECT p.bill, p.part_id, t.core, t.full_key,
        (p.nkey IS NOT NULL AND t.core = split_part(p.nkey, '-', 1)
         AND (position('-' IN p.nkey) = 0 OR t.full_key = p.nkey)) AS is_own
 FROM (SELECT DISTINCT bill, nkey, part_id, words FROM part) p
 CROSS JOIN LATERAL public.context_job_evidence_text_numbers(p.words) t
), part_read AS (
 SELECT p.*,
        EXISTS (SELECT 1 FROM part_num n WHERE n.bill = p.bill AND n.part_id = p.part_id AND n.is_own) AS own,
        public.context_job_evidence_is_statement(p.words) AS statement,
        EXISTS (
         SELECT 1 FROM part_num n JOIN sib_key k ON k.bill = n.bill AND k.core = n.core
         WHERE n.bill = p.bill AND n.part_id = p.part_id AND NOT n.is_own
           AND (k.nkey = k.core OR k.nkey = n.full_key)
        ) AS other
 FROM part p
), mail_read AS (
 SELECT bill, mail_id,
        bool_or(kind = 'body' AND statement) AS body_statement,
        bool_or(other) AS any_other
 FROM part_read GROUP BY bill, mail_id
), s_mail AS (
 SELECT DISTINCT pr.bill, pr.part_job AS job_id, 'supplier_mail', pr.mail_id::text
 FROM part_read pr JOIN mail_read mr ON mr.bill = pr.bill AND mr.mail_id = pr.mail_id
 JOIN live l ON l.id = pr.part_job
 WHERE pr.own AND NOT pr.other AND NOT pr.statement AND NOT mr.body_statement
   AND (pr.kind = 'attachment' OR NOT mr.any_other)
),
-- Weak lanes, listed only.
w_mail AS (
 SELECT DISTINCT m.bill, m.mail_job AS job_id, 'supplier_mail_without_number'::text AS lane, m.mail_id::text AS detail
 FROM mail m JOIN live l ON l.id = m.mail_job
), w_order AS (
 SELECT DISTINCT b.id, po.job_id, 'order_to_supplier', po.po_number
 FROM b CROSS JOIN pol
 JOIN public.purchase_orders po ON po.job_id IS NOT NULL
  AND ((po.supplier_id IS NOT NULL AND po.supplier_id IN (SELECT sup.supplier_id FROM sup WHERE sup.bill = b.id))
       OR (b.xero_contact_id IS NOT NULL AND po.xero_contact_id = b.xero_contact_id)
       OR (b.contact <> '' AND lower(btrim(coalesce(po.supplier_name, ''))) = b.contact))
  AND po.created_at >= (b.bill_date - (pol.p->>'order_days_before')::int)::timestamptz
  AND po.created_at <  (b.bill_date + (pol.p->>'order_days_after')::int + 1)::timestamptz
 JOIN live l ON l.id = po.job_id
), w_mat AS (
 SELECT DISTINCT b.id, ms.job_id, 'supplier_on_job_materials', ms.supplier_name
 FROM b JOIN public.job_material_suppliers ms ON ms.job_id IS NOT NULL
  AND ((ms.supplier_id IS NOT NULL AND ms.supplier_id IN (SELECT sup.supplier_id FROM sup WHERE sup.bill = b.id))
       OR (b.contact <> '' AND lower(btrim(coalesce(ms.supplier_name, ''))) = b.contact))
 JOIN live l ON l.id = ms.job_id
), ev AS (
 SELECT bill, job_id, lane, detail, true AS strong FROM (
  SELECT * FROM s_job UNION ALL SELECT * FROM s_po UNION ALL SELECT * FROM s_ref
  UNION ALL SELECT * FROM s_site UNION ALL SELECT * FROM s_mail) s
 UNION ALL
 SELECT bill, job_id, lane, detail, false FROM (
  SELECT * FROM w_mail UNION ALL SELECT * FROM w_order UNION ALL SELECT * FROM w_mat) w
), per_job AS (
 SELECT ev.bill, ev.job_id, count(DISTINCT ev.lane) FILTER (WHERE ev.strong) AS n_strong,
        jsonb_agg(DISTINCT jsonb_build_object('lane', ev.lane, 'detail', ev.detail)) FILTER (WHERE ev.strong) AS strong,
        jsonb_agg(DISTINCT jsonb_build_object('lane', ev.lane, 'detail', ev.detail)) FILTER (WHERE NOT ev.strong) AS weak
 FROM ev GROUP BY ev.bill, ev.job_id
), ranked AS (
 SELECT pj.*,
        max(pj.n_strong) OVER (PARTITION BY pj.bill) AS top,
        count(*) FILTER (WHERE pj.n_strong > 0) OVER (PARTITION BY pj.bill, pj.n_strong) AS at_level
 FROM per_job pj
), winner AS (
 SELECT r.bill, r.job_id FROM ranked r WHERE r.n_strong > 0 AND r.n_strong = r.top AND r.at_level = 1
), listing AS (
 SELECT r.bill,
        jsonb_agg(jsonb_build_object('job_id', r.job_id, 'job_number', j.job_number, 'lanes', r.strong)
                  ORDER BY r.n_strong DESC, j.job_number COLLATE "C") FILTER (WHERE r.n_strong > 0) AS strong,
        jsonb_agg(jsonb_build_object('job_id', r.job_id, 'job_number', j.job_number, 'lanes', r.weak)
                  ORDER BY j.job_number COLLATE "C") FILTER (WHERE r.weak IS NOT NULL) AS weak,
        bool_or(r.n_strong > 0) AS any_strong
 FROM ranked r JOIN public.jobs j ON j.id = r.job_id
 GROUP BY r.bill
)
SELECT a.id,
       b.invoice_number,
       CASE WHEN b.id IS NULL THEN 'not_found'
            WHEN (SELECT p FROM pol)->'skip_statuses' ? b.status THEN 'not_named'
            WHEN w.job_id IS NOT NULL THEN 'named'
            ELSE 'not_named' END,
       CASE WHEN b.id IS NOT NULL AND NOT ((SELECT p FROM pol)->'skip_statuses' ? b.status) THEN w.job_id END,
       CASE WHEN b.id IS NOT NULL AND NOT ((SELECT p FROM pol)->'skip_statuses' ? b.status) THEN j.job_number END,
       CASE WHEN b.id IS NULL THEN 'not_a_supplier_bill'
            WHEN (SELECT p FROM pol)->'skip_statuses' ? b.status THEN 'bill_' || lower(b.status)
            WHEN w.job_id IS NOT NULL THEN 'most_strong_evidence'
            WHEN coalesce(li.any_strong, false) THEN 'strong_evidence_tied'
            ELSE 'no_strong_evidence' END,
       coalesce(li.strong, '[]'::jsonb),
       coalesce(li.weak, '[]'::jsonb),
       CASE WHEN b.id IS NULL THEN '[]'::jsonb ELSE
        to_jsonb(array_remove(ARRAY[
         CASE WHEN b.nkey IS NULL THEN 'bill_number_too_short' END,
         CASE WHEN NOT EXISTS (SELECT 1 FROM sup_mail sm WHERE sm.bill = b.id) THEN 'no_supplier_email' END,
         CASE WHEN p_blind THEN 'blind' END
        ], NULL)) END,
       (SELECT p->>'version' FROM pol)
FROM asked a
LEFT JOIN b ON b.id = a.id
LEFT JOIN winner w ON w.bill = b.id
LEFT JOIN public.jobs j ON j.id = w.job_id
LEFT JOIN listing li ON li.bill = b.id
ORDER BY a.id COLLATE "C";
$fn$;

COMMENT ON FUNCTION public.context_job_evidence_for_bills(text[], boolean) IS
 'Job evidence for bills (20261116080000): for each supplier bill, the jobs the job context points to and why. Names a job only on strong evidence; weak evidence is listed for the person who approves. Never reads the answer. Policy: context_job_evidence_policy().';

REVOKE ALL ON FUNCTION public.context_job_evidence_policy() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_evidence_number_key(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_evidence_text_numbers(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_evidence_is_statement(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_evidence_for_bills(text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_evidence_policy() TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_evidence_number_key(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_evidence_text_numbers(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_evidence_is_statement(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_evidence_for_bills(text[], boolean) TO service_role;

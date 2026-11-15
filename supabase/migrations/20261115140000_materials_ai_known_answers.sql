-- Known answers for the AI bill reader: how often it picks the job the bookkeeper picked.
--
-- The AI bill reader (20261028173000, gated by two keys from 20261029093000) says which job a supplier bill
-- belongs to. Nothing measured whether it was right. The bookkeeper's own allocation of the same bills, loaded
-- line by line into v_bookkeeping_line_evidence_current, is an answer key that already exists. This adds two
-- read-only views that compare the two on every read. Nothing is stored, nothing is placed or moved, and no
-- existing object changes.
--
--   v_materials_ai_known_answers           one row per bill the AI has decided: its latest decision, the
--                                          bookkeeper's answer for the same bill, and the verdict.
--   v_materials_ai_accuracy_by_supplier    the verdicts counted per supplier and per rule.
--
-- The bookkeeper's answer for a bill (bookkeeper_answer):
--   job            every line of the bill is evidenced and allocated to the same one job;
--   not_job_cost   every line is evidenced and allocated as overhead or not a job cost;
--   split          every line is evidenced, but the lines name more than one job or mix job and overhead;
--   not_evidenced  some line is not evidenced, or a job line names no job;
--   (null)         the bookkeeper's load has no line for the bill.
-- Only job and not_job_cost are answers the AI can be checked against. A split bill is not one job, and the AI
-- answers one job per bill, so it is left out rather than counted against either side.
--
-- verdict:
--   agree                 the AI's job is the bookkeeper's job, or both say not a job cost;
--   wrong_job             the AI named a job and the bookkeeper named a different one. The costly mistake;
--   job_but_not_job_cost  the AI named a job and the bookkeeper allocated the bill as overhead;
--   missed_job_cost       the AI said not job related and the bookkeeper named a job;
--   declined              the AI said unsure. Not wrong, and not help either;
--   no_answer             the bookkeeper has no checkable answer for this bill (null, split or not_evidenced).
-- The AI's latest decision is the latest row for the bill in materials_ai_placements, undone or not: an undone
-- placement is still what the AI said (undone says a person took it back).
--
-- rule says which gate the decision went through: two_keys (agreed_keys recorded, from 29 Oct 2026: the AI's
-- confidence alone never places a bill, a hard clue such as the job number on the bill must agree) or
-- before_two_keys (confidence alone placed it).
--
-- multi_bill_email is true when the bill's invoice number is on an email that also carries another bill of the
-- same supplier (the digit run of the invoice number, four digits or more, read from the attachment file names
-- in context_email_attachments). The email's subject then names at most one of those jobs, so it is no evidence
-- of which job a given bill belongs to. Measured 15 Nov 2026: one drawings supplier emails several invoices
-- for several patio jobs together, and the AI placed 8 of them from such an email onto a job the bookkeeper did
-- not choose.
--
-- Neither side is taken as right by this read: a disagreement is a bill for a person to look at. Job Profit
-- already counts the bookkeeper's ledger over an AI placement (20261103050000), so a wrong_job does not change a
-- job's cost there; it does say how far the AI can be trusted where no ledger answer exists yet.
--
-- Service role only, like the tables it reads. Read only.
-- Rollback: supabase/rollbacks/20261115140000_materials_ai_known_answers_down.sql (drops both views).

SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF to_regclass('public.materials_ai_placements') IS NULL OR to_regclass('public.v_bookkeeping_line_evidence_current') IS NULL
     OR to_regclass('public.context_email_attachments') IS NULL OR to_regclass('public.xero_invoices') IS NULL THEN
    RAISE EXCEPTION 'materials ai known answers: materials_ai_placements, v_bookkeeping_line_evidence_current, context_email_attachments or xero_invoices is missing';
  END IF;
  IF (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = 'public.materials_ai_placements'::regclass AND NOT a.attisdropped
        AND a.attname IN ('xero_invoice_id', 'invoice_number', 'contact_name', 'amount_ex', 'decision', 'job_id', 'job_number',
                          'confidence', 'outcome', 'agreed_keys', 'created_at', 'undone_at', 'model')) <> 13
     OR (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = 'public.v_bookkeeping_line_evidence_current'::regclass
           AND NOT a.attisdropped AND a.attname IN ('xero_invoice_id', 'allocation', 'job_id', 'job_number', 'evidenced')) <> 5
     OR (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = 'public.context_email_attachments'::regclass
           AND NOT a.attisdropped AND a.attname IN ('business_event_id', 'file_name')) <> 2
     OR (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = 'public.xero_invoices'::regclass
           AND NOT a.attisdropped AND a.attname IN ('xero_invoice_id', 'xero_contact_id', 'invoice_number', 'invoice_type')) <> 4 THEN
    RAISE EXCEPTION 'materials ai known answers: a column the read needs is missing';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.materials_ai_placements', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.v_bookkeeping_line_evidence_current', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.context_email_attachments', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.xero_invoices', 'SELECT') THEN
    RAISE EXCEPTION 'materials ai known answers: the service role cannot read a table the views read';
  END IF;
END
$guard$;

CREATE OR REPLACE VIEW public.v_materials_ai_known_answers WITH (security_invoker = true) AS
WITH latest AS (
  SELECT DISTINCT ON (p.xero_invoice_id) p.*
    FROM public.materials_ai_placements p
   ORDER BY p.xero_invoice_id, p.created_at DESC, p.id DESC
), bk AS (
  SELECT e.xero_invoice_id,
         bool_and(COALESCE(e.evidenced, false)) AS all_evidenced,
         bool_and(e.allocation = 'job') AS all_job,
         bool_and(e.allocation IN ('overhead', 'not_job_cost')) AS all_not_job,
         count(DISTINCT e.job_id) AS jobs,
         count(*) FILTER (WHERE e.allocation = 'job' AND e.job_id IS NULL) AS job_lines_without_job,
         min(e.job_id::text)::uuid AS job_id,
         min(e.job_number) AS job_number
    FROM public.v_bookkeeping_line_evidence_current e
   WHERE e.xero_invoice_id IS NOT NULL
   GROUP BY e.xero_invoice_id
), bk_answer AS (
  SELECT b.xero_invoice_id,
         CASE WHEN NOT b.all_evidenced OR b.job_lines_without_job > 0 THEN 'not_evidenced'
              WHEN b.all_job AND b.jobs = 1 THEN 'job'
              WHEN b.all_not_job THEN 'not_job_cost'
              ELSE 'split' END AS answer,
         b.job_id, b.job_number
    FROM bk b
), bill AS (
  SELECT DISTINCT ON (x.xero_invoice_id) x.xero_invoice_id, x.xero_contact_id,
         NULLIF(regexp_replace(COALESCE(x.invoice_number, ''), '\D', '', 'g'), '') AS digits
    FROM public.xero_invoices x
   WHERE x.invoice_type = 'ACCPAY'
   ORDER BY x.xero_invoice_id
), att AS (
  SELECT DISTINCT a.business_event_id, m.digits
    FROM public.context_email_attachments a
   CROSS JOIN LATERAL (SELECT (regexp_matches(COALESCE(a.file_name, ''), '\d+', 'g'))[1] AS digits) m
   WHERE a.business_event_id IS NOT NULL AND length(m.digits) >= 4
), multi AS (
  SELECT DISTINCT b1.xero_invoice_id
    FROM bill b1
    JOIN att a1 ON a1.digits = b1.digits
    JOIN att a2 ON a2.business_event_id = a1.business_event_id AND a2.digits <> a1.digits
    JOIN bill b2 ON b2.digits = a2.digits AND b2.xero_contact_id = b1.xero_contact_id AND b2.xero_invoice_id <> b1.xero_invoice_id
   WHERE length(b1.digits) >= 4
)
SELECT l.xero_invoice_id,
       l.invoice_number,
       l.contact_name,
       bl.xero_contact_id,
       l.amount_ex,
       l.created_at AS decided_at,
       l.model,
       l.decision AS ai_decision,
       l.outcome AS ai_outcome,
       l.job_id AS ai_job_id,
       l.job_number AS ai_job_number,
       l.confidence AS ai_confidence,
       l.agreed_keys,
       CASE WHEN l.agreed_keys IS NOT NULL THEN 'two_keys' ELSE 'before_two_keys' END AS rule,
       (l.undone_at IS NOT NULL) AS undone,
       ba.answer AS bookkeeper_answer,
       CASE WHEN ba.answer = 'job' THEN ba.job_id END AS bookkeeper_job_id,
       CASE WHEN ba.answer = 'job' THEN ba.job_number END AS bookkeeper_job_number,
       CASE
         WHEN ba.answer IS NULL OR ba.answer NOT IN ('job', 'not_job_cost') THEN 'no_answer'
         WHEN l.decision = 'unsure' THEN 'declined'
         WHEN l.decision = 'job' AND l.job_id IS NOT NULL AND ba.answer = 'job' AND l.job_id = ba.job_id THEN 'agree'
         WHEN l.decision = 'job' AND l.job_id IS NOT NULL AND ba.answer = 'job' THEN 'wrong_job'
         WHEN l.decision = 'job' AND ba.answer = 'not_job_cost' THEN 'job_but_not_job_cost'
         WHEN l.decision = 'not_job_related' AND ba.answer = 'not_job_cost' THEN 'agree'
         WHEN l.decision = 'not_job_related' AND ba.answer = 'job' THEN 'missed_job_cost'
         ELSE 'no_answer'
       END AS verdict,
       (m.xero_invoice_id IS NOT NULL) AS multi_bill_email
  FROM latest l
  LEFT JOIN bk_answer ba ON ba.xero_invoice_id = l.xero_invoice_id
  LEFT JOIN bill bl ON bl.xero_invoice_id = l.xero_invoice_id
  LEFT JOIN multi m ON m.xero_invoice_id = l.xero_invoice_id;

COMMENT ON VIEW public.v_materials_ai_known_answers IS
  'Materials AI known answers (20261115140000): one row per bill the AI bill reader has decided. Its latest decision beside the bookkeeper''s answer for the same bill from v_bookkeeping_line_evidence_current (job: every line evidenced on one job; not_job_cost: every line evidenced as overhead or not a job cost; split; not_evidenced; null: no line loaded). verdict: agree, wrong_job, job_but_not_job_cost, missed_job_cost, declined (AI unsure), no_answer (no checkable bookkeeper answer). rule: two_keys (agreed_keys recorded) or before_two_keys. multi_bill_email: the bill''s invoice number is on an email that carries another bill of the same supplier, so the email is no evidence of the job. Neither side is taken as right; a disagreement is for a person. Read only. Service role only.';

CREATE OR REPLACE VIEW public.v_materials_ai_accuracy_by_supplier WITH (security_invoker = true) AS
SELECT k.xero_contact_id,
       min(k.contact_name) AS contact_name,
       k.rule,
       count(*) AS decided,
       count(*) FILTER (WHERE k.verdict <> 'no_answer') AS checkable,
       count(*) FILTER (WHERE k.verdict = 'agree') AS agree,
       count(*) FILTER (WHERE k.verdict = 'wrong_job') AS wrong_job,
       count(*) FILTER (WHERE k.verdict = 'job_but_not_job_cost') AS job_but_not_job_cost,
       count(*) FILTER (WHERE k.verdict = 'missed_job_cost') AS missed_job_cost,
       count(*) FILTER (WHERE k.verdict = 'declined') AS declined,
       count(*) FILTER (WHERE k.verdict IN ('wrong_job', 'job_but_not_job_cost') AND k.ai_confidence >= 0.95) AS sure_and_wrong,
       count(*) FILTER (WHERE k.ai_outcome = 'placed' AND k.verdict = 'agree') AS placed_agree,
       count(*) FILTER (WHERE k.ai_outcome = 'placed' AND k.verdict IN ('wrong_job', 'job_but_not_job_cost')) AS placed_wrong,
       count(*) FILTER (WHERE k.multi_bill_email) AS multi_bill_email,
       max(k.decided_at) AS last_decided_at
  FROM public.v_materials_ai_known_answers k
 GROUP BY k.xero_contact_id, k.rule;

COMMENT ON VIEW public.v_materials_ai_accuracy_by_supplier IS
  'Materials AI known answers (20261115140000): the verdicts of v_materials_ai_known_answers counted per supplier (Xero contact) and per rule. checkable excludes no_answer. sure_and_wrong: wrong_job or job_but_not_job_cost at AI confidence 0.95 or more. placed_agree and placed_wrong: the bills the AI actually placed. Read only. Service role only.';

REVOKE ALL ON public.v_materials_ai_known_answers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.v_materials_ai_accuracy_by_supplier FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_materials_ai_known_answers TO service_role;
GRANT SELECT ON public.v_materials_ai_accuracy_by_supplier TO service_role;

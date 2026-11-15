-- Known answers for the AI bill reader: how often it picks the job the bookkeeper picked.
--
-- The AI bill reader (20261028173000, gated by two keys from 20261029093000) says which job a supplier bill
-- belongs to. Nothing measured whether it was right. The bookkeeper's own allocation of the same bills, loaded
-- line by line into v_bookkeeping_line_evidence_current, is an answer key that already exists. This adds two
-- read-only functions that compare the two on every call. Nothing is stored, nothing is placed or moved, and no
-- existing object changes. They are functions and not views so that they hold no dependency on the tables they
-- read: an earlier slice's rollback can still drop its own table.
--
--   materials_ai_known_answers()           one row per bill the AI has decided: its latest decision, the
--                                          bookkeeper's answer for the same bill, and the verdict.
--   materials_ai_accuracy_by_supplier()    the verdicts counted per supplier and per rule.
--
-- The bookkeeper's answer for a bill (bookkeeper_answer):
--   job            every line of the bill is evidenced and allocated to the same one job;
--   not_job_cost   every line is evidenced and allocated as overhead or not a job cost;
--   split          every line is evidenced, but the lines name more than one job or mix job and overhead, or
--                  a line is split across jobs in v_bookkeeping_line_parts_current (an older whole-line row
--                  for that line does not count);
--   not_evidenced  some line is not evidenced, a job line names no job, or a bill line with an amount is not in
--                  the load at all (the load may send only the lines it resolved);
--   (null)         the bookkeeper's load has no line for the bill.
-- Only job and not_job_cost are answers the AI can be checked against. A split bill is not one job, and the AI
-- answers one job per bill, so it is left out rather than counted against either side.
-- bookkeeper_basis lists the load's bases for the bill and bookkeeper_emitted_at when the load was made. A basis
-- named register_* reads SecureSuite's own placement register (measured 15 Nov 2026: 35 of 49 such lines name a
-- job the AI had already placed the bill on before the load was emitted), so it can repeat the AI's own pick. A
-- bill whose every line rests on such a basis has answer_independent false and reads no_answer: it is no check.
--
-- verdict:
--   agree                 the AI's job is the bookkeeper's job, or both say not a job cost;
--   wrong_job             the AI named a job and the bookkeeper named a different one, or the AI named a job
--                         that does not exist (refused, job not found). The costly mistake;
--   job_but_not_job_cost  the AI named a job and the bookkeeper allocated the bill as overhead;
--   missed_job_cost       the AI said not job related and the bookkeeper named a job;
--   declined              the AI said unsure. Not wrong, and not help either;
--   no_answer             the bookkeeper has no checkable answer for this bill (null, split, not_evidenced, or
--                         an answer that rests only on our own register).
-- The AI's latest decision is the latest row for the bill in materials_ai_placements, undone or not: an undone
-- placement is still what the AI said (undone says a person took it back). A refusal written before the job was
-- looked up (no job recorded, any reason but job not found) is not an answer and is skipped.
--
-- rule says which gate the decision went through: two_keys (made at or after the first recorded keys, 30 Oct
-- 2026 UTC: the AI's confidence alone never places a bill, a hard clue such as the job number on the bill must agree;
-- a refused, unsure or below-the-bar row records no keys, so the era is read from the moment, not the keys) or
-- before_two_keys (confidence alone placed it).
--
-- multi_bill_email is true when the bill's invoice number is on an email that also carries another live bill of
-- the same supplier (the digit run of the invoice number, four digits or more, read from the attachment file
-- names in context_email_attachments, leaving out runs that read as a date and photo or video files). It is a
-- flag, not a measure: a number written differently on the bill and in the file name is not matched, and only
-- emails that were filed are seen. The email's subject then names at most one of those jobs, so it is no evidence
-- of which job a given bill belongs to. Measured 15 Nov 2026: one drawings supplier emails several invoices
-- for several patio jobs together. Measured with this flag on 15 Nov 2026: 3 bills the AI placed on a job the
-- bookkeeper did not choose came on such an email.
--
-- Neither side is taken as right by this read: a disagreement is a bill for a person to look at. Job Profit
-- already counts the bookkeeper's ledger over an AI placement (20261103050000), so a wrong_job does not change a
-- job's cost there; it does say how far the AI can be trusted where no ledger answer exists yet.
--
-- Service role only, like the tables it reads. Read only.
-- Rollback: supabase/rollbacks/20261115140000_materials_ai_known_answers_down.sql (drops both functions).

SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF to_regclass('public.materials_ai_placements') IS NULL OR to_regclass('public.v_bookkeeping_line_evidence_current') IS NULL
     OR to_regclass('public.context_email_attachments') IS NULL OR to_regclass('public.xero_invoices') IS NULL
     OR to_regclass('public.v_bookkeeping_line_parts_current') IS NULL THEN
    RAISE EXCEPTION 'materials ai known answers: materials_ai_placements, v_bookkeeping_line_evidence_current, v_bookkeeping_line_parts_current, context_email_attachments or xero_invoices is missing';
  END IF;
  IF (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = 'public.materials_ai_placements'::regclass AND NOT a.attisdropped
        AND a.attname IN ('xero_invoice_id', 'invoice_number', 'contact_name', 'amount_ex', 'decision', 'job_id', 'job_number',
                          'confidence', 'outcome', 'refusal', 'agreed_keys', 'created_at', 'undone_at', 'model')) <> 14
     OR (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = 'public.v_bookkeeping_line_evidence_current'::regclass
           AND NOT a.attisdropped AND a.attname IN ('xero_invoice_id', 'xero_line_item_id', 'allocation', 'job_id', 'job_number',
                                                     'evidenced', 'basis', 'emitted_at')) <> 8
     OR (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = 'public.v_bookkeeping_line_parts_current'::regclass
           AND NOT a.attisdropped AND a.attname IN ('xero_invoice_id', 'xero_line_item_id')) <> 2
     OR (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = 'public.context_email_attachments'::regclass
           AND NOT a.attisdropped AND a.attname IN ('business_event_id', 'file_name')) <> 2
     OR (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = 'public.xero_invoices'::regclass
           AND NOT a.attisdropped AND a.attname IN ('xero_invoice_id', 'xero_contact_id', 'invoice_number', 'invoice_type', 'status',
                                                     'line_items', 'updated_at')) <> 7 THEN
    RAISE EXCEPTION 'materials ai known answers: a column the read needs is missing';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.materials_ai_placements', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.v_bookkeeping_line_evidence_current', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.context_email_attachments', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.xero_invoices', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.v_bookkeeping_line_parts_current', 'SELECT') THEN
    RAISE EXCEPTION 'materials ai known answers: the service role cannot read a table the functions read';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.materials_ai_known_answers()
RETURNS TABLE (
  xero_invoice_id text, invoice_number text, contact_name text, xero_contact_id text, amount_ex numeric,
  decided_at timestamptz, model text, ai_decision text, ai_outcome text, ai_job_id uuid, ai_job_number text,
  ai_confidence numeric, agreed_keys text[], rule text, undone boolean, bookkeeper_answer text,
  bookkeeper_job_id uuid, bookkeeper_job_number text, bookkeeper_basis text, bookkeeper_emitted_at timestamptz,
  answer_independent boolean, verdict text, multi_bill_email boolean)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp
AS $ka$
WITH latest AS (
  -- A refusal written before the job was looked up (already assigned, already decided, not live in Xero, a
  -- person placed it, the second check) carries no job and is not the AI's answer: it never stands in for one.
  SELECT DISTINCT ON (p.xero_invoice_id) p.*
    FROM public.materials_ai_placements p
   WHERE NOT (p.outcome = 'refused' AND p.job_id IS NULL AND p.refusal IS DISTINCT FROM 'job not found')
   ORDER BY p.xero_invoice_id, p.created_at DESC, p.id DESC
), cutover AS (
  -- The moment the two-key rule began: its first recorded keys. Every decision from then on went through it,
  -- whatever its outcome (a refused, unsure or below-the-bar row records no keys).
  SELECT min(p.created_at) AS at FROM public.materials_ai_placements p WHERE p.agreed_keys IS NOT NULL
), bill AS (
  SELECT DISTINCT ON (x.xero_invoice_id) x.xero_invoice_id, x.xero_contact_id, x.line_items,
         NULLIF(regexp_replace(COALESCE(x.invoice_number, ''), '\D', '', 'g'), '') AS digits,
         COALESCE(x.status, '') NOT IN ('VOIDED', 'DELETED') AS live
    FROM public.xero_invoices x
   WHERE x.invoice_type = 'ACCPAY'
   ORDER BY x.xero_invoice_id, (COALESCE(x.status, '') NOT IN ('VOIDED', 'DELETED')) DESC, x.updated_at DESC NULLS LAST
), bk AS (
  SELECT e.xero_invoice_id,
         bool_and(COALESCE(e.evidenced, false)) AS all_evidenced,
         -- A basis named register_* reads SecureSuite's own placement register, so it can repeat the AI's pick.
         bool_and(COALESCE(e.basis, '') ~ '^register_') AS all_register,
         string_agg(DISTINCT e.basis, ', ' ORDER BY e.basis) AS bases,
         max(e.emitted_at) AS emitted_at,
         bool_and(e.allocation = 'job') AS all_job,
         bool_and(e.allocation IN ('overhead', 'not_job_cost')) AS all_not_job,
         count(DISTINCT e.job_id) AS jobs,
         count(*) FILTER (WHERE e.allocation = 'job' AND e.job_id IS NULL) AS job_lines_without_job,
         min(e.job_id::text)::uuid AS job_id,
         min(e.job_number) AS job_number,
         array_agg(e.xero_line_item_id) FILTER (WHERE e.xero_line_item_id IS NOT NULL) AS line_ids
    FROM public.v_bookkeeping_line_evidence_current e
   WHERE e.xero_invoice_id IS NOT NULL
     -- A text line the bill carries with no amount says nothing about where the money went: the load files it as
     -- not a job cost at 0, and it must not make a one-job bill read split.
     AND NOT EXISTS (SELECT 1 FROM bill x CROSS JOIN LATERAL jsonb_array_elements(
                                CASE WHEN jsonb_typeof(x.line_items) = 'array' THEN x.line_items ELSE '[]'::jsonb END) li
                      WHERE x.xero_invoice_id = e.xero_invoice_id AND li ->> 'LineItemID' = e.xero_line_item_id
                        AND COALESCE(CASE WHEN jsonb_typeof(li -> 'LineAmount') = 'number' THEN (li ->> 'LineAmount')::numeric END, 0) = 0)
   GROUP BY e.xero_invoice_id
), bk_answer AS (
  -- A bill line with an amount the load does not carry is a line not evidenced: the load may send only the lines
  -- it resolved.
  -- A line the ledger splits across jobs lives in the parts read: the bill is split, whatever an older whole-line
  -- row says.
  SELECT b.xero_invoice_id,
         CASE WHEN EXISTS (SELECT 1 FROM public.v_bookkeeping_line_parts_current p WHERE p.xero_invoice_id = b.xero_invoice_id
                            AND p.xero_line_item_id = ANY (COALESCE(b.line_ids, ARRAY[]::text[])))
                THEN 'split'
              WHEN NOT b.all_evidenced OR b.job_lines_without_job > 0
                   OR EXISTS (SELECT 1 FROM bill x CROSS JOIN LATERAL jsonb_array_elements(
                                         CASE WHEN jsonb_typeof(x.line_items) = 'array' THEN x.line_items ELSE '[]'::jsonb END) li
                               WHERE x.xero_invoice_id = b.xero_invoice_id
                                 AND COALESCE(CASE WHEN jsonb_typeof(li -> 'LineAmount') = 'number' THEN (li ->> 'LineAmount')::numeric END, 0) <> 0
                                 AND li ->> 'LineItemID' IS NOT NULL
                                 AND NOT (li ->> 'LineItemID' = ANY (COALESCE(b.line_ids, ARRAY[]::text[]))))
                THEN 'not_evidenced'
              WHEN b.all_job AND b.jobs = 1 THEN 'job'
              WHEN b.all_not_job THEN 'not_job_cost'
              ELSE 'split' END AS answer,
         b.job_id, b.job_number, b.bases, b.emitted_at, NOT b.all_register AS independent
    FROM bk b
), att AS (
  -- Digit runs of four or more in attachment file names, leaving out runs that read as a date (2026, 202610,
  -- 20261012) and photo or video files (a phone names them IMG_0021.jpeg).
  SELECT DISTINCT a.business_event_id, m.digits
    FROM public.context_email_attachments a
   CROSS JOIN LATERAL (SELECT (regexp_matches(COALESCE(a.file_name, ''), '\d+', 'g'))[1] AS digits) m
   WHERE a.business_event_id IS NOT NULL AND length(m.digits) >= 4
     AND m.digits !~ '^20[0-9]{2}((0[1-9]|1[0-2])([0-3][0-9])?)?$'
     AND COALESCE(a.file_name, '') !~* '\.(jpe?g|png|gif|heic|heif|webp|bmp|tiff?|mp4|mov|m4v|avi)$'
), bill_email AS (
  SELECT b.xero_invoice_id, b.xero_contact_id, b.digits, a.business_event_id
    FROM bill b JOIN att a ON a.digits = b.digits
   WHERE b.live AND length(b.digits) >= 4
), multi AS (
  -- The bill's number is on an email that also carries another live bill of the same supplier.
  SELECT DISTINCT e1.xero_invoice_id
    FROM bill_email e1
    JOIN bill_email e2 ON e2.business_event_id = e1.business_event_id AND e2.xero_contact_id = e1.xero_contact_id
                      AND e2.digits <> e1.digits
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
       CASE WHEN l.agreed_keys IS NOT NULL OR l.created_at >= (SELECT c.at FROM cutover c) THEN 'two_keys'
            ELSE 'before_two_keys' END AS rule,
       (l.undone_at IS NOT NULL) AS undone,
       ba.answer AS bookkeeper_answer,
       CASE WHEN ba.answer = 'job' THEN ba.job_id END AS bookkeeper_job_id,
       CASE WHEN ba.answer = 'job' THEN ba.job_number END AS bookkeeper_job_number,
       ba.bases AS bookkeeper_basis,
       ba.emitted_at AS bookkeeper_emitted_at,
       ba.independent AS answer_independent,
       -- A job pick the reader could not resolve to a job (refused, job not found) is still a job pick: it is
       -- wrong against a bookkeeper's job as it is against a bookkeeper's overhead. An answer that rests only on
       -- our own register is no check of the AI.
       CASE
         WHEN ba.answer IS NULL OR ba.answer NOT IN ('job', 'not_job_cost') OR NOT ba.independent THEN 'no_answer'
         WHEN l.decision = 'unsure' THEN 'declined'
         WHEN l.decision = 'job' AND ba.answer = 'job' AND l.job_id = ba.job_id THEN 'agree'
         WHEN l.decision = 'job' AND ba.answer = 'job' THEN 'wrong_job'
         WHEN l.decision = 'job' AND ba.answer = 'not_job_cost' THEN 'job_but_not_job_cost'
         WHEN l.decision = 'not_job_related' AND ba.answer = 'not_job_cost' THEN 'agree'
         WHEN l.decision = 'not_job_related' AND ba.answer = 'job' THEN 'missed_job_cost'
         ELSE 'no_answer'
       END AS verdict,
       (m.xero_invoice_id IS NOT NULL) AS multi_bill_email
  FROM latest l
  LEFT JOIN bk_answer ba ON ba.xero_invoice_id = l.xero_invoice_id
  LEFT JOIN bill bl ON bl.xero_invoice_id = l.xero_invoice_id
  LEFT JOIN multi m ON m.xero_invoice_id = l.xero_invoice_id
$ka$;

COMMENT ON FUNCTION public.materials_ai_known_answers() IS
  'Materials AI known answers (20261115140000): one row per bill the AI bill reader has decided. Its latest decision beside the bookkeeper''s answer for the same bill from v_bookkeeping_line_evidence_current (job: every line evidenced on one job; not_job_cost: every line evidenced as overhead or not a job cost; split; not_evidenced, including a bill line with an amount the load does not carry; null: no line loaded), the bases of that answer, when the load was made, and answer_independent (false when every line rests on a register_* basis, which reads our own placements). verdict: agree, wrong_job (including a job pick refused as job not found), job_but_not_job_cost, missed_job_cost, declined (AI unsure), no_answer (no checkable or independent bookkeeper answer). A refusal with no job, for any reason but job not found, is skipped as not an answer. rule: two_keys (decided at or after the first recorded keys) or before_two_keys. multi_bill_email: the bill''s invoice number is on an email that carries another live bill of the same supplier, so the email is no evidence of the job. Neither side is taken as right; a disagreement is for a person. Read only. Service role only.';

CREATE OR REPLACE FUNCTION public.materials_ai_accuracy_by_supplier()
RETURNS TABLE (
  xero_contact_id text, contact_name text, rule text, decided bigint, checkable bigint, agree bigint,
  wrong_job bigint, job_but_not_job_cost bigint, missed_job_cost bigint, declined bigint, sure_and_wrong bigint,
  sure_and_missed bigint, placed_agree bigint, placed_wrong bigint, filed_agree bigint, filed_wrong bigint,
  multi_bill_email bigint, last_decided_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp
AS $kb$
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
       count(*) FILTER (WHERE k.verdict = 'missed_job_cost' AND k.ai_confidence >= 0.95) AS sure_and_missed,
       count(*) FILTER (WHERE k.ai_outcome = 'placed' AND k.verdict = 'agree') AS placed_agree,
       count(*) FILTER (WHERE k.ai_outcome = 'placed' AND k.verdict IN ('wrong_job', 'job_but_not_job_cost')) AS placed_wrong,
       count(*) FILTER (WHERE k.ai_outcome = 'filed_not_job_related' AND k.verdict = 'agree') AS filed_agree,
       count(*) FILTER (WHERE k.ai_outcome = 'filed_not_job_related' AND k.verdict = 'missed_job_cost') AS filed_wrong,
       count(*) FILTER (WHERE k.multi_bill_email) AS multi_bill_email,
       max(k.decided_at) AS last_decided_at
  FROM public.materials_ai_known_answers() k
 GROUP BY k.xero_contact_id, k.rule
$kb$;

COMMENT ON FUNCTION public.materials_ai_accuracy_by_supplier() IS
  'Materials AI known answers (20261115140000): the verdicts of materials_ai_known_answers() counted per supplier (Xero contact) and per rule. checkable excludes no_answer. sure_and_wrong: wrong_job or job_but_not_job_cost at AI confidence 0.95 or more; sure_and_missed: missed_job_cost at 0.95 or more (a fixed mark for comparison, not the reader''s live confidence bar). placed_agree and placed_wrong: the bills the AI actually placed on a job. filed_agree and filed_wrong: the bills it filed as not job related on its own (filed_wrong took a job cost off the job with no person involved). Read only. Service role only.';

REVOKE ALL ON FUNCTION public.materials_ai_known_answers() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.materials_ai_accuracy_by_supplier() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materials_ai_known_answers() TO service_role;
GRANT EXECUTE ON FUNCTION public.materials_ai_accuracy_by_supplier() TO service_role;

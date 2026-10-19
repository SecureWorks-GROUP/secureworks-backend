-- Ledger send fields (20261019140000).
-- email_events.recipient already exists (text, not null) and is not always an
-- address. invoice.emailed already stores the address in detail_json.to.
-- This migration adds no recipient column and no payment column. It copies
-- those existing typed values, plus a contact id the send path stored in the
-- same JSON, onto the ledger link the reader consumes. A system email copies
-- recipient under recipient. An invoice.emailed row copies detail_json.to under
-- to. A sent document copies its id, its quote or invoice number, and a
-- recipient, email ids and delivery status only from rows that name that
-- document. A paid invoice copies xero id, invoice number, total, paid, owing,
-- credits and payments. A paid bill copies xero id, bill number, supplier,
-- total, paid, owing and payments. context_ledger_packet is not replaced.
-- The record-link comment keeps the 20261018120000 prefix.
--
-- No transaction wrapper. scripts/apply-pending-migrations.sh refuses a pending
-- migration that contains BEGIN, COMMIT, ROLLBACK or START TRANSACTION.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $guard$
DECLARE
 problems text[] := '{}';
 live text;
 note text;
BEGIN
 SELECT md5(p.prosrc), coalesce(obj_description(p.oid, 'pg_proc'), '')
  INTO live, note
  FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.context_ledger_evidence_record_links(uuid,timestamptz,jsonb)');
 IF live IS NULL THEN
  problems := problems || 'context_ledger_evidence_record_links missing';
 ELSIF live <> '5a42fd730f88c3ac302d4a72605b5439'
   AND note NOT LIKE '%Send recipient fields (20261019140000)%' THEN
  problems := problems || format('context_ledger_evidence_record_links md5 %s', live);
 END IF;
 IF live IS NOT NULL AND note NOT LIKE 'Ledger packet records (20261018120000)%' THEN
  problems := problems || 'record links comment lost the 20261018120000 prefix';
 END IF;
 IF to_regprocedure('public.context_ledger_packet(uuid,timestamptz,timestamptz)') IS NULL THEN
  problems := problems || 'context_ledger_packet missing';
 END IF;
 IF to_regprocedure('public.context_ledger_record_money(numeric)') IS NULL THEN
  problems := problems || 'context_ledger_record_money missing';
 END IF;
 IF to_regprocedure('public.context_ledger_record_trim(text)') IS NULL THEN
  problems := problems || 'context_ledger_record_trim missing';
 END IF;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_ledger_send_fields_preimage_mismatch: %', array_to_string(problems, '; ');
 END IF;
END $guard$;

-- One email address, or null. The word client, a phone, a job-contact id, a
-- list, and "Name <addr>" are not an address. The stored text is not rewritten.
CREATE OR REPLACE FUNCTION public.context_ledger_record_email(p_raw text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
 SELECT CASE
  WHEN btrim(p_raw) ~ '^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\.[^[:space:]@,;<>]+$'
   THEN btrim(p_raw)
  ELSE NULL
 END
$fn$;
COMMENT ON FUNCTION public.context_ledger_record_email(text) IS
 'Send recipient fields (20261019140000): one email address, or null. Not a copy of a phone, the word client, or a list.';

-- A customer contact id already stored by the send path. An address is not one.
CREATE OR REPLACE FUNCTION public.context_ledger_record_contact(p_raw text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
 SELECT CASE
  WHEN public.context_ledger_record_trim(p_raw) IS NOT NULL
   AND position('@' IN public.context_ledger_record_trim(p_raw)) = 0
   THEN public.context_ledger_record_trim(p_raw)
  ELSE NULL
 END
$fn$;
COMMENT ON FUNCTION public.context_ledger_record_contact(text) IS
 'Send recipient fields (20261019140000): a stored contact id with no @, or null.';

-- A payment or credit date the reader can match: a leading calendar day, or a
-- Xero /Date(ms)/ instant as a Perth calendar day.
CREATE OR REPLACE FUNCTION public.context_ledger_record_xero_date(p_raw text)
RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE
AS $fn$
 SELECT CASE
  WHEN btrim(p_raw) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
   THEN substring(btrim(p_raw) FROM '^[0-9]{4}-[0-9]{2}-[0-9]{2}')
  WHEN p_raw ~ '^/Date\(-?[0-9]+'
   THEN (to_timestamp(substring(p_raw FROM '^/Date\((-?[0-9]+)')::numeric / 1000)
         AT TIME ZONE 'Australia/Perth')::date::text
  ELSE NULL
 END
$fn$;
COMMENT ON FUNCTION public.context_ledger_record_xero_date(text) IS
 'Send recipient fields (20261019140000): a payment date as YYYY-MM-DD in Perth, or null.';

-- Production money names. invoice_number, xero_id, supplier and total are
-- copied whenever the column is set. paid, owing, payments and credits are
-- copied only when that source is present. Owing of zero is kept. A zero or
-- negative paid amount is omitted. amount_due and amount_paid are not key
-- names. A bill link renames invoice_number to bill_number and drops credits.
CREATE OR REPLACE FUNCTION public.context_ledger_record_invoice_money(
 p_invoice_number text,
 p_xero_id text,
 p_supplier text,
 p_total numeric,
 p_amount_paid numeric,
 p_amount_due numeric,
 p_raw jsonb
) RETURNS jsonb
LANGUAGE sql STABLE PARALLEL SAFE
AS $fn$
 SELECT jsonb_strip_nulls(jsonb_build_object(
  'invoice_number', public.context_ledger_record_trim(p_invoice_number),
  'xero_id', public.context_ledger_record_trim(p_xero_id),
  'supplier', public.context_ledger_record_trim(p_supplier),
  'total', public.context_ledger_record_money(p_total),
  'paid', public.context_ledger_record_money(coalesce(p_amount_paid, src.paid_from_rows)),
  'owing', CASE WHEN p_amount_due IS NOT NULL THEN round(p_amount_due, 2)::text END,
  'payments', src.payments,
  'credits', src.credits
 ))
 FROM (
  SELECT
   (SELECT sum((p.el->>'Amount')::numeric)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_raw->'Payments') = 'array' THEN p_raw->'Payments' ELSE '[]'::jsonb END) p(el)
    WHERE p.el->>'Amount' ~ '^-?[0-9]+(\.[0-9]+)?$') AS paid_from_rows,
   (SELECT CASE WHEN count(*) > 0 THEN jsonb_agg(p.row ORDER BY p.dt COLLATE "C", p.amt COLLATE "C", p.ord) END
    FROM (
     SELECT
      jsonb_strip_nulls(jsonb_build_object(
       'date', public.context_ledger_record_xero_date(el.el->>'Date'),
       'amount', public.context_ledger_record_money(CASE WHEN el.el->>'Amount' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (el.el->>'Amount')::numeric END)
      )) AS row,
      coalesce(public.context_ledger_record_xero_date(el.el->>'Date'), '') AS dt,
      coalesce(public.context_ledger_record_money(CASE WHEN el.el->>'Amount' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (el.el->>'Amount')::numeric END), '') AS amt,
      el.ord
     FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_raw->'Payments') = 'array' THEN p_raw->'Payments' ELSE '[]'::jsonb END)
      WITH ORDINALITY AS el(el, ord)
    ) p
    WHERE p.row ? 'amount') AS payments,
   (SELECT CASE WHEN count(*) > 0 THEN jsonb_agg(c.row ORDER BY c.kind COLLATE "C", c.num COLLATE "C", c.dt COLLATE "C", c.amt COLLATE "C", c.ord) END
    FROM (
     SELECT
      jsonb_strip_nulls(jsonb_build_object(
       'kind', c.kind,
       'number', public.context_ledger_record_trim(c.el->>'CreditNoteNumber'),
       'date', public.context_ledger_record_xero_date(c.el->>'Date'),
       'amount', public.context_ledger_record_money(CASE
         WHEN nullif(btrim(c.el->>'AppliedAmount'), '') ~ '^-?[0-9]+(\.[0-9]+)?$'
          THEN nullif(btrim(c.el->>'AppliedAmount'), '')::numeric
         WHEN nullif(btrim(c.el->>'Amount'), '') ~ '^-?[0-9]+(\.[0-9]+)?$'
          THEN nullif(btrim(c.el->>'Amount'), '')::numeric
        END)
      )) AS row,
      c.kind,
      coalesce(public.context_ledger_record_trim(c.el->>'CreditNoteNumber'), '') AS num,
      coalesce(public.context_ledger_record_xero_date(c.el->>'Date'), '') AS dt,
      coalesce(public.context_ledger_record_money(CASE
         WHEN nullif(btrim(c.el->>'AppliedAmount'), '') ~ '^-?[0-9]+(\.[0-9]+)?$'
          THEN nullif(btrim(c.el->>'AppliedAmount'), '')::numeric
         WHEN nullif(btrim(c.el->>'Amount'), '') ~ '^-?[0-9]+(\.[0-9]+)?$'
          THEN nullif(btrim(c.el->>'Amount'), '')::numeric
        END), '') AS amt,
      c.ord
     FROM (
      SELECT 'credit_note'::text AS kind, e.el, e.ord
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_raw->'CreditNotes') = 'array' THEN p_raw->'CreditNotes' ELSE '[]'::jsonb END)
       WITH ORDINALITY AS e(el, ord)
      UNION ALL
      SELECT 'overpayment', e.el, e.ord
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_raw->'Overpayments') = 'array' THEN p_raw->'Overpayments' ELSE '[]'::jsonb END)
       WITH ORDINALITY AS e(el, ord)
      UNION ALL
      SELECT 'prepayment', e.el, e.ord
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_raw->'Prepayments') = 'array' THEN p_raw->'Prepayments' ELSE '[]'::jsonb END)
       WITH ORDINALITY AS e(el, ord)
     ) c
    ) c
    WHERE c.row ? 'amount') AS credits
 ) src
$fn$;
COMMENT ON FUNCTION public.context_ledger_record_invoice_money(text, text, text, numeric, numeric, numeric, jsonb) IS
 'Send recipient fields (20261019140000): xero id, number, supplier and total when those columns are set, and paid, owing, payments and credits only when that source is present.';

REVOKE ALL ON FUNCTION public.context_ledger_record_email(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_record_contact(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_record_xero_date(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_record_invoice_money(text, text, text, numeric, numeric, numeric, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_record_email(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_record_contact(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_record_xero_date(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_record_invoice_money(text, text, text, numeric, numeric, numeric, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.context_ledger_evidence_record_links(p_job_id uuid, p_as_of timestamptz, p_sources jsonb)
RETURNS TABLE(src_table text, src_id uuid, records jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
WITH src AS (
 SELECT el->>'table' AS st, public.context_ledger_record_uuid(el->>'id') AS sid
 FROM jsonb_array_elements(coalesce(p_sources, '[]'::jsonb)) el
 WHERE el->>'table' IN ('business_events', 'inbox_events')
   AND public.context_ledger_record_uuid(el->>'id') IS NOT NULL
), be AS (
 SELECT s.st, s.sid, b.source_table, b.source_id, b.payload, b.metadata
 FROM src s
 JOIN public.business_events b ON b.id = s.sid
 WHERE s.st = 'business_events'
), ptr AS (
 SELECT b.st, b.sid, v.kind, v.raw
 FROM be b
 CROSS JOIN LATERAL (VALUES
  ('email_event', b.payload->>'email_event_id'),
  ('email_event', b.metadata->>'email_event_id'),
  ('job_event', b.payload->>'job_event_id'),
  ('job_event', b.metadata->>'job_event_id'),
  ('job_document', b.payload->>'document_id'),
  ('job_document', b.metadata->>'document_id'),
  ('xero_invoice', b.payload->>'xero_invoice_id'),
  ('xero_invoice', b.metadata->>'xero_invoice_id')
 ) AS v(kind, raw)
 WHERE nullif(btrim(v.raw), '') IS NOT NULL
 UNION ALL
 SELECT b.st, b.sid,
  CASE lower(btrim(b.source_table))
   WHEN 'email_events' THEN 'email_event' WHEN 'email_event' THEN 'email_event'
   WHEN 'job_events' THEN 'job_event' WHEN 'job_event' THEN 'job_event'
   WHEN 'job_documents' THEN 'job_document' WHEN 'job_document' THEN 'job_document'
   WHEN 'xero_invoices' THEN 'xero_invoice' WHEN 'xero_invoice' THEN 'xero_invoice'
   ELSE NULL END,
  b.source_id
 FROM be b
 WHERE nullif(btrim(b.source_id), '') IS NOT NULL
   AND lower(btrim(coalesce(b.source_table, ''))) IN
    ('email_events','email_event','job_events','job_event','job_documents','job_document','xero_invoices','xero_invoice')
 UNION ALL
 SELECT b.st, b.sid, m.kind, ents.el->>'id'
 FROM be b
 CROSS JOIN LATERAL (
  SELECT e AS el FROM jsonb_array_elements(
   CASE WHEN jsonb_typeof(b.payload->'related_entities') = 'array' THEN b.payload->'related_entities' ELSE '[]'::jsonb END) e
  UNION ALL
  SELECT e FROM jsonb_array_elements(
   CASE WHEN jsonb_typeof(b.metadata->'related_entities') = 'array' THEN b.metadata->'related_entities' ELSE '[]'::jsonb END) e
 ) ents(el)
 CROSS JOIN LATERAL (SELECT CASE lower(btrim(ents.el->>'type'))
  WHEN 'email_events' THEN 'email_event' WHEN 'email_event' THEN 'email_event'
  WHEN 'job_events' THEN 'job_event' WHEN 'job_event' THEN 'job_event'
  WHEN 'job_documents' THEN 'job_document' WHEN 'job_document' THEN 'job_document'
  WHEN 'xero_invoices' THEN 'xero_invoice' WHEN 'xero_invoice' THEN 'xero_invoice'
  ELSE NULL END AS kind) m
 WHERE m.kind IS NOT NULL AND nullif(btrim(ents.el->>'id'), '') IS NOT NULL
), em_id AS (
 SELECT p.st, p.sid, public.context_ledger_record_uuid(p.raw) AS email_id
 FROM ptr p
 WHERE p.kind = 'email_event' AND public.context_ledger_record_uuid(p.raw) IS NOT NULL
 UNION
 SELECT s.st, s.sid, e.id
 FROM src s
 JOIN public.email_events e ON e.job_id = p_job_id
  AND ((s.st = 'business_events' AND public.context_ledger_record_uuid(e.metadata->>'business_event_id') = s.sid)
    OR (s.st = 'inbox_events' AND public.context_ledger_record_uuid(e.metadata->>'inbox_event_id') = s.sid))
), em AS (
 SELECT i.st, i.sid,
  jsonb_strip_nulls(jsonb_build_object('kind','system_email','table','email_events','id', e.id::text, 'job_id', p_job_id::text,
   'email_type', et.t, 'status', lower(btrim(e.status)), 'about', ab.a, 'system', true,
   'recipient', CASE WHEN coalesce(e.metadata->>'several_recipients', '') IN ('true', 't') THEN NULL
     ELSE public.context_ledger_record_email(e.recipient) END,
   'contact_id', CASE WHEN coalesce(e.metadata->>'several_recipients', '') IN ('true', 't') THEN NULL
     ELSE public.context_ledger_record_contact(e.metadata->>'contact_id') END)) AS rec,
  'system_email'::text AS kind, e.id::text AS ident, ''::text AS doc_id
 FROM em_id i
 JOIN public.email_events e ON e.id = i.email_id AND e.job_id = p_job_id
 CROSS JOIN LATERAL (SELECT CASE lower(btrim(e.email_type))
  WHEN 'quote' THEN 'quote' WHEN 'quote_sent' THEN 'quote' WHEN 'quote_email' THEN 'quote'
  WHEN 'invoice' THEN 'invoice' WHEN 'invoice_sent' THEN 'invoice' WHEN 'invoice_email' THEN 'invoice'
  WHEN 'client_email' THEN 'client_email' ELSE NULL END) et(t)
 CROSS JOIN LATERAL (SELECT
  public.context_ledger_record_link_about(e.metadata->>'about') AS about_key,
  public.context_ledger_record_link_about(e.metadata->>'quote_number') AS quote_key,
  public.context_ledger_record_link_about(e.metadata->>'invoice_number') AS invoice_key,
  (SELECT public.context_ledger_record_link_about(d.quote_number) FROM public.job_documents d
   WHERE d.id = public.context_ledger_record_uuid(e.metadata->>'document_id') AND d.job_id = p_job_id) AS doc_key
 ) keys
 -- A quote email does not carry an invoice about-key. invoice_number is not
 -- consulted for quote, and a quote key that normalises to invoice: is skipped
 -- so a later quote key can still be the about.
 CROSS JOIN LATERAL (SELECT CASE
  WHEN et.t = 'quote' THEN coalesce(
    CASE WHEN keys.about_key NOT LIKE 'invoice:%' THEN keys.about_key END,
    CASE WHEN keys.quote_key NOT LIKE 'invoice:%' THEN keys.quote_key END,
    CASE WHEN keys.doc_key NOT LIKE 'invoice:%' THEN keys.doc_key END)
  ELSE coalesce(keys.about_key, keys.quote_key, keys.invoice_key, keys.doc_key)
 END AS a) ab
 WHERE e.sent_at IS NOT NULL AND e.sent_at <= p_as_of
   AND lower(btrim(e.status)) IN ('sent', 'delivered', 'accepted')
   AND et.t IS NOT NULL AND ab.a IS NOT NULL
), je_id AS (
 SELECT p.st, p.sid, public.context_ledger_record_uuid(p.raw) AS event_id
 FROM ptr p
 WHERE p.kind = 'job_event' AND public.context_ledger_record_uuid(p.raw) IS NOT NULL
 UNION
 SELECT s.st, s.sid, je.id
 FROM src s
 JOIN public.job_events je ON je.job_id = p_job_id
  AND ((s.st = 'business_events' AND public.context_ledger_record_uuid(je.detail_json->>'business_event_id') = s.sid)
    OR (s.st = 'inbox_events' AND public.context_ledger_record_uuid(je.detail_json->>'inbox_event_id') = s.sid))
), jev AS (
 SELECT i.st, i.sid,
  jsonb_strip_nulls(jsonb_build_object('kind','job_event','table','job_events','id', je.id::text, 'job_id', p_job_id::text,
   'event_type', public.context_ledger_record_trim(je.event_type), 'about', ab.a,
   'to', CASE WHEN lower(public.context_ledger_record_trim(je.event_type)) = 'invoice.emailed'
     THEN public.context_ledger_record_email(je.detail_json->>'to') END,
   'contact_id', CASE WHEN lower(public.context_ledger_record_trim(je.event_type)) = 'invoice.emailed'
     THEN public.context_ledger_record_contact(je.detail_json->>'contact_id') END)) AS rec,
  'job_event'::text AS kind, je.id::text AS ident, ''::text AS doc_id
 FROM je_id i
 JOIN public.job_events je ON je.id = i.event_id AND je.job_id = p_job_id
 CROSS JOIN LATERAL (SELECT coalesce(
  public.context_ledger_record_link_about(je.detail_json->>'about'),
  public.context_ledger_record_link_about(je.detail_json->>'quote_number'),
  public.context_ledger_record_link_about(je.detail_json->>'invoice_number'),
  public.context_ledger_record_link_about(je.detail_json->>'scheduled_date'),
  public.context_ledger_record_link_about(je.detail_json->>'date'),
  public.context_ledger_record_link_about(je.detail_json->>'new_date'),
  (SELECT public.context_ledger_record_link_about(d.quote_number) FROM public.job_documents d
   WHERE d.id = public.context_ledger_record_uuid(je.detail_json->>'document_id') AND d.job_id = p_job_id)
 ) AS a) ab
 WHERE je.created_at IS NOT NULL AND je.created_at <= p_as_of
   AND public.context_ledger_record_trim(je.event_type) IS NOT NULL AND ab.a IS NOT NULL
), docs AS (
 SELECT p.st, p.sid, public.context_ledger_record_uuid(p.raw) AS document_id
 FROM ptr p
 WHERE p.kind = 'job_document' AND public.context_ledger_record_uuid(p.raw) IS NOT NULL
), sent AS (
 -- Recipient, email ids and delivery status come only from rows that name this
 -- document. A quote number match is not one. quote_sent contributes sent_to,
 -- never to. Several distinct addresses omit the recipient. A mixed bounce and
 -- failure omits the status rather than inventing one word for both.
 SELECT i.st, i.sid,
  jsonb_strip_nulls(jsonb_build_object('kind','sent_document','table','job_documents','id', d.id::text,
   'job_id', p_job_id::text, 'about', ab.a, 'document_id', d.id::text,
   'quote_number', CASE WHEN ab.a LIKE 'quote:%' THEN public.context_ledger_record_trim(d.quote_number) END,
   'invoice_number', CASE WHEN ab.a LIKE 'invoice:%' THEN public.context_ledger_record_trim(d.quote_number) END,
   'recipient', send.recipient, 'email_ids', send.email_ids, 'delivery_status', send.delivery_status)) AS rec,
  'sent_document'::text AS kind, d.id::text AS ident, ''::text AS doc_id
 FROM docs i
 JOIN public.job_documents d ON d.id = i.document_id AND d.job_id = p_job_id
 CROSS JOIN LATERAL (SELECT public.context_ledger_record_link_about(d.quote_number) AS a) ab
 LEFT JOIN LATERAL (
  WITH ship AS (
   SELECT public.context_ledger_record_email(CASE
     WHEN coalesce(e.metadata->>'several_recipients', '') IN ('true', 't') THEN NULL
     ELSE e.recipient END) AS addr,
    e.id::text AS email_id,
    lower(btrim(e.status)) AS status
   FROM public.email_events e
   WHERE e.job_id = p_job_id
     AND public.context_ledger_record_uuid(e.metadata->>'document_id') = d.id
     AND coalesce(e.sent_at, e.created_at) IS NOT NULL
     AND coalesce(e.sent_at, e.created_at) <= p_as_of
   UNION ALL
   SELECT public.context_ledger_record_email(je.detail_json->>'to'), NULL::text, NULL::text
   FROM public.job_events je
   WHERE je.job_id = p_job_id
     AND lower(public.context_ledger_record_trim(je.event_type)) = 'invoice.emailed'
     AND public.context_ledger_record_uuid(je.detail_json->>'document_id') = d.id
     AND je.created_at IS NOT NULL AND je.created_at <= p_as_of
   UNION ALL
   SELECT public.context_ledger_record_email(je.detail_json->>'sent_to'), NULL::text, NULL::text
   FROM public.job_events je
   WHERE je.job_id = p_job_id
     AND lower(public.context_ledger_record_trim(je.event_type)) = 'quote_sent'
     AND public.context_ledger_record_uuid(je.detail_json->>'document_id') = d.id
     AND je.created_at IS NOT NULL AND je.created_at <= p_as_of
  )
  SELECT
   CASE WHEN count(DISTINCT src.addr) = 1 THEN min(src.addr) END AS recipient,
   (SELECT jsonb_agg(ids.email_id ORDER BY ids.email_id COLLATE "C")
    FROM (SELECT DISTINCT s.email_id FROM ship s WHERE s.email_id IS NOT NULL) ids(email_id)) AS email_ids,
   CASE
    WHEN count(src.status) = 0 THEN NULL
    WHEN count(DISTINCT src.status) = 1 THEN min(src.status)
    WHEN bool_and(src.status IN ('bounced', 'failed')) AND bool_and(src.status = 'bounced') THEN 'bounced'
    WHEN bool_and(src.status IN ('bounced', 'failed')) AND bool_and(src.status = 'failed') THEN 'failed'
    ELSE NULL
   END AS delivery_status
  FROM ship src
 ) send ON true
 WHERE d.sent_at IS NOT NULL AND d.sent_at <= p_as_of
   AND ab.a IS NOT NULL
), xi_raw AS (
 -- A voided or deleted twin is not a second live invoice. Counting it made a
 -- real PAID row ambiguous and dropped the link. A draft twin still counts:
 -- two live rows for one pointer stay silent. Null status still counts.
 SELECT p.st, p.sid, btrim(p.raw) AS raw, xi.id
 FROM ptr p
 JOIN public.xero_invoices xi ON xi.job_id = p_job_id
  AND (xi.xero_invoice_id = btrim(p.raw) OR xi.id = public.context_ledger_record_uuid(p.raw))
 WHERE p.kind = 'xero_invoice'
   AND upper(coalesce(public.context_ledger_record_trim(xi.status), '')) NOT IN ('VOIDED', 'DELETED')
), xi_one AS (
 SELECT r.st, r.sid, r.raw FROM xi_raw r GROUP BY r.st, r.sid, r.raw HAVING count(DISTINCT r.id) = 1
), xi AS (
 SELECT o.st, o.sid, o.raw, inv.id, public.context_ledger_record_trim(inv.contact_name) AS supplier,
  public.context_ledger_record_invoice_about(inv.invoice_number) AS number, inv.invoice_type, inv.total,
  public.context_ledger_record_invoice_money(
   inv.invoice_number, inv.xero_invoice_id, inv.contact_name, inv.total,
   inv.amount_paid, inv.amount_due, inv.raw_json) AS money
 FROM xi_one o
 JOIN xi_raw r ON r.st = o.st AND r.sid = o.sid AND r.raw = o.raw
 JOIN public.xero_invoices inv ON inv.id = r.id
 WHERE upper(public.context_ledger_record_trim(inv.status)) = 'PAID'
   AND (inv.fully_paid_on IS NULL OR inv.fully_paid_on <= (p_as_of AT TIME ZONE 'Australia/Perth')::date)
   AND coalesce(inv.created_at, inv.synced_at, '-infinity'::timestamptz) <= p_as_of
), bill AS (
 SELECT m.st, m.sid,
  jsonb_build_object('kind','paid_bill','table','xero_invoices','id', m.id::text, 'job_id', p_job_id::text,
   'supplier', m.supplier, 'amount', a.amt)
   || ((m.money - ARRAY['invoice_number', 'credits']::text[])
    || CASE WHEN m.money ? 'invoice_number'
      THEN jsonb_build_object('bill_number', m.money->'invoice_number') ELSE '{}'::jsonb END) AS rec,
  'paid_bill'::text AS kind, m.id::text AS ident, ''::text AS doc_id
 FROM xi m
 CROSS JOIN LATERAL (SELECT public.context_ledger_record_money(m.total) AS amt) a
 WHERE m.invoice_type = 'ACCPAY' AND m.supplier IS NOT NULL
   AND a.amt ~ '^[0-9]+\.[0-9]{2}$' AND a.amt <> '0.00'
), paid AS (
 SELECT m.st, m.sid,
  jsonb_build_object('kind','paid_invoice','table','xero_invoices','id', m.id::text, 'job_id', p_job_id::text,
   'number', m.number) || m.money AS rec,
  'paid_invoice'::text AS kind, m.id::text AS ident, ''::text AS doc_id
 FROM xi m
 WHERE m.invoice_type = 'ACCREC' AND m.number IS NOT NULL
), att AS (
 SELECT c.src_table AS st, c.src_id AS sid, c.rec, 'attachment'::text AS kind,
  c.rec->>'id' AS ident, c.rec->>'document_id' AS doc_id
 FROM public.context_ledger_comm_log_links(p_job_id, p_as_of, p_sources) c
 WHERE c.rec->>'id' IS NOT NULL AND c.rec->>'document_id' IS NOT NULL AND c.rec->>'about' IS NOT NULL
), hit AS (
 SELECT * FROM em
 UNION ALL SELECT * FROM jev
 UNION ALL SELECT * FROM sent
 UNION ALL SELECT * FROM bill
 UNION ALL SELECT * FROM paid
 UNION ALL SELECT * FROM att
), dedup AS (
 SELECT DISTINCT ON (h.st, h.sid, h.kind COLLATE "C", h.ident COLLATE "C", h.doc_id COLLATE "C")
  h.st, h.sid, h.rec, h.kind, h.ident, h.doc_id
 FROM hit h
 ORDER BY h.st, h.sid, h.kind COLLATE "C", h.ident COLLATE "C", h.doc_id COLLATE "C"
)
SELECT g.st, g.sid, jsonb_agg(g.rec ORDER BY g.kind COLLATE "C", g.ident COLLATE "C", g.doc_id COLLATE "C")
FROM dedup g
GROUP BY g.st, g.sid
$fn$;

COMMENT ON FUNCTION public.context_ledger_evidence_record_links(uuid, timestamptz, jsonb) IS
 'Ledger packet records (20261018120000): the records array for each worded source, built only from stored ids. No row when a source has no link the reader would accept. Send recipient fields (20261019140000): a system email copies email_events.recipient under recipient, and an invoice.emailed row copies detail_json.to under to, when that stored value is one email address, plus a contact id already stored on the row. A sent document copies its id and quote or invoice number, and a recipient, email ids and delivery status from rows that name that document. A paid invoice copies xero id, invoice number, total, paid, owing, credits and payments. A paid bill copies xero id, bill number, supplier, total, paid, owing and payments.';

-- Down for 20261019140000. Restores the 20261018120000 record-link function
-- and drops the helpers this migration added. No column was added.
--
-- No transaction wrapper. scripts/apply-pending-migrations.sh refuses a pending
-- migration that contains BEGIN, COMMIT, ROLLBACK or START TRANSACTION.

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
  jsonb_build_object('kind','system_email','table','email_events','id', e.id::text, 'job_id', p_job_id::text,
   'email_type', et.t, 'status', lower(btrim(e.status)), 'about', ab.a, 'system', true) AS rec,
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
  jsonb_build_object('kind','job_event','table','job_events','id', je.id::text, 'job_id', p_job_id::text,
   'event_type', public.context_ledger_record_trim(je.event_type), 'about', ab.a) AS rec,
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
 SELECT i.st, i.sid,
  jsonb_build_object('kind','sent_document','table','job_documents','id', d.id::text, 'job_id', p_job_id::text,
   'about', public.context_ledger_record_link_about(d.quote_number)) AS rec,
  'sent_document'::text AS kind, d.id::text AS ident, ''::text AS doc_id
 FROM docs i
 JOIN public.job_documents d ON d.id = i.document_id AND d.job_id = p_job_id
 WHERE d.sent_at IS NOT NULL AND d.sent_at <= p_as_of
   AND public.context_ledger_record_link_about(d.quote_number) IS NOT NULL
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
  public.context_ledger_record_invoice_about(inv.invoice_number) AS number, inv.invoice_type, inv.total
 FROM xi_one o
 JOIN xi_raw r ON r.st = o.st AND r.sid = o.sid AND r.raw = o.raw
 JOIN public.xero_invoices inv ON inv.id = r.id
 WHERE upper(public.context_ledger_record_trim(inv.status)) = 'PAID'
   AND (inv.fully_paid_on IS NULL OR inv.fully_paid_on <= (p_as_of AT TIME ZONE 'Australia/Perth')::date)
   AND coalesce(inv.created_at, inv.synced_at, '-infinity'::timestamptz) <= p_as_of
), bill AS (
 SELECT m.st, m.sid,
  jsonb_build_object('kind','paid_bill','table','xero_invoices','id', m.id::text, 'job_id', p_job_id::text,
   'supplier', m.supplier, 'amount', a.amt) AS rec,
  'paid_bill'::text AS kind, m.id::text AS ident, ''::text AS doc_id
 FROM xi m
 CROSS JOIN LATERAL (SELECT public.context_ledger_record_money(m.total) AS amt) a
 WHERE m.invoice_type = 'ACCPAY' AND m.supplier IS NOT NULL
   AND a.amt ~ '^[0-9]+\.[0-9]{2}$' AND a.amt <> '0.00'
), paid AS (
 SELECT m.st, m.sid,
  jsonb_build_object('kind','paid_invoice','table','xero_invoices','id', m.id::text, 'job_id', p_job_id::text,
   'number', m.number) AS rec,
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
 'Ledger packet records (20261018120000): the records array for each worded source, built only from stored ids. No row when a source has no link the reader would accept.';

DROP FUNCTION IF EXISTS public.context_ledger_record_invoice_money(text, text, text, numeric, numeric, numeric, jsonb);
DROP FUNCTION IF EXISTS public.context_ledger_record_xero_date(text);
DROP FUNCTION IF EXISTS public.context_ledger_record_email(text);
DROP FUNCTION IF EXISTS public.context_ledger_record_contact(text);

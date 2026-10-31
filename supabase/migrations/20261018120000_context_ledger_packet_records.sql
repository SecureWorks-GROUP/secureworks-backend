
-- Ledger packet records (20261018120000).
-- context_ledger_packet stays ledger-packet-v1. Evidence rows gain an optional
-- records array; every earlier key is unchanged and the key is left off when
-- there is nothing to cite. Held rows are not evidence and carry none.
-- A supplier or event_type is emitted only after the same trim JavaScript
-- uses, and a communications_log link is found from the source ids, not by
-- scanning every attached row first.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $guard$
DECLARE problems text[] := '{}'; live text; x record; f text;
BEGIN
 SELECT md5(p.prosrc) INTO live FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.context_ledger_packet(uuid,timestamptz,timestamptz)');
 IF live IS NULL OR live NOT IN ('e2ccc5450117a4e36b30df104752d1cd', '4d99c79138a3b9de41b2957145addeb2') THEN
  problems := problems || format('context_ledger_packet md5 %s', coalesce(live, '<missing>'));
 END IF;
 FOREACH f IN ARRAY ARRAY[
  'public.context_ledger_evidence_rows(uuid[],timestamptz)',
  'public.context_ledger_row_elsewhere(uuid,text,uuid)',
  'public.context_ledger_party_keys(text[],text[],text[])',
  'public.context_ledger_current_generation(uuid)',
  'public.context_held_notes_on()',
  'public.context_ledger_item_held_now(uuid,jsonb,timestamptz)',
  'public.context_ledger_held_rows(uuid[],timestamptz)',
  'public.context_ledger_held_placed_copy(uuid)',
  'public.context_ledger_siblings(uuid,timestamptz)'] LOOP
  IF to_regprocedure(f) IS NULL THEN problems := problems || format('%s missing', f); END IF;
 END LOOP;
 FOR x IN SELECT * FROM (VALUES
  ('email_events','id'), ('email_events','job_id'), ('email_events','email_type'),
  ('email_events','status'), ('email_events','sent_at'), ('email_events','metadata'),
  ('job_events','id'), ('job_events','job_id'), ('job_events','event_type'),
  ('job_events','detail_json'), ('job_events','created_at'),
  ('job_documents','id'), ('job_documents','job_id'), ('job_documents','quote_number'),
  ('job_documents','sent_at'),
  ('xero_invoices','id'), ('xero_invoices','job_id'), ('xero_invoices','xero_invoice_id'),
  ('xero_invoices','contact_name'), ('xero_invoices','invoice_number'),
  ('xero_invoices','invoice_type'), ('xero_invoices','status'), ('xero_invoices','total'),
  ('xero_invoices','fully_paid_on'), ('xero_invoices','created_at'), ('xero_invoices','synced_at'),
  ('business_events','id'), ('business_events','source_table'), ('business_events','source_id'),
  ('business_events','payload'), ('business_events','metadata')
 ) AS v(tbl, col) LOOP
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = x.tbl AND c.column_name = x.col) THEN
   problems := problems || format('%s.%s missing', x.tbl, x.col);
  END IF;
 END LOOP;
 FOR x IN SELECT p.oid::regprocedure::text AS sig, coalesce(obj_description(p.oid, 'pg_proc'), '') AS c
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('context_ledger_record_invoice_about', 'context_ledger_record_link_about',
    'context_ledger_record_uuid', 'context_ledger_record_trim', 'context_ledger_record_money',
    'context_ledger_comm_log_links', 'context_ledger_evidence_record_links') LOOP
  IF x.c NOT LIKE 'Ledger packet records (20261018120000)%' THEN
   problems := problems || format('%s exists and is not this migration''s', x.sig);
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_ledger_packet_records_preimage_mismatch: %', array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. About keys the ledger reader accepts. Nothing is invented: a value that
-- does not normalise is null, and the link that needed it is left off.
CREATE OR REPLACE FUNCTION public.context_ledger_record_invoice_about(p_raw text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
 SELECT CASE
  WHEN lower(btrim(p_raw)) ~ '^invoice:inv-[0-9]{1,8}$' THEN lower(btrim(p_raw))
  WHEN btrim(p_raw) ~* '^inv-?[0-9]{1,8}$'
   THEN 'invoice:inv-' || substring(btrim(p_raw) FROM '[0-9]{1,8}')
  ELSE NULL
 END
$fn$;
COMMENT ON FUNCTION public.context_ledger_record_invoice_about(text) IS
 'Ledger packet records (20261018120000): a paid invoice number the ledger reader accepts (invoice:inv- and 1 to 8 digits), or null.';

CREATE OR REPLACE FUNCTION public.context_ledger_record_link_about(p_raw text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
 SELECT CASE
  WHEN public.context_ledger_record_invoice_about(p_raw) IS NOT NULL
   THEN public.context_ledger_record_invoice_about(p_raw)
  WHEN length(lower(btrim(p_raw))) <= 80
   AND lower(btrim(p_raw)) ~ '^[a-z0-9]+(:[a-z0-9][a-z0-9-]{0,60})?$'
   THEN lower(btrim(p_raw))
  WHEN btrim(p_raw) ~* '^q-?[0-9]{1,8}$'
   THEN 'quote:q-' || substring(btrim(p_raw) FROM '[0-9]{1,8}')
  WHEN btrim(p_raw) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   THEN 'booking:' || btrim(p_raw)
  ELSE NULL
 END
$fn$;
COMMENT ON FUNCTION public.context_ledger_record_link_about(text) IS
 'Ledger packet records (20261018120000): an about key the ledger reader accepts, taken from a stored quote number, invoice number or booking date. Free text stays null.';

CREATE OR REPLACE FUNCTION public.context_ledger_record_uuid(p_raw text)
RETURNS uuid
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
 SELECT CASE
  WHEN btrim(p_raw) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   THEN btrim(p_raw)::uuid
  ELSE NULL
 END
$fn$;
COMMENT ON FUNCTION public.context_ledger_record_uuid(text) IS
 'Ledger packet records (20261018120000): a stored uuid, or null when the text is not one. Never casts a token.';

-- JavaScript String.prototype.trim, not btrim. btrim strips only U+0020, and a
-- supplier or event_type made of a tab, newline or NBSP was emitted and then
-- rejected the whole packet. The class is the ECMA-262 WhiteSpace and
-- LineTerminator set: HT LF VT FF CR SP, NBSP, Ogham, U+2000-U+200A, line and
-- paragraph separators, narrow NBSP, medium mathematical space, ideographic
-- space, and BOM. U+200B is not in that set and is left in place.
CREATE OR REPLACE FUNCTION public.context_ledger_record_trim(p_raw text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
 SELECT nullif(regexp_replace(
  p_raw,
  U&'^[\0009\000A\000B\000C\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+|[\0009\000A\000B\000C\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+$',
  '',
  'g'), '')
$fn$;
COMMENT ON FUNCTION public.context_ledger_record_trim(text) IS
 'Ledger packet records (20261018120000): JavaScript trim. Empty after that trim is null, and the trimmed text is what a link emits.';

-- numeric(12,2) is ten digits before the point. to_char with nine digit
-- positions overflows those to hashes and the link disappears. round keeps
-- two decimal places and cannot overflow the text.
CREATE OR REPLACE FUNCTION public.context_ledger_record_money(p_total numeric)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
 SELECT CASE
  WHEN p_total IS NULL OR p_total <= 0 THEN NULL
  ELSE round(p_total, 2)::text
 END
$fn$;
COMMENT ON FUNCTION public.context_ledger_record_money(numeric) IS
 'Ledger packet records (20261018120000): a positive amount with two decimal places, or null. Ten-digit totals stay digits.';

-- 2. communications_log is not in this repository. When a deployment has the
-- table, an attachment link needs its own row id, has_attachments true, a uuid
-- document column, and that document on this job with an about key. No table,
-- no boolean, or no document id: no link, and no id is invented.
-- The lookup starts from the packet's source ids. A named communications_log
-- id is a primary-key read. A reverse pointer is that source id on
-- business_event_id or inbox_event_id. The job filter is the document join.
-- Joining every attached row first, then filtering, walked the whole table
-- once per source.
CREATE OR REPLACE FUNCTION public.context_ledger_comm_log_links(p_job_id uuid, p_as_of timestamptz, p_sources jsonb)
RETURNS TABLE(src_table text, src_id uuid, rec jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE
 doc_col text; has_be boolean; has_inbox boolean; has_time boolean;
 time_sql text := ''; rev_sql text := ''; q text;
BEGIN
 IF to_regclass('public.communications_log') IS NULL THEN RETURN; END IF;
 IF NOT EXISTS (
   SELECT 1 FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'communications_log'
     AND c.column_name = 'id' AND c.udt_name = 'uuid')
  OR NOT EXISTS (
   SELECT 1 FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'communications_log'
     AND c.column_name = 'has_attachments' AND c.udt_name = 'bool') THEN
  RETURN;
 END IF;
 SELECT c.column_name INTO doc_col
 FROM information_schema.columns c
 WHERE c.table_schema = 'public' AND c.table_name = 'communications_log'
   AND c.udt_name = 'uuid'
   AND c.column_name IN ('document_id', 'job_document_id', 'attachment_document_id')
 ORDER BY CASE c.column_name WHEN 'document_id' THEN 1 WHEN 'job_document_id' THEN 2 ELSE 3 END
 LIMIT 1;
 IF doc_col IS NULL THEN RETURN; END IF;
 SELECT EXISTS (
   SELECT 1 FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'communications_log'
     AND c.column_name = 'business_event_id' AND c.udt_name = 'uuid')
 INTO has_be;
 SELECT EXISTS (
   SELECT 1 FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'communications_log'
     AND c.column_name = 'inbox_event_id' AND c.udt_name = 'uuid')
 INTO has_inbox;
 SELECT EXISTS (
   SELECT 1 FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'communications_log'
     AND c.column_name = 'created_at' AND c.udt_name = 'timestamptz')
 INTO has_time;
 IF has_time THEN
  time_sql := ' AND c.created_at IS NOT NULL AND c.created_at <= $2';
 END IF;
 IF has_be THEN
  rev_sql := rev_sql || format($rev$
   UNION ALL
   SELECT s.st, s.sid, c.id, c.%1$I AS doc
   FROM src s
   JOIN public.communications_log c ON c.business_event_id = s.sid
   WHERE s.st = 'business_events' AND c.has_attachments IS TRUE AND c.%1$I IS NOT NULL%2$s$rev$,
   doc_col, time_sql);
 END IF;
 IF has_inbox THEN
  rev_sql := rev_sql || format($rev$
   UNION ALL
   SELECT s.st, s.sid, c.id, c.%1$I AS doc
   FROM src s
   JOIN public.communications_log c ON c.inbox_event_id = s.sid
   WHERE s.st = 'inbox_events' AND c.has_attachments IS TRUE AND c.%1$I IS NOT NULL%2$s$rev$,
   doc_col, time_sql);
 END IF;
 q := format($q$
WITH src AS (
 SELECT el->>'table' AS st, public.context_ledger_record_uuid(el->>'id') AS sid
 FROM jsonb_array_elements(coalesce($3, '[]'::jsonb)) el
 WHERE el->>'table' IN ('business_events', 'inbox_events')
   AND public.context_ledger_record_uuid(el->>'id') IS NOT NULL
), named AS (
 SELECT s.st, s.sid, public.context_ledger_record_uuid(b.payload->>'communications_log_id') AS cid
 FROM src s
 JOIN public.business_events b ON s.st = 'business_events' AND b.id = s.sid
 WHERE public.context_ledger_record_uuid(b.payload->>'communications_log_id') IS NOT NULL
 UNION ALL
 SELECT s.st, s.sid, public.context_ledger_record_uuid(b.metadata->>'communications_log_id')
 FROM src s
 JOIN public.business_events b ON s.st = 'business_events' AND b.id = s.sid
 WHERE public.context_ledger_record_uuid(b.metadata->>'communications_log_id') IS NOT NULL
 UNION ALL
 SELECT s.st, s.sid, public.context_ledger_record_uuid(b.source_id)
 FROM src s
 JOIN public.business_events b ON s.st = 'business_events' AND b.id = s.sid
 WHERE lower(btrim(b.source_table)) = 'communications_log'
   AND public.context_ledger_record_uuid(b.source_id) IS NOT NULL
 UNION ALL
 SELECT s.st, s.sid, public.context_ledger_record_uuid(e->>'id')
 FROM src s
 JOIN public.business_events b ON s.st = 'business_events' AND b.id = s.sid
 CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(b.payload->'related_entities') = 'array' THEN b.payload->'related_entities' ELSE '[]'::jsonb END) e
 WHERE lower(btrim(e->>'type')) = 'communications_log'
   AND public.context_ledger_record_uuid(e->>'id') IS NOT NULL
 UNION ALL
 SELECT s.st, s.sid, public.context_ledger_record_uuid(e->>'id')
 FROM src s
 JOIN public.business_events b ON s.st = 'business_events' AND b.id = s.sid
 CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(b.metadata->'related_entities') = 'array' THEN b.metadata->'related_entities' ELSE '[]'::jsonb END) e
 WHERE lower(btrim(e->>'type')) = 'communications_log'
   AND public.context_ledger_record_uuid(e->>'id') IS NOT NULL
), hit AS (
 SELECT n.st, n.sid, c.id AS cid, c.%1$I AS doc
 FROM named n
 JOIN public.communications_log c ON c.id = n.cid
 WHERE c.has_attachments IS TRUE AND c.%1$I IS NOT NULL%2$s
 %3$s
)
SELECT h.st, h.sid, jsonb_build_object(
 'kind', 'attachment', 'table', 'job_documents',
 'id', h.cid::text, 'job_id', $1::text,
 'document_id', h.doc::text,
 'about', public.context_ledger_record_link_about(d.quote_number))
FROM hit h
JOIN public.job_documents d ON d.id = h.doc AND d.job_id = $1
 AND public.context_ledger_record_link_about(d.quote_number) IS NOT NULL
$q$, doc_col, time_sql, rev_sql);
 RETURN QUERY EXECUTE q USING p_job_id, p_as_of, p_sources;
END
$fn$;
COMMENT ON FUNCTION public.context_ledger_comm_log_links(uuid, timestamptz, jsonb) IS
 'Ledger packet records (20261018120000): attachment links from communications_log when that table exists. The packet''s source ids drive the read (primary key, or business_event_id / inbox_event_id). Absent table: no rows.';

-- 3. One call per packet. A link is emitted only from a stored pointer on the
-- worded row, or from a stored pointer on the record back to that row.
-- Another job, another amount, an unsent document, a human forward and a
-- pointer that matches two invoices produce nothing. records is omitted by
-- the caller when this returns no row.
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

CREATE OR REPLACE FUNCTION public.context_ledger_packet(p_job_id uuid, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_as_of timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE jb record; v_job jsonb; v_parties jsonb; v_evidence jsonb; v_open jsonb; v_until timestamptz; v_rows integer;
 v_truncated integer; v_dups integer; v_as_of timestamptz; v_gen uuid; v_pe text[]; v_pp text[]; v_pc text[];
 v_held jsonb; v_on boolean;
BEGIN
 v_as_of := coalesce(p_as_of, now());
 v_on := public.context_held_notes_on();
 SELECT j.id, j.job_number, j.type::text AS type, j.status::text AS status, j.client_name, j.site_suburb, j.created_at,
  nullif(btrim(j.ghl_contact_id), '') AS ghl_contact_id, j.client_email, j.client_phone
 INTO jb FROM public.jobs j WHERE j.id = p_job_id;
 IF jb.id IS NULL THEN RAISE EXCEPTION 'context_ledger_packet_job_not_found'; END IF;
 v_job := jsonb_build_object('id', jb.id, 'job_number', jb.job_number, 'type', jb.type, 'status', jb.status,
  'client_name', jb.client_name, 'site_suburb', jb.site_suburb, 'created_at', jb.created_at,
  'customer_contact_ref', jb.ghl_contact_id);
 -- Parties: the job's own client, then every other party on job_contacts
 -- (the owner row that repeats the job's client is not listed twice; its
 -- contact details join the client's). Each carries match_keys, so the reader
 -- can tell whether our message reached that party (never printed).
 SELECT array_agg(c.client_email), array_agg(c.client_phone), array_agg(nullif(btrim(c.ghl_contact_id), ''))
 INTO v_pe, v_pp, v_pc
 FROM public.job_contacts c
 WHERE c.job_id = p_job_id AND c.removed_at IS NULL
  AND coalesce(c.is_primary, false) AND lower(coalesce(c.client_name, '')) = lower(coalesce(jb.client_name, ''));
 SELECT jsonb_build_array(jsonb_build_object('name', jb.client_name, 'role', 'customer', 'contact_ref', jb.ghl_contact_id, 'label', 'job_client',
   'match_keys', public.context_ledger_party_keys(ARRAY[jb.client_email] || v_pe, ARRAY[jb.client_phone] || v_pp,
    ARRAY[jb.ghl_contact_id] || v_pc)))
  -- A party's role: a neighbour (contact_type neighbour, neighbour_b and so on) is a
  -- third party, never the customer, labelled neighbour (and "pays a share" when
  -- its share or invoiced amount says so); the primary contact is the customer;
  -- any other keeps its contact_type, else unknown.
  || coalesce(jsonb_agg(jsonb_build_object('name', c.client_name,
   'role', CASE WHEN lower(coalesce(c.contact_type, '')) LIKE 'neighbour%' THEN 'third_party'
                WHEN coalesce(c.is_primary, false) OR lower(coalesce(c.contact_type, '')) = 'primary' THEN 'customer'
                ELSE coalesce(nullif(btrim(c.contact_type), ''), 'unknown') END,
   'contact_ref', coalesce(nullif(btrim(c.ghl_contact_id), ''), lower(nullif(btrim(c.client_email), ''))),
   'label', CASE WHEN lower(coalesce(c.contact_type, '')) LIKE 'neighbour%'
                 THEN 'neighbour' || CASE WHEN coalesce(c.share_percentage, 0) > 0 OR coalesce(c.amount_invoiced, 0) > 0
                                          THEN ', pays a share' ELSE '' END
                 ELSE coalesce(c.contact_label, c.contact_type) END,
   'match_keys', public.context_ledger_party_keys(ARRAY[c.client_email], ARRAY[c.client_phone], ARRAY[nullif(btrim(c.ghl_contact_id), '')]))
   ORDER BY c.is_primary DESC NULLS LAST, c.created_at, c.id), '[]'::jsonb)
 INTO v_parties
 FROM public.job_contacts c
 WHERE c.job_id = p_job_id AND c.removed_at IS NULL
  AND NOT (coalesce(c.is_primary, false) AND lower(coalesce(c.client_name, '')) = lower(coalesce(jb.client_name, '')));
 -- Evidence: copies left out. In update mode: the rows that landed after
 -- p_since; every already-read row after the earliest of them (so a late row,
 -- such as old mail placed on the job today, is read with what followed it);
 -- and the six rows before it. Each row says whether it was already read.
 WITH r AS (
  SELECT * FROM public.context_ledger_evidence_rows(ARRAY[p_job_id], v_as_of)
 ), u AS (
  SELECT * FROM r WHERE r.copy_of IS NULL
 ), firstnew AS (
  SELECT u.at, u.src_id FROM u WHERE p_since IS NOT NULL AND u.landed_at > p_since ORDER BY u.at, u.src_id LIMIT 1
 ), ctx AS (
  SELECT u.src_id FROM u, firstnew f
  WHERE (u.at, u.src_id) < (f.at, f.src_id) AND NOT (u.landed_at > p_since)
  ORDER BY u.at DESC, u.src_id DESC LIMIT 6
 ), sel AS (
  SELECT u.*, CASE WHEN u.kind IN ('call.transcript_completed', 'document.text_extracted') THEN 6000 ELSE 3000 END AS lim
  FROM u WHERE p_since IS NULL OR u.landed_at > p_since OR u.src_id IN (SELECT ctx.src_id FROM ctx)
   OR EXISTS (SELECT 1 FROM firstnew f WHERE (u.at, u.src_id) > (f.at, f.src_id))
 ), links AS (
  SELECT l.src_table, l.src_id, l.records
  FROM public.context_ledger_evidence_record_links(p_job_id, v_as_of,
   (SELECT coalesce(jsonb_agg(jsonb_build_object('table', s.src_table, 'id', s.src_id)), '[]'::jsonb) FROM sel s)) l
 )
 SELECT coalesce(jsonb_agg((jsonb_build_object('table', sel.src_table, 'id', sel.src_id, 'at', sel.at, 'recorded_at', sel.landed_at,
   'channel', sel.channel, 'kind', sel.kind, 'direction', sel.direction, 'sender_role', sel.sender_role,
   'recipient_role', sel.recipient_role, 'audience', sel.audience, 'counterpart_role', sel.counterpart_role,
   'role_basis', sel.role_basis, 'sender', sel.sender, 'recipient', sel.recipient, 'ours', sel.ours, 'automated', sel.automated, 'subject', sel.subject,
   'already_read', p_since IS NOT NULL AND sel.landed_at <= p_since, 'placed_on', sel.placed_on, 'has_transcript', sel.has_transcript,
   -- (ledger reader fixes, 20261007150000) a transcript says whose call it is as true, false or
   -- "unknown" (neither its call row on this job nor its own stamp on the job's contact decides),
   -- never a bare null, which readers took for "not this job's customer"; and each row says whether
   -- its own placement or role basis makes it someone else's (the item check's rule), and why
   'call_customer', CASE WHEN sel.kind = 'call.transcript_completed' THEN coalesce(to_jsonb(sel.call_customer), '"unknown"'::jsonb)
                         ELSE to_jsonb(sel.call_customer) END,
   'elsewhere', public.context_ledger_row_elsewhere(p_job_id, sel.src_table, sel.src_id),
   'text', left(sel.body, sel.lim))
   || CASE WHEN links.records IS NOT NULL THEN jsonb_build_object('records', links.records) ELSE '{}'::jsonb END)
   ORDER BY sel.at, sel.src_id), '[]'::jsonb),
  count(*)::integer, (count(*) FILTER (WHERE length(sel.body) > sel.lim))::integer,
  (SELECT max(r.landed_at) FROM r), (SELECT count(*) FILTER (WHERE r.copy_of IS NOT NULL) FROM r)::integer
 INTO v_evidence, v_rows, v_truncated, v_until, v_dups
 FROM sel
 LEFT JOIN links ON links.src_table = sel.src_table AND links.src_id = sel.src_id;
 -- Items the reader must know: in update mode the current generation's open,
 -- disputed and in-force items; otherwise the live generation's person-locked
 -- items (a rebuild must not write them again).
 IF p_since IS NOT NULL THEN
  v_gen := public.context_ledger_current_generation(p_job_id);
 ELSE
  SELECT g.id INTO v_gen FROM public.context_ledger_generations g WHERE g.job_id = p_job_id AND g.status = 'live';
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('item_key', i.item_key, 'item_type', i.item_type, 'status', i.status, 'what', i.what,
   'about_key', i.about_key, 'phase', i.phase, 'from_role', i.from_role, 'to_role', i.to_role, 'opened_at', i.opened_at,
   'closes_on', i.closes_on, 'opened_by', i.opened_by, 'person_locked', i.person_locked)
   -- (held notes, 20261015100000) an item a held message still holds up is marked job not certain
   || CASE WHEN i.job_not_certain AND public.context_ledger_item_held_now(p_job_id, i.opened_by, v_as_of)
           THEN jsonb_build_object('job_certain', false, 'certainty', 'job_not_certain') ELSE '{}'::jsonb END
   ORDER BY i.opened_at, i.item_key COLLATE "C"), '[]'::jsonb)
 INTO v_open FROM public.context_ledger_items i
 WHERE v_gen IS NOT NULL AND i.generation_id = v_gen
  AND CASE WHEN p_since IS NOT NULL THEN i.status IN ('open', 'disputed', 'info') ELSE i.person_locked END;
 -- (held messages, 20261012100000) The messages placed on no job that could be this job's
 -- (context_ledger_held_rows: the ladder left them unplaced with this job among their candidates,
 -- nearly always because the customer has several jobs). They are context for the reader, marked
 -- job not certain: never evidence rows, never counted, never citable (the citation check still
 -- refuses them as off the job), and their placement is not read as this job's. A rebuild is given
 -- the newest 40; an update the newest 40 that landed after p_since and, when there is one, the 6
 -- newest it was given before, to read them by. Oldest first; text capped at 6,000 characters for
 -- a transcript or document text and 3,000 otherwise, as for placed evidence; cuts are explicit.
 WITH h AS (
  SELECT * FROM public.context_ledger_held_rows(ARRAY[p_job_id], v_as_of)
 ), fresh AS (
  SELECT h.*, false AS already_read FROM h WHERE p_since IS NULL OR h.landed_at > p_since
  ORDER BY h.at DESC, h.src_id DESC LIMIT 40
 ), ctx AS (
  SELECT h.*, true AS already_read FROM h
  WHERE p_since IS NOT NULL AND NOT (h.landed_at > p_since) AND EXISTS (SELECT 1 FROM fresh)
  ORDER BY h.at DESC, h.src_id DESC LIMIT 6
 ), sel AS (
  SELECT * FROM fresh UNION ALL SELECT * FROM ctx
 )
 SELECT jsonb_build_object('certainty', 'job_not_certain',
  'total', (SELECT count(*) FROM h),
  'new', (SELECT count(*) FROM h WHERE p_since IS NULL OR h.landed_at > p_since),
  'not_shown', (SELECT count(*) FROM h) - (SELECT count(*) FROM sel),
  'rows', coalesce((SELECT jsonb_agg(jsonb_build_object('table', sel.src_table, 'id', sel.src_id, 'at', sel.at,
     'recorded_at', sel.landed_at, 'channel', sel.channel, 'kind', sel.kind, 'direction', sel.direction,
     'sender_role', sel.sender_role, 'recipient_role', sel.recipient_role, 'audience', sel.audience,
     'counterpart_role', sel.counterpart_role, 'role_basis', sel.role_basis, 'sender', sel.sender, 'recipient', sel.recipient,
     'ours', sel.ours, 'automated', sel.automated, 'subject', sel.subject, 'already_read', sel.already_read,
     'placed_on', 'none', 'certainty', 'job_not_certain', 'from_this_customer', sel.same_contact,
     'held_rule', sel.held_rule, 'candidate_jobs', sel.candidate_jobs, 'other_jobs', to_jsonb(sel.other_jobs),
     'text', left(sel.body, CASE WHEN sel.kind IN ('call.transcript_completed', 'document.text_extracted') THEN 6000 ELSE 3000 END),
     'cut', length(sel.body) > CASE WHEN sel.kind IN ('call.transcript_completed', 'document.text_extracted') THEN 6000 ELSE 3000 END)
     -- (held notes, 20261015100000) with the switch on, whether the reader may cite it to open or
     -- support an open item marked job not certain: never when a copy of it is placed on a job
     -- (cite that copy) or its call is on another job
     || CASE WHEN v_on THEN jsonb_build_object('citable', NOT EXISTS (SELECT 1 FROM public.context_ledger_held_placed_copy(sel.src_id) pc
                                                                    WHERE pc.how = 'copy' OR pc.copy_job_id <> p_job_id))
             ELSE '{}'::jsonb END
     ORDER BY sel.at, sel.src_id) FROM sel), '[]'::jsonb))
  -- (held notes) with the switch on, the section says its rows may be cited, marked job not certain
  || CASE WHEN v_on THEN jsonb_build_object('citable', 'job_not_certain') ELSE '{}'::jsonb END
 INTO v_held;
 RETURN jsonb_build_object('version', 'ledger-packet-v1', 'job', v_job, 'parties', v_parties, 'evidence', v_evidence,
  'evidence_until', v_until, 'evidence_rows', v_rows, 'truncated_rows', v_truncated, 'duplicates_collapsed', v_dups,
  'since', p_since, 'as_of', v_as_of, 'open_items', v_open,
  -- (ledger reader fixes, 20261007150000) the same client's and the same work order's other jobs,
  -- with what was quoted and billed there
  'siblings', public.context_ledger_siblings(p_job_id, v_as_of),
  -- (held messages, 20261012100000) the messages on no job that could be this job's, job not certain
  'held', v_held);
END $function$;
COMMENT ON FUNCTION public.context_ledger_packet(uuid,timestamptz,timestamptz) IS
 'Context ledger store (20261006013000), ledger reader fixes (20261007150000): (held messages, 20261012100000) still ledger-packet-v1, with one field added: held {certainty job_not_certain, total, new, not_shown, rows}: the messages placed on no job that could be this job''s (context_ledger_held_rows: unplaced or waiting on the placement review with this job among their stored candidates, nearly always because the customer has several jobs; worded, a message kind, never retracted, a copy or status-only), as of the packet''s as_of. Context only, marked job not certain: never evidence rows, never in evidence_rows or evidence_until, never citable (the citation check still refuses them, citation_off_job), and nothing about their placement is changed or read as this job''s. total: all of them; new: those that landed after since (all on a rebuild); rows, oldest first: a rebuild''s newest 40, or an update''s newest 40 new ones and, when there is one, the 6 newest given before (already_read true); each row as an evidence row (table, id, at, recorded_at, channel, kind, direction, the stored role fields, sender, recipient, ours, automated, subject) with placed_on none, certainty job_not_certain, from_this_customer (the row''s CRM contact is the job''s, or its sender address the job''s client email), held_rule (the placement rule that held it), candidate_jobs (how many jobs it could belong to), other_jobs (the other candidates'' job numbers, C order) and text (capped at 3,000 characters for a transcript or document text, 1,500 otherwise); not_shown: how many of total are not in rows. Earlier (ledger reader fixes) still ledger-packet-v1, with fields added: each transcript''s call_customer is true, false or the string unknown (neither its call row on this job nor its own stamp on the job''s contact decides), never a bare null; each evidence row carries elsewhere, the reason it is someone else''s (context_ledger_row_elsewhere: role_basis:<basis> when its own stamp names another job''s customer or party or a lead, call_not_customer when its call row''s on this job does, call_on_other_job, names_other_job:<number>) or null, never on the customer''s own words or a stamp naming our own people, a supplier, a builder, a council, a party on this job or nobody (second review, 8 Oct); only role_basis and call_not_customer carry an item that says a row is someone else''s (elsewhere_unsupported); and siblings (context_ledger_siblings as of the packet''s as_of): the same client''s and the same work order''s other jobs with their quotes sent and invoices issued, context only. Earlier: ledger-packet-v1, the reader''s whole view of a job except the record text: job, parties (the job client and a primary contact role customer, a neighbour role third_party labelled neighbour, others their contact_type or unknown; each with match_keys: emails, phones'' last 9 digits), evidence (context_ledger_evidence_rows without copies, oldest first, text capped at 6,000 characters for transcripts and document text and 3,000 otherwise; each row with already_read, placed_on and, on a call log, has_transcript, call_customer on transcripts), evidence_until (newest recorded time seen), evidence_rows, truncated_rows, duplicates_collapsed, open_items (each with phase, closes_on and opened_by as stored). With p_since: rows recorded after it, every already-read row after the earliest of them, and the six before it, and the current generation''s open, disputed and in-force items; without: the live generation''s person-locked items. The judge asks for a rebuild (late_evidence) instead when the earliest new row is more than 14 days older than evidence_until or more than 150 already-read rows follow it. Role fields are the stored party_roles stamp, never invented. Service role only. Story card causes (20261014120000): held text uses the same 6000/3000 limits as placed evidence with an explicit cut flag. Held notes (20261015100000): an open item a held message still holds up carries job_certain false and certainty job_not_certain; while the switch is on, held carries citable job_not_certain and each held row citable (false when a copy is placed on a job or its call is on another job). Off: unchanged. Ledger packet records (20261018120000): an evidence row carries records only when a stored id on that row, or on the record, names a real row of one of the six link shapes the ledger reader accepts; the key is left off when there are none, and every earlier key is unchanged. Held rows are not evidence and carry none.';


REVOKE ALL ON FUNCTION public.context_ledger_record_invoice_about(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_record_link_about(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_record_uuid(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_record_trim(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_record_money(numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_comm_log_links(uuid, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_evidence_record_links(uuid, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_packet(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_record_invoice_about(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_record_link_about(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_record_uuid(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_record_trim(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_record_money(numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_comm_log_links(uuid, timestamptz, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_evidence_record_links(uuid, timestamptz, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_packet(uuid, timestamptz, timestamptz) TO service_role;

-- The 100k-row proof is under 500 ms without an index. These partial indexes
-- are for a deployment that already has communications_log; this repository
-- does not create that table, so the block does nothing here. Not CONCURRENTLY:
-- this migration runs inside a transaction.
DO $idx$
DECLARE doc_col text;
BEGIN
 IF to_regclass('public.communications_log') IS NULL THEN RETURN; END IF;
 IF NOT EXISTS (
   SELECT 1 FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'communications_log'
     AND c.column_name = 'has_attachments' AND c.udt_name = 'bool') THEN
  RETURN;
 END IF;
 SELECT c.column_name INTO doc_col
 FROM information_schema.columns c
 WHERE c.table_schema = 'public' AND c.table_name = 'communications_log'
   AND c.udt_name = 'uuid'
   AND c.column_name IN ('document_id', 'job_document_id', 'attachment_document_id')
 ORDER BY CASE c.column_name WHEN 'document_id' THEN 1 WHEN 'job_document_id' THEN 2 ELSE 3 END
 LIMIT 1;
 IF doc_col IS NULL THEN RETURN; END IF;
 IF EXISTS (
   SELECT 1 FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'communications_log'
     AND c.column_name = 'business_event_id' AND c.udt_name = 'uuid') THEN
  EXECUTE format(
   'CREATE INDEX IF NOT EXISTS communications_log_ledger_business_event_idx ON public.communications_log (business_event_id) WHERE has_attachments IS TRUE AND %I IS NOT NULL',
   doc_col);
 END IF;
 IF EXISTS (
   SELECT 1 FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'communications_log'
     AND c.column_name = 'inbox_event_id' AND c.udt_name = 'uuid') THEN
  EXECUTE format(
   'CREATE INDEX IF NOT EXISTS communications_log_ledger_inbox_event_idx ON public.communications_log (inbox_event_id) WHERE has_attachments IS TRUE AND %I IS NOT NULL',
   doc_col);
 END IF;
END $idx$;

COMMIT;

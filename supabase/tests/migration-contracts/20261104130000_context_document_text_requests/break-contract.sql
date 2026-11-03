-- Ship the ordinary due list without the interlock: the 20261005210000 body, which also lists
-- requested documents (and, on a NULL job, never matches their record). The contract's "the ordinary
-- due list showed a requested document" check must catch it.
CREATE OR REPLACE FUNCTION public.context_document_text_due(p_limit integer DEFAULT 20)
RETURNS TABLE (source_kind text, source_id uuid, job_id uuid, job_number text, file_name text, doc_type text, content_type text,
 storage_bucket text, storage_path text, storage_url text, pdf_url text, fingerprint text, doc_at timestamptz,
 capture_mode text, attempts integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT s.source_kind, s.source_id, s.job_id, s.job_number, s.file_name, s.doc_type, s.content_type,
  s.storage_bucket, s.storage_path, s.storage_url, s.pdf_url, s.fingerprint, s.doc_at,
  CASE WHEN s.doc_at>=now()-make_interval(hours=>(public.context_document_text_policy()->>'live_window_hours')::integer)
   THEN 'live' ELSE 'backfill' END,
  CASE WHEN t.outcome='pending' THEN t.attempts ELSE 0 END
 FROM public.context_document_text_sources() s
 LEFT JOIN public.context_document_texts t ON t.source_kind=s.source_kind AND t.source_id=s.source_id AND t.job_id=s.job_id
 WHERE t.id IS NULL
  OR (t.outcome='pending' AND t.next_at<=now())
  OR (t.outcome<>'pending' AND t.source_fingerprint<>s.fingerprint)
 ORDER BY s.doc_at DESC NULLS LAST, s.source_id
 LIMIT greatest(1,least(coalesce(p_limit,20),100))
$$;

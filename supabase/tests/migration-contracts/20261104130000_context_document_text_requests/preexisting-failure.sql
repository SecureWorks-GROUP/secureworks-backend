-- A sources body that is not production's pre-image (someone changed it since 3 Nov 2026): the
-- migration must refuse and name it rather than overwrite it.
CREATE OR REPLACE FUNCTION public.context_document_text_sources()
RETURNS TABLE (source_kind text, source_id uuid, job_id uuid, job_number text, file_name text, doc_type text, content_type text,
 storage_bucket text, storage_path text, storage_url text, pdf_url text, fingerprint text, doc_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT 'job_document'::text, d.id, d.job_id, NULL::text, d.file_name, d.type, NULL::text, NULL::text, NULL::text, d.storage_url, d.pdf_url,
  md5(coalesce(d.file_name,'')), d.created_at
 FROM public.job_documents d WHERE false
$$;

-- Before the rollback: one requested attachment read on no job (text and vision records), so the
-- rollback must delete them before job_id is NOT NULL again. The proof database is a copy.
DO $$
DECLARE e uuid; a uuid; fp text;
BEGIN
 INSERT INTO public.business_events(event_type,source,entity_type,entity_id,event_at,provider_message_id,channel,direction,payload,metadata)
 VALUES('supplier.email_in','outlook-mail-capture','email','x',now()-interval '6 days','email:<rb-off@fixture>','email','inbound',
  jsonb_build_object('body','Invoice attached.'),'{"capture_mode":"live"}') RETURNING id INTO e;
 INSERT INTO public.context_email_attachments(provider_message_id,attachment_key,business_event_id,file_name,content_type,size_bytes,sha256,storage_bucket,storage_path,status)
 VALUES('email:<rb-off@fixture>',repeat('d',64),e,'INV-RB.pdf','application/pdf',1000,repeat('d1',32),'context-email-attachments','rb/a.pdf','stored') RETURNING id INTO a;
 INSERT INTO public.context_document_text_requests(source_kind,source_id,requested_by,reason) VALUES('email_attachment',a,'contract','rollback fixture');
 fp:=(SELECT s.fingerprint FROM public.context_document_text_sources() s WHERE s.source_id=a);
 PERFORM public.record_context_document_text(jsonb_build_object('source_kind','email_attachment','source_id',a,'fingerprint',fp,'file_kind','pdf',
  'result','no_text_layer','code','no_text_layer','sha256',repeat('d1',32)));
 INSERT INTO public.context_document_vision_reads(source_kind,source_id,job_id,source_fingerprint,file_kind,outcome,attempts,last_code,finished_at)
 VALUES('email_attachment',a,NULL,fp,'pdf','no_text',1,'pdf_no_page_images',now());
 IF (SELECT count(*) FROM public.context_document_texts WHERE job_id IS NULL)<>1 THEN RAISE EXCEPTION 'rollback fixture: no read on no job'; END IF;
END $$;

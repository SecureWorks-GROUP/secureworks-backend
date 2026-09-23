-- Deliberately drop the refusal of unknown fields (a receipt that quietly ignores a
-- body field) and prove the contract catches it.
CREATE OR REPLACE FUNCTION public.record_ghl_webhook_receipt(p_receipt jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE bad text[]; new_id bigint;
BEGIN
 IF p_receipt IS NULL OR jsonb_typeof(p_receipt)<>'object' THEN RETURN jsonb_build_object('outcome','error','code','receipt_invalid'); END IF;
 SELECT array_agg(key ORDER BY key) INTO bad FROM jsonb_object_keys(p_receipt) key
 WHERE key NOT IN ('event_type','webhook_id','message_id','contact_id','outcome','reason','event_id','upgraded','auth','auth_detail',
  'auth_mode','error_code','targeted_read','targeted_seen','targeted_inserted','targeted_duplicates','targeted_skipped','targeted_errors');

 INSERT INTO public.ghl_webhook_receipts(event_type,webhook_id,message_id,contact_id,outcome,reason,event_id,upgraded,auth,auth_detail,
  auth_mode,error_code,targeted_read,targeted_seen,targeted_inserted,targeted_duplicates,targeted_skipped,targeted_errors)
 SELECT r.event_type,r.webhook_id,r.message_id,r.contact_id,r.outcome,r.reason,r.event_id,coalesce(r.upgraded,false),r.auth,r.auth_detail,
  r.auth_mode,r.error_code,r.targeted_read,r.targeted_seen,r.targeted_inserted,r.targeted_duplicates,r.targeted_skipped,r.targeted_errors
 FROM jsonb_to_record(p_receipt) AS r(event_type text,webhook_id text,message_id text,contact_id text,outcome text,reason text,event_id uuid,
  upgraded boolean,auth text,auth_detail text,auth_mode text,error_code text,targeted_read text,targeted_seen integer,targeted_inserted integer,
  targeted_duplicates integer,targeted_skipped integer,targeted_errors integer)
 RETURNING id INTO new_id;

 -- The 30-day purge, a bounded slice per call.
 DELETE FROM public.ghl_webhook_receipts WHERE id IN (
  SELECT g.id FROM public.ghl_webhook_receipts g WHERE g.received_at < now() - interval '30 days' ORDER BY g.received_at LIMIT 200);

 RETURN jsonb_build_object('outcome','recorded','id',new_id);
EXCEPTION WHEN OTHERS THEN
 RETURN jsonb_build_object('outcome','error','code',SQLSTATE);
END $$;

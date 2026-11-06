-- Invented jobs only. Test the real migration's checks, currentness and reopen
-- trigger. No invoice, Xero, communication or live record is touched.
BEGIN;
CREATE FUNCTION pg_temp.signoff_expect(want boolean, job uuid, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF public.group_client_signoff_counts(job) IS DISTINCT FROM want THEN
  RAISE EXCEPTION 'client-confirmation: %',label; END IF;
END $$;
CREATE FUNCTION pg_temp.signoff_job(n int, frozen timestamptz DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,type,status,job_number)
 VALUES(j,'00000000-0000-0000-0000-000000000001','patio','quoted','SYN-CLIENT-CONFIRM-'||n);
 INSERT INTO public.group_work_orders(org_id,job_id,work_order_id,share_token,split_frozen_at)
 VALUES('00000000-0000-0000-0000-000000000001',j,gen_random_uuid(),gen_random_uuid()::text,frozen);
 RETURN j;
END $$;
CREATE FUNCTION pg_temp.signoff_office(j uuid, accepts boolean DEFAULT true) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE k uuid;
BEGIN
 INSERT INTO public.job_client_signoffs(org_id,job_id,method,signed_name,happy,captured_by,captured_by_actor,
 capture_auth_source,capture_request_id,capture_payload_hash,confirmation_kind,confirmation_reference,client_confirmed_on,work_done)
 VALUES('00000000-0000-0000-0000-000000000001',j,'office_on_behalf','Invented Client',accepts,
 '00000000-0000-4000-8000-000000000003','user:00000000-0000-4000-8000-000000000003',
 'jwt',gen_random_uuid(),'sha256:'||repeat('a',64),'written_confirmation','Client email: invented message reference',(clock_timestamp() AT TIME ZONE 'Australia/Perth')::date,'Installed the agreed patio') RETURNING id INTO k;
 RETURN k;
END $$;
DO $$
DECLARE j uuid; old_j uuid; after_j uuid; k uuid; marker timestamptz; refused boolean;
BEGIN
 IF (SELECT client_confirmation_since FROM public.group_client_signoff_policy WHERE id=1) IS DISTINCT FROM '2026-11-06T05:55:58Z'::timestamptz THEN
   RAISE EXCEPTION 'client-confirmation: cutoff moved with deployment'; END IF;
 IF NOT EXISTS(SELECT 1 FROM storage.buckets WHERE id='client-signoff-copies' AND public=false) THEN
   RAISE EXCEPTION 'client-confirmation: copies are not private'; END IF;
 IF has_table_privilege('authenticated','public.group_client_signoff_policy','UPDATE')
   OR has_table_privilege('authenticated','public.job_client_signoffs','INSERT') THEN
   RAISE EXCEPTION 'client-confirmation: browser can write policy or sign-off'; END IF;
 old_j:=pg_temp.signoff_job(1,'2026-11-06T05:55:57Z');
 after_j:=pg_temp.signoff_job(2,'2026-11-06T05:55:58Z');
 j:=pg_temp.signoff_job(3);
 INSERT INTO public.job_client_signoffs(job_id,method,waiver_reason,captured_by_actor)
 SELECT x,'office_waiver','Historical office record','user:synthetic' FROM unnest(ARRAY[old_j,after_j,j]) x;
 PERFORM pg_temp.signoff_expect(true,old_j,'frozen before ruling lost its authority');
 PERFORM pg_temp.signoff_expect(false,after_j,'freeze at/after ruling used a general waiver');
 PERFORM pg_temp.signoff_expect(false,j,'unfrozen group used a general waiver');
 UPDATE public.group_work_orders SET split_frozen_at=NULL WHERE job_id=old_j;
 SELECT signoff_required_after INTO marker FROM public.group_work_orders WHERE job_id=old_j;
 IF marker IS NULL THEN RAISE EXCEPTION 'client-confirmation: reopen did not request fresh confirmation'; END IF;
 PERFORM pg_temp.signoff_expect(false,old_j,'reopened group kept historical approval');
 INSERT INTO public.job_client_signoffs(org_id,job_id,method,signed_name,happy,captured_by,captured_by_actor,
 capture_auth_source,capture_request_id,capture_payload_hash,confirmation_kind,confirmation_reference,client_confirmed_on,work_done)
 VALUES('00000000-0000-0000-0000-000000000001',old_j,'office_on_behalf','Invented Client',true,
 '00000000-0000-4000-8000-000000000003','user:00000000-0000-4000-8000-000000000003','jwt',gen_random_uuid(),
 'sha256:'||repeat('a',64),'written_confirmation','An older client email',(clock_timestamp() AT TIME ZONE 'Australia/Perth')::date-1,'Agreed work');
 PERFORM pg_temp.signoff_expect(false,old_j,'older client confirmation was re-recorded as fresh after reopening');
 k:=pg_temp.signoff_office(old_j);
 PERFORM pg_temp.signoff_expect(true,old_j,'attributed client written confirmation refused');
 k:=pg_temp.signoff_office(old_j,false);
 PERFORM pg_temp.signoff_expect(false,old_j,'client rejection counted');
 k:=pg_temp.signoff_office(old_j);
 UPDATE public.group_work_orders SET hours_changed_at=clock_timestamp() WHERE job_id=old_j;
 PERFORM pg_temp.signoff_expect(false,old_j,'changed hours kept prior client approval');
 k:=pg_temp.signoff_office(old_j);
 PERFORM pg_temp.signoff_expect(true,old_j,'fresh confirmation after changed hours refused');
 UPDATE public.group_work_orders SET split_frozen_at=clock_timestamp() WHERE job_id=old_j;
 refused:=false;
 BEGIN PERFORM pg_temp.signoff_office(old_j); EXCEPTION WHEN check_violation THEN refused:=true; END;
 IF NOT refused THEN RAISE EXCEPTION 'client-confirmation: record appended while frozen'; END IF;
 UPDATE public.group_work_orders SET split_frozen_at=NULL WHERE job_id=old_j;
 PERFORM pg_temp.signoff_expect(false,old_j,'reopening a signed group kept its old sign-off');
 -- Evidence cannot be omitted by relying on SQL CHECK's NULL semantics.
 refused:=false;
 BEGIN INSERT INTO public.job_client_signoffs(job_id,method,signed_name,happy,captured_by_actor)
 VALUES(j,'office_on_behalf','Invented Client',true,'user:synthetic');
 EXCEPTION WHEN check_violation THEN refused:=true; END;
 IF NOT refused THEN RAISE EXCEPTION 'client-confirmation: incomplete office evidence accepted'; END IF;
 -- A copy must belong to the same org, job and idempotent recording request.
 refused:=false;
 BEGIN INSERT INTO public.job_client_signoffs(org_id,job_id,method,signed_name,happy,captured_by,captured_by_actor,
 capture_auth_source,capture_request_id,capture_payload_hash,confirmation_kind,signed_copy_path,signed_copy_sha256,signed_copy_type,signed_copy_name,client_confirmed_on,work_done)
 VALUES('00000000-0000-0000-0000-000000000001',j,'office_on_behalf','Invented Client',true,
 '00000000-0000-4000-8000-000000000003','user:00000000-0000-4000-8000-000000000003','jwt',gen_random_uuid(),
 'sha256:'||repeat('b',64),'signed_copy','another/job/copy.pdf','sha256:'||repeat('c',64),'application/pdf','copy.pdf','2026-11-06','Agreed work');
 EXCEPTION WHEN check_violation THEN refused:=true; END;
 IF NOT refused THEN RAISE EXCEPTION 'client-confirmation: another job copy accepted'; END IF;
 -- A correctly bound signed copy is a valid alternative to the written reference.
 k:=gen_random_uuid();
 INSERT INTO public.job_client_signoffs(org_id,job_id,method,signed_name,happy,captured_by,captured_by_actor,
 capture_auth_source,capture_request_id,capture_payload_hash,confirmation_kind,signed_copy_path,signed_copy_sha256,signed_copy_type,signed_copy_name,client_confirmed_on,work_done)
 VALUES('00000000-0000-0000-0000-000000000001',j,'office_on_behalf','Invented Client',true,
 '00000000-0000-4000-8000-000000000003','user:00000000-0000-4000-8000-000000000003','jwt',k,
 'sha256:'||repeat('b',64),'signed_copy','00000000-0000-0000-0000-000000000001/'||j||'/'||k||'.pdf',
 'sha256:'||repeat('c',64),'application/pdf','copy.pdf','2026-11-06','Agreed work');
 PERFORM pg_temp.signoff_expect(true,j,'correctly bound signed client copy refused');
 SELECT id INTO k FROM public.job_client_signoffs WHERE job_id=j AND method='office_on_behalf';
 refused:=false;
 BEGIN UPDATE public.job_client_signoffs SET happy=false WHERE id=k; EXCEPTION WHEN check_violation THEN refused:=true; END;
 IF NOT refused THEN RAISE EXCEPTION 'client-confirmation: evidence could be edited'; END IF;
END $$;
SELECT 'PASS: ruling cutoff, historical freeze, new waiver refusal, office proof, unhappy client, hours change, reopen and private copy ownership' AS result;
ROLLBACK;

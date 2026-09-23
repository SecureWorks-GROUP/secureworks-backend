-- C1c (context build plan, Wave 3; design sms.md §7 step 8, §8, §13a;
-- INTEGRATION §2 "ghl_webhook_receipts (new) | sms C1c | receiver only").
--
-- public.ghl_webhook_receipts: one row per delivery to ghl-webhook-receiver,
-- written after the auth decision with the final outcome. It is what the
-- capture health read (context_ghl_capture_status, slice C1d) counts: last
-- webhook, webhooks in 24 h by outcome and auth mode, unresolved ids.
--
-- No body, ever. Every text column is an identifier or a code and the table
-- CHECKs refuse anything else (letters, digits and . _ : + - only), so a
-- message text, a name or an email address cannot be stored here even by a
-- buggy caller. received_at is set by the database.
--
-- The one writer is public.record_ghl_webhook_receipt(p_receipt jsonb)
-- (SECURITY DEFINER, service_role only). It refuses unknown or writer-owned
-- fields with a code, and on each call removes up to 200 receipts older than
-- 30 days (the design's 30-day purge, bounded per call, no cron job).
-- Returns {outcome: recorded, id} or {outcome: error, code}.
--
-- Access: RLS on, no policies, everything revoked from PUBLIC, anon and
-- authenticated; service_role may read (for the status function and the
-- validator) and write only through the function. Adds nothing readable by
-- the public key. Writes no business_events row, changes no flag or switch.
--
-- Rollback: supabase/rollbacks/20260924130000_ghl_webhook_receipts_down.sql
-- (drops the function and the table; receipts are operational, 30-day data).
-- Redeploy the previous ghl-webhook-receiver first: the new receiver calls the
-- function (a missing function is logged by code and never fails a delivery).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Pre-image guard: neither object may exist in another shape. Both absent (as in
-- the repository before this migration) or both exactly this migration's
-- (a re-apply) are accepted.
DO $guard$
DECLARE live_md5 text; cols text;
BEGIN
 IF to_regclass('public.ghl_webhook_receipts') IS NOT NULL THEN
  SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod),',' ORDER BY a.attnum) INTO cols
  FROM pg_attribute a WHERE a.attrelid='public.ghl_webhook_receipts'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  IF cols IS DISTINCT FROM 'id:bigint,received_at:timestamp with time zone,event_type:text,webhook_id:text,message_id:text,contact_id:text,outcome:text,reason:text,event_id:uuid,upgraded:boolean,auth:text,auth_detail:text,auth_mode:text,error_code:text,targeted_read:text,targeted_seen:integer,targeted_inserted:integer,targeted_duplicates:integer,targeted_skipped:integer,targeted_errors:integer' THEN
   RAISE EXCEPTION 'ghl_webhook_receipts_preimage_mismatch: public.ghl_webhook_receipts exists with columns %', cols;
  END IF;
 END IF;
 SELECT md5(p.prosrc) INTO live_md5 FROM pg_proc p WHERE p.oid=to_regprocedure('public.record_ghl_webhook_receipt(jsonb)');
 IF live_md5 IS NOT NULL AND live_md5 <> '05293bfa6bf24e1ea182fd01492d882e' THEN
  RAISE EXCEPTION 'ghl_webhook_receipts_preimage_mismatch: public.record_ghl_webhook_receipt(jsonb) exists with md5 %', live_md5;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='record_ghl_webhook_receipt'
     AND p.oid<>coalesce(to_regprocedure('public.record_ghl_webhook_receipt(jsonb)'),0)) THEN
  RAISE EXCEPTION 'ghl_webhook_receipts_preimage_mismatch: another public.record_ghl_webhook_receipt overload exists';
 END IF;
END $guard$;

CREATE TABLE IF NOT EXISTS public.ghl_webhook_receipts (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 received_at timestamptz NOT NULL DEFAULT now(),
 event_type text NOT NULL CHECK (event_type ~ '^[A-Za-z0-9_.-]{1,64}$'),
 webhook_id text CHECK (webhook_id ~ '^[A-Za-z0-9._:+-]{1,128}$'),
 message_id text CHECK (message_id ~ '^[A-Za-z0-9._:+-]{1,128}$'),
 contact_id text CHECK (contact_id ~ '^[A-Za-z0-9._:+-]{1,128}$'),
 outcome text NOT NULL CHECK (outcome IN ('event_created','duplicate','skipped','unresolved_id','skipped_unsupported',
  'capture_disabled','attribution_captured','unauthorized','invalid_json','error')),
 reason text CHECK (reason ~ '^[A-Za-z0-9._:+-]{1,128}$'),
 event_id uuid,
 upgraded boolean NOT NULL DEFAULT false,
 auth text NOT NULL CHECK (auth IN ('app_signature','workflow_secret','missing')),
 auth_detail text CHECK (auth_detail ~ '^[a-z_]{1,64}$'),
 auth_mode text NOT NULL CHECK (auth_mode IN ('observe','enforce')),
 error_code text CHECK (error_code ~ '^[A-Za-z0-9._:+-]{1,128}$'),
 targeted_read text CHECK (targeted_read IN ('ok','failed','skipped')),
 targeted_seen integer CHECK (targeted_seen >= 0),
 targeted_inserted integer CHECK (targeted_inserted >= 0),
 targeted_duplicates integer CHECK (targeted_duplicates >= 0),
 targeted_skipped integer CHECK (targeted_skipped >= 0),
 targeted_errors integer CHECK (targeted_errors >= 0)
);

CREATE INDEX IF NOT EXISTS ghl_webhook_receipts_received_at_idx ON public.ghl_webhook_receipts (received_at DESC);
CREATE INDEX IF NOT EXISTS ghl_webhook_receipts_outcome_idx ON public.ghl_webhook_receipts (outcome, received_at DESC);

COMMENT ON TABLE public.ghl_webhook_receipts IS
 'One ids-only row per delivery to ghl-webhook-receiver (context slice C1c): type, webhook id, item id, contact id, outcome, reason code, business_events id, auth result and mode, targeted-read counts. No body. Written only by record_ghl_webhook_receipt, which purges rows older than 30 days. service_role only.';

ALTER TABLE public.ghl_webhook_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ghl_webhook_receipts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.ghl_webhook_receipts TO service_role;

CREATE OR REPLACE FUNCTION public.record_ghl_webhook_receipt(p_receipt jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE bad text[]; new_id bigint;
BEGIN
 IF p_receipt IS NULL OR jsonb_typeof(p_receipt)<>'object' THEN RETURN jsonb_build_object('outcome','error','code','receipt_invalid'); END IF;
 SELECT array_agg(key ORDER BY key) INTO bad FROM jsonb_object_keys(p_receipt) key
 WHERE key NOT IN ('event_type','webhook_id','message_id','contact_id','outcome','reason','event_id','upgraded','auth','auth_detail',
  'auth_mode','error_code','targeted_read','targeted_seen','targeted_inserted','targeted_duplicates','targeted_skipped','targeted_errors');
 IF bad IS NOT NULL THEN RETURN jsonb_build_object('outcome','error','code','receipt_unknown_field','fields',to_jsonb(bad)); END IF;

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

COMMENT ON FUNCTION public.record_ghl_webhook_receipt(jsonb) IS
 'The one writer of ghl_webhook_receipts (context slice C1c). Ids, codes and counts only; refuses unknown fields; purges up to 200 receipts older than 30 days per call. Returns {outcome: recorded|error}. service_role only.';

REVOKE ALL ON FUNCTION public.record_ghl_webhook_receipt(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ghl_webhook_receipt(jsonb) TO service_role;

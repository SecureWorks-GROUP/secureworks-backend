-- C1a setup: bring the fixture business_events to the LIVE production shape the
-- writer runs against, as read from production on 23 Sep 2026 (read-only):
--  * the live CHECK constraints on channel, direction, match_confidence,
--    privacy_classification and retention_class, and the jobs foreign key;
--  * live defaults on sequence_number and recorded_at;
--  * a check that the ladder is the live resolve_context_attribution
--    (md5 acb80ebe792beeb7e5b537643bf9f184, the 20260923230000 body).
-- The live trigger body attribute_business_event() (md5 c399df..., the
-- 20260914110000 body without comments) is installed inside contract.sql's
-- rolled-back transaction instead, because earlier registered contracts assert
-- the older fixture trigger.
-- Earlier registered fixtures supply every business_events column the live
-- table has; this file adds no column.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.resolve_context_attribution(public.business_events)'))
    IS DISTINCT FROM 'acb80ebe792beeb7e5b537643bf9f184'
 THEN RAISE EXCEPTION 'c1a setup: resolve_context_attribution is not the live body'; END IF;
END $$;

CREATE SEQUENCE IF NOT EXISTS public.business_events_sequence_number_seq;
ALTER TABLE public.business_events
 ALTER COLUMN sequence_number SET DEFAULT nextval('public.business_events_sequence_number_seq'),
 ALTER COLUMN recorded_at SET DEFAULT now(),
 ADD CONSTRAINT business_events_channel_check CHECK (((channel = ANY (ARRAY['email'::text, 'sms'::text, 'call'::text, 'telegram'::text, 'note'::text, 'document'::text, 'xero'::text, 'po'::text, 'wo'::text, 'assignment'::text, 'status'::text, 'quote'::text, 'invoice'::text, 'payment'::text, 'scope'::text, 'chat'::text, 'audit'::text, 'system'::text])) OR (channel IS NULL))) NOT VALID,
 ADD CONSTRAINT business_events_direction_check CHECK (((direction = ANY (ARRAY['inbound'::text, 'outbound'::text, 'internal'::text, 'system'::text, 'unknown'::text])) OR (direction IS NULL))) NOT VALID,
 ADD CONSTRAINT business_events_match_confidence_check CHECK (((match_confidence IS NULL) OR ((match_confidence >= 0.00) AND (match_confidence <= 1.00)))) NOT VALID,
 ADD CONSTRAINT business_events_privacy_classification_check CHECK (((privacy_classification = ANY (ARRAY['internal'::text, 'client_safe'::text, 'staff_only'::text, 'restricted_pii'::text, 'audio_unredacted'::text])) OR (privacy_classification IS NULL))) NOT VALID,
 ADD CONSTRAINT business_events_retention_class_check CHECK (((retention_class = ANY (ARRAY['7y_audit'::text, '12m_default'::text, '6m_short'::text, '90d_transient'::text])) OR (retention_class IS NULL))) NOT VALID,
 ADD CONSTRAINT business_events_job_id_fk FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE SET NULL NOT VALID;

-- C1c behaviour contract.
-- 1. ghl_webhook_receipts and its one writer record_ghl_webhook_receipt: access,
--    ids-only storage, refusals, the bounded 30-day purge.
-- 2. The receiver's rows for the named rows of sms.md §10 (R1, R3, R4, R9 and
--    the rank-10 notes, tasks and appointments R25 to R31) saved through the
--    real writer capture_business_event and the live ladder: they pass the live
--    channel and direction CHECKs, keys make every edit and transition its own
--    row, retries land once, and placement is the ladder's alone.
-- The input rows between the ROWS markers are exactly what the receiver's
-- builder produces (ghl-webhook-receiver/c1c_contract_rows.ts);
-- receiver_c1c_test.ts fails if they drift. Contact and GHL ids are the
-- design's where it records them, placeholders otherwise; job ids and job
-- numbers are synthetic. Row labels only. Every fixture write is rolled back.
BEGIN;
-- The live BEFORE INSERT trigger body, as read from production on 23 Sep 2026
-- (the same install as the C1a contract).
CREATE OR REPLACE FUNCTION public.attribute_business_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.context_captured_at IS NULL THEN
    NEW.context_captured_at := clock_timestamp();
  END IF;
  NEW := public.resolve_context_attribution(NEW);
  RETURN NEW;
END $$;
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.attribute_business_event()'))
    IS DISTINCT FROM 'c399dfbebcd120a4b0741a9130a973bf'
 THEN RAISE EXCEPTION 'c1c contract: attribute_business_event is not the live body'; END IF;
END $$;

CREATE TEMP TABLE c1c_rows(label text PRIMARY KEY, r jsonb NOT NULL) ON COMMIT DROP;
-- ROWS BEGIN
INSERT INTO c1c_rows(label,r) VALUES
 ('r1','{"event_type":"client.reply","source":"ghl-webhook-receiver","entity_type":"contact","entity_id":"lYPee0K2DuQHXH2xHL1P","contact_id":"lYPee0K2DuQHXH2xHL1P","job_id":null,"match_method":"none","event_at":"2026-09-23T04:35:00.000Z","provider_message_id":"ghl:pffXnIL1v2FTaKnz4DHm","channel":"sms","direction":"inbound","thread_key":null,"conversation_key":"I98nlO8dKPOAaylh7k23","body_preview":"I haven''t received all three quotes as yet?","safe_summary":"I haven''t received all three quotes as yet?","privacy_classification":"staff_only","retention_class":"7y_audit","payload":{"body":"I haven''t received all three quotes as yet?","text":"I haven''t received all three quotes as yet?","message":"I haven''t received all three quotes as yet?","message_text":"I haven''t received all three quotes as yet?","channel":"sms","direction":"inbound","ghl_message_id":"pffXnIL1v2FTaKnz4DHm","ghl_contact_id":"lYPee0K2DuQHXH2xHL1P","ghl_message_type":"SMS","conversation_key":"I98nlO8dKPOAaylh7k23","conversation_id":"I98nlO8dKPOAaylh7k23","sent_by_kind":"customer","sent_by_user":null,"line":"fencing","from_line":"772","our_number":"+61489267772","provider_source":null,"provider_status":null,"attachments":{"count":0,"types":[]},"event_at_source":"provider"},"metadata":{"capture_mode":"live"}}'::jsonb),
 ('r3','{"event_type":"client.reply","source":"ghl-webhook-receiver","entity_type":"contact","entity_id":"lYPee0K2DuQHXH2xHL1P","contact_id":"lYPee0K2DuQHXH2xHL1P","job_id":null,"match_method":"none","event_at":"2026-09-23T06:00:00.000Z","provider_message_id":"ghl:EHw3wdBraMS847Q3V380","channel":"sms","direction":"inbound","thread_key":null,"conversation_key":"I98nlO8dKPOAaylh7k23","body_preview":"Thanks.","safe_summary":"Thanks.","privacy_classification":"staff_only","retention_class":"7y_audit","payload":{"body":"Thanks.","text":"Thanks.","message":"Thanks.","message_text":"Thanks.","channel":"sms","direction":"inbound","ghl_message_id":"EHw3wdBraMS847Q3V380","ghl_contact_id":"lYPee0K2DuQHXH2xHL1P","ghl_message_type":"TYPE_SMS","conversation_key":"I98nlO8dKPOAaylh7k23","conversation_id":"I98nlO8dKPOAaylh7k23","sent_by_kind":"customer","sent_by_user":null,"line":"fencing","from_line":"772","our_number":"+61489267772","provider_source":null,"provider_status":"delivered","attachments":{"count":0,"types":[]},"event_at_source":"provider"},"metadata":{"capture_mode":"live"}}'::jsonb),
 ('r4','{"event_type":"client.sms_out","source":"ghl-webhook-receiver","entity_type":"contact","entity_id":"lYPee0K2DuQHXH2xHL1P","contact_id":"lYPee0K2DuQHXH2xHL1P","job_id":null,"match_method":"none","event_at":"2026-09-23T03:08:00.000Z","provider_message_id":"ghl:OPzxTmGv37UAMzf1hD3Q","channel":"sms","direction":"outbound","thread_key":null,"conversation_key":"I98nlO8dKPOAaylh7k23","body_preview":"Automatic follow-up text for the R4 fixture.","safe_summary":"Automatic follow-up text for the R4 fixture.","privacy_classification":"staff_only","retention_class":"7y_audit","payload":{"body":"Automatic follow-up text for the R4 fixture.","text":"Automatic follow-up text for the R4 fixture.","message":"Automatic follow-up text for the R4 fixture.","message_text":"Automatic follow-up text for the R4 fixture.","channel":"sms","direction":"outbound","ghl_message_id":"OPzxTmGv37UAMzf1hD3Q","ghl_contact_id":"lYPee0K2DuQHXH2xHL1P","ghl_message_type":"SMS","conversation_key":"I98nlO8dKPOAaylh7k23","conversation_id":"I98nlO8dKPOAaylh7k23","sent_by_kind":"workflow","sent_by_user":null,"line":"fencing","from_line":"772","our_number":"+61489267772","provider_source":"workflow","provider_status":null,"attachments":{"count":0,"types":[]},"event_at_source":"provider"},"metadata":{"capture_mode":"live"}}'::jsonb),
 ('r9','{"event_type":"client.reply","source":"ghl-webhook-receiver","entity_type":"contact","entity_id":"Oxqi7eCx2rGCsS0BXOH2","contact_id":"Oxqi7eCx2rGCsS0BXOH2","job_id":null,"match_method":"none","event_at":"2026-09-22T23:08:00.000Z","provider_message_id":"ghl:1TPog9f79izPytVu8yoo","channel":"sms","direction":"inbound","thread_key":null,"conversation_key":"r9-conversation-placeholder","body_preview":"are the guys coming today?","safe_summary":"are the guys coming today?","privacy_classification":"staff_only","retention_class":"7y_audit","payload":{"body":"are the guys coming today?","text":"are the guys coming today?","message":"are the guys coming today?","message_text":"are the guys coming today?","channel":"sms","direction":"inbound","ghl_message_id":"1TPog9f79izPytVu8yoo","ghl_contact_id":"Oxqi7eCx2rGCsS0BXOH2","ghl_message_type":"SMS","conversation_key":"r9-conversation-placeholder","conversation_id":"r9-conversation-placeholder","sent_by_kind":"customer","sent_by_user":null,"line":"patio","from_line":"774","our_number":"+61489267774","provider_source":null,"provider_status":null,"attachments":{"count":0,"types":[]},"event_at_source":"provider"},"metadata":{"capture_mode":"live"}}'::jsonb),
 ('r25','{"event_type":"ghl.note_added","source":"ghl-webhook-receiver","entity_type":"contact","entity_id":"1VHBzZX6DsjMZW2WbgQn","contact_id":"1VHBzZX6DsjMZW2WbgQn","job_id":null,"match_method":"none","event_at":"2026-09-08T02:10:00.000Z","provider_message_id":"ghlnote:r25NotePlaceholder01:2026-09-08T02:10:00.000Z","channel":"note","direction":"internal","thread_key":null,"conversation_key":null,"body_preview":"Note text for the R25 fixture: price concession agreed.","safe_summary":"Note text for the R25 fixture: price concession agreed.","privacy_classification":"staff_only","retention_class":"7y_audit","payload":{"channel":"note","direction":"internal","ghl_record_type":"NoteCreate","ghl_contact_id":"1VHBzZX6DsjMZW2WbgQn","sent_by_kind":"staff_app","sent_by_user":"47AptTIxjOPutvcl6RpO","event_at_source":"provider","ghl_note_id":"r25NotePlaceholder01","body":"Note text for the R25 fixture: price concession agreed.","text":"Note text for the R25 fixture: price concession agreed.","message":"Note text for the R25 fixture: price concession agreed.","message_text":"Note text for the R25 fixture: price concession agreed."},"metadata":{"capture_mode":"live"}}'::jsonb),
 ('r26','{"event_type":"ghl.note_added","source":"ghl-webhook-receiver","entity_type":"contact","entity_id":"r26-contact-placeholder","contact_id":"r26-contact-placeholder","job_id":null,"match_method":"none","event_at":"2026-09-16T03:00:00.000Z","provider_message_id":"ghlnote:r26NotePlaceholder01:2026-09-16T03:00:00.000Z","channel":"note","direction":"internal","thread_key":null,"conversation_key":null,"body_preview":"Note text for the R26 fixture: scope handoff.","safe_summary":"Note text for the R26 fixture: scope handoff.","privacy_classification":"staff_only","retention_class":"7y_audit","payload":{"channel":"note","direction":"internal","ghl_record_type":"NoteCreate","ghl_contact_id":"r26-contact-placeholder","sent_by_kind":"staff_app","sent_by_user":"RgDWTnYL6zL3eJA6nLht","event_at_source":"provider","ghl_note_id":"r26NotePlaceholder01","body":"Note text for the R26 fixture: scope handoff.","text":"Note text for the R26 fixture: scope handoff.","message":"Note text for the R26 fixture: scope handoff.","message_text":"Note text for the R26 fixture: scope handoff."},"metadata":{"capture_mode":"live"}}'::jsonb),
 ('r27','{"event_type":"ghl.note_updated","source":"ghl-webhook-receiver","entity_type":"contact","entity_id":"1VHBzZX6DsjMZW2WbgQn","contact_id":"1VHBzZX6DsjMZW2WbgQn","job_id":null,"match_method":"none","event_at":"2026-09-09T01:00:00.000Z","provider_message_id":"ghlnote:r25NotePlaceholder01:2026-09-09T01:00:00.000Z","channel":"note","direction":"internal","thread_key":null,"conversation_key":null,"body_preview":"Note text for the R25 fixture: price concession agreed, edited.","safe_summary":"Note text for the R25 fixture: price concession agreed, edited.","privacy_classification":"staff_only","retention_class":"7y_audit","payload":{"channel":"note","direction":"internal","ghl_record_type":"NoteUpdate","ghl_contact_id":"1VHBzZX6DsjMZW2WbgQn","sent_by_kind":"staff_app","sent_by_user":"47AptTIxjOPutvcl6RpO","event_at_source":"provider","ghl_note_id":"r25NotePlaceholder01","body":"Note text for the R25 fixture: price concession agreed, edited.","text":"Note text for the R25 fixture: price concession agreed, edited.","message":"Note text for the R25 fixture: price concession agreed, edited.","message_text":"Note text for the R25 fixture: price concession agreed, edited."},"metadata":{"capture_mode":"live"}}'::jsonb),
 ('r28','{"event_type":"ghl.task_created","source":"ghl-webhook-receiver","entity_type":"contact","entity_id":"r28-contact-placeholder","contact_id":"r28-contact-placeholder","job_id":null,"match_method":"none","event_at":"2026-09-22T01:00:00.000Z","provider_message_id":"ghltask:r28TaskPlaceholder01:create:2026-09-22T01:00:00.000Z","channel":"status","direction":"internal","thread_key":null,"conversation_key":null,"body_preview":"Task created: Task title for the R28 fixture\nTask body for the R28 fixture.","safe_summary":"Task created: Task title for the R28 fixture\nTask body for the R28 fixture.","privacy_classification":"staff_only","retention_class":"12m_default","payload":{"channel":"status","direction":"internal","ghl_record_type":"TaskCreate","ghl_contact_id":"r28-contact-placeholder","sent_by_kind":"unknown","sent_by_user":null,"event_at_source":"provider","ghl_task_id":"r28TaskPlaceholder01","title":"Task title for the R28 fixture","body":"Task body for the R28 fixture.","assigned_to":"r28-staff-user-placeholder","due_date":"2026-09-25T00:00:00.000Z","completed":null,"task_action":"create"},"metadata":{"capture_mode":"live"}}'::jsonb),
 ('r29_first','{"event_type":"ghl.task_completed","source":"ghl-webhook-receiver","entity_type":"contact","entity_id":"r28-contact-placeholder","contact_id":"r28-contact-placeholder","job_id":null,"match_method":"none","event_at":"2026-09-23T02:00:00.000Z","provider_message_id":"ghltask:r28TaskPlaceholder01:complete:2026-09-23T02:00:00.000Z","channel":"status","direction":"internal","thread_key":null,"conversation_key":null,"body_preview":"Task completed: Task title for the R28 fixture\nTask body for the R28 fixture.","safe_summary":"Task completed: Task title for the R28 fixture\nTask body for the R28 fixture.","privacy_classification":"staff_only","retention_class":"12m_default","payload":{"channel":"status","direction":"internal","ghl_record_type":"TaskComplete","ghl_contact_id":"r28-contact-placeholder","sent_by_kind":"unknown","sent_by_user":null,"event_at_source":"provider","ghl_task_id":"r28TaskPlaceholder01","title":"Task title for the R28 fixture","body":"Task body for the R28 fixture.","assigned_to":"r28-staff-user-placeholder","due_date":"2026-09-25T00:00:00.000Z","completed":true,"task_action":"complete"},"metadata":{"capture_mode":"live"}}'::jsonb),
 ('r29_second','{"event_type":"ghl.task_completed","source":"ghl-webhook-receiver","entity_type":"contact","entity_id":"r28-contact-placeholder","contact_id":"r28-contact-placeholder","job_id":null,"match_method":"none","event_at":"2026-09-23T05:30:00.000Z","provider_message_id":"ghltask:r28TaskPlaceholder01:complete:2026-09-23T05:30:00.000Z","channel":"status","direction":"internal","thread_key":null,"conversation_key":null,"body_preview":"Task completed: Task title for the R28 fixture\nTask body for the R28 fixture.","safe_summary":"Task completed: Task title for the R28 fixture\nTask body for the R28 fixture.","privacy_classification":"staff_only","retention_class":"12m_default","payload":{"channel":"status","direction":"internal","ghl_record_type":"TaskComplete","ghl_contact_id":"r28-contact-placeholder","sent_by_kind":"unknown","sent_by_user":null,"event_at_source":"provider","ghl_task_id":"r28TaskPlaceholder01","title":"Task title for the R28 fixture","body":"Task body for the R28 fixture.","assigned_to":"r28-staff-user-placeholder","due_date":"2026-09-25T00:00:00.000Z","completed":true,"task_action":"complete"},"metadata":{"capture_mode":"live"}}'::jsonb),
 ('r30','{"event_type":"ghl.appointment_updated","source":"ghl-webhook-receiver","entity_type":"contact","entity_id":"r30-contact-placeholder","contact_id":"r30-contact-placeholder","job_id":null,"match_method":"none","event_at":"2026-09-22T04:00:00.000Z","provider_message_id":"ghlappt:r30ApptPlaceholder01:update:2026-09-22T04:00:00.000Z","channel":"status","direction":"internal","thread_key":null,"conversation_key":null,"body_preview":"Appointment updated: Appointment title for the R30 fixture, starts 2026-09-26T01:00:00.000Z, ends 2026-09-26T02:00:00.000Z, status confirmed","safe_summary":"Appointment updated: Appointment title for the R30 fixture, starts 2026-09-26T01:00:00.000Z, ends 2026-09-26T02:00:00.000Z, status confirmed","privacy_classification":"staff_only","retention_class":"12m_default","payload":{"channel":"status","direction":"internal","ghl_record_type":"AppointmentUpdate","ghl_contact_id":"r30-contact-placeholder","sent_by_kind":"unknown","sent_by_user":null,"event_at_source":"provider","ghl_appointment_id":"r30ApptPlaceholder01","calendar_id":"r30-calendar-placeholder","title":"Appointment title for the R30 fixture","start_time":"2026-09-26T01:00:00.000Z","end_time":"2026-09-26T02:00:00.000Z","appointment_status":"confirmed","assigned_user_id":"RgDWTnYL6zL3eJA6nLht","appointment_action":"update","answer_path":false},"metadata":{"capture_mode":"live"}}'::jsonb),
 ('r31_create','{"event_type":"ghl.appointment_created","source":"ghl-webhook-receiver","entity_type":"contact","entity_id":"r31-contact-placeholder","contact_id":"r31-contact-placeholder","job_id":null,"match_method":"none","event_at":"2026-09-18T00:48:00.000Z","provider_message_id":"ghlappt:r31ApptPlaceholder01:create:2026-09-18T00:48:00.000Z","channel":"status","direction":"internal","thread_key":null,"conversation_key":null,"body_preview":"Appointment created: Appointment title for the R31 fixture, starts 2026-09-24T01:00:00.000Z, ends 2026-09-24T02:00:00.000Z, status confirmed","safe_summary":"Appointment created: Appointment title for the R31 fixture, starts 2026-09-24T01:00:00.000Z, ends 2026-09-24T02:00:00.000Z, status confirmed","privacy_classification":"staff_only","retention_class":"12m_default","payload":{"channel":"status","direction":"internal","ghl_record_type":"AppointmentCreate","ghl_contact_id":"r31-contact-placeholder","sent_by_kind":"unknown","sent_by_user":null,"event_at_source":"provider","ghl_appointment_id":"r31ApptPlaceholder01","calendar_id":"r31-calendar-placeholder","title":"Appointment title for the R31 fixture","start_time":"2026-09-24T01:00:00.000Z","end_time":"2026-09-24T02:00:00.000Z","appointment_status":"confirmed","assigned_user_id":"RgDWTnYL6zL3eJA6nLht","appointment_action":"create","answer_path":false},"metadata":{"capture_mode":"live"}}'::jsonb),
 ('r31_delete','{"event_type":"ghl.appointment_deleted","source":"ghl-webhook-receiver","entity_type":"contact","entity_id":"r31-contact-placeholder","contact_id":"r31-contact-placeholder","job_id":null,"match_method":"none","event_at":"2026-09-20T03:00:00.000Z","provider_message_id":"ghlappt:r31ApptPlaceholder01:delete:2026-09-20T03:00:00.000Z","channel":"status","direction":"internal","thread_key":null,"conversation_key":null,"body_preview":"Appointment deleted: Appointment title for the R31 fixture, starts 2026-09-24T01:00:00.000Z, ends 2026-09-24T02:00:00.000Z, status cancelled","safe_summary":"Appointment deleted: Appointment title for the R31 fixture, starts 2026-09-24T01:00:00.000Z, ends 2026-09-24T02:00:00.000Z, status cancelled","privacy_classification":"staff_only","retention_class":"12m_default","payload":{"channel":"status","direction":"internal","ghl_record_type":"AppointmentDelete","ghl_contact_id":"r31-contact-placeholder","sent_by_kind":"unknown","sent_by_user":null,"event_at_source":"provider","ghl_appointment_id":"r31ApptPlaceholder01","calendar_id":"r31-calendar-placeholder","title":"Appointment title for the R31 fixture","start_time":"2026-09-24T01:00:00.000Z","end_time":"2026-09-24T02:00:00.000Z","appointment_status":"cancelled","assigned_user_id":"RgDWTnYL6zL3eJA6nLht","appointment_action":"delete","answer_path":false},"metadata":{"capture_mode":"live"}}'::jsonb),
 ('n1','{"event_type":"client.call_logged","source":"ghl-webhook-receiver","entity_type":"contact","entity_id":"Oxqi7eCx2rGCsS0BXOH2","contact_id":"Oxqi7eCx2rGCsS0BXOH2","job_id":null,"match_method":"none","event_at":"2026-09-23T07:40:55.171Z","provider_message_id":"ghl:6kn6WmrtfTMvhEJtmfeJ","channel":"call","direction":"inbound","thread_key":null,"conversation_key":"3GOBTMJT1qEXkGwcodQK","body_preview":"[Call, inbound. Provider status: completed. Duration: 109 seconds. Transcript: none in this record; any transcript is a separate event for this call.]","safe_summary":"[Call, inbound. Provider status: completed. Duration: 109 seconds. Transcript: none in this record; any transcript is a separate event for this call.]","privacy_classification":"staff_only","retention_class":"7y_audit","payload":{"described_by_capture":true,"words":false,"channel":"call","direction":"inbound","ghl_message_id":"6kn6WmrtfTMvhEJtmfeJ","ghl_contact_id":"Oxqi7eCx2rGCsS0BXOH2","ghl_message_type":"TYPE_CALL","conversation_key":"3GOBTMJT1qEXkGwcodQK","conversation_id":"3GOBTMJT1qEXkGwcodQK","call_sid":"CAfcb0bf0b3d5308f16a6087ca116874a8","call_status":"completed","duration_seconds":109,"by_user":"ERAycY7r6KZ8OA66WQCy","line":"patio","from_line":"774","our_number":"+61489267774","source":null,"provider_status":"completed","transcript_expected":true,"event_at_source":"provider"},"metadata":{"capture_mode":"live"}}'::jsonb),
 ('n2','{"event_type":"client.call_logged","source":"ghl-webhook-receiver","entity_type":"contact","entity_id":"Oxqi7eCx2rGCsS0BXOH2","contact_id":"Oxqi7eCx2rGCsS0BXOH2","job_id":null,"match_method":"none","event_at":"2026-09-22T22:59:20.907Z","provider_message_id":"ghl:Py9PovOwc4I4vNkn9jXg","channel":"call","direction":"inbound","thread_key":null,"conversation_key":"3GOBTMJT1qEXkGwcodQK","body_preview":"[Call, inbound. Provider status: voicemail. Duration: none recorded. Transcript: none in this record; any transcript is a separate event for this call.]","safe_summary":"[Call, inbound. Provider status: voicemail. Duration: none recorded. Transcript: none in this record; any transcript is a separate event for this call.]","privacy_classification":"staff_only","retention_class":"7y_audit","payload":{"described_by_capture":true,"words":false,"channel":"call","direction":"inbound","ghl_message_id":"Py9PovOwc4I4vNkn9jXg","ghl_contact_id":"Oxqi7eCx2rGCsS0BXOH2","ghl_message_type":"TYPE_CALL","conversation_key":"3GOBTMJT1qEXkGwcodQK","conversation_id":"3GOBTMJT1qEXkGwcodQK","call_sid":"CA328d9bf74781d1cb8a8166ae38939924","call_status":"voicemail","duration_seconds":null,"by_user":"ERAycY7r6KZ8OA66WQCy","line":"patio","from_line":"774","our_number":"+61489267774","source":null,"provider_status":"voicemail","transcript_expected":true,"event_at_source":"provider"},"metadata":{"capture_mode":"live"}}'::jsonb),
 ('n3','{"event_type":"client.call_logged","source":"ghl-webhook-receiver","entity_type":"contact","entity_id":"Oxqi7eCx2rGCsS0BXOH2","contact_id":"Oxqi7eCx2rGCsS0BXOH2","job_id":null,"match_method":"none","event_at":"2026-09-21T23:16:29.130Z","provider_message_id":"ghl:0Gct0u0TQNZox8DRAVLo","channel":"call","direction":"outbound","thread_key":null,"conversation_key":"3GOBTMJT1qEXkGwcodQK","body_preview":"[Call, outbound. Provider status: completed. Duration: 67 seconds. Transcript: none in this record; any transcript is a separate event for this call.]","safe_summary":"[Call, outbound. Provider status: completed. Duration: 67 seconds. Transcript: none in this record; any transcript is a separate event for this call.]","privacy_classification":"staff_only","retention_class":"7y_audit","payload":{"described_by_capture":true,"words":false,"channel":"call","direction":"outbound","ghl_message_id":"0Gct0u0TQNZox8DRAVLo","ghl_contact_id":"Oxqi7eCx2rGCsS0BXOH2","ghl_message_type":"TYPE_CALL","conversation_key":"3GOBTMJT1qEXkGwcodQK","conversation_id":"3GOBTMJT1qEXkGwcodQK","call_sid":"CAe7fc92b16f2705949df9fb8bf806d99c","call_status":"completed","duration_seconds":67,"by_user":"ERAycY7r6KZ8OA66WQCy","line":"patio","from_line":"774","our_number":"+61489267774","source":"app","provider_status":"completed","transcript_expected":true,"event_at_source":"provider"},"metadata":{"capture_mode":"live"}}'::jsonb);
-- ROWS END

-- 1a. Access: RLS on with no policy; nothing for PUBLIC, anon or authenticated;
-- service_role reads, and writes only through the function.
DO $$
DECLARE t regclass:='public.ghl_webhook_receipts'::regclass; f regprocedure:='public.record_ghl_webhook_receipt(jsonb)'::regprocedure; r text; p text;
BEGIN
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=t) THEN RAISE EXCEPTION 'c1c: RLS is off on ghl_webhook_receipts'; END IF;
 IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=t) THEN RAISE EXCEPTION 'c1c: ghl_webhook_receipts has a policy'; END IF;
 FOREACH r IN ARRAY ARRAY['anon','authenticated','public'] LOOP
  FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
   IF has_table_privilege(r,t,p) THEN RAISE EXCEPTION 'c1c: % holds % on ghl_webhook_receipts',r,p; END IF;
  END LOOP;
  IF has_function_privilege(r,f,'EXECUTE') THEN RAISE EXCEPTION 'c1c: % may execute record_ghl_webhook_receipt',r; END IF;
 END LOOP;
 IF NOT has_table_privilege('service_role',t,'SELECT') THEN RAISE EXCEPTION 'c1c: service_role cannot read receipts'; END IF;
 IF has_table_privilege('service_role',t,'INSERT') OR has_table_privilege('service_role',t,'UPDATE') OR has_table_privilege('service_role',t,'DELETE')
 THEN RAISE EXCEPTION 'c1c: service_role may write receipts around the writer'; END IF;
 IF NOT has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'c1c: service_role cannot execute the writer'; END IF;
 IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=f) THEN RAISE EXCEPTION 'c1c: writer is not SECURITY DEFINER'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=f AND 'search_path=public, pg_temp'=ANY(proconfig)) THEN RAISE EXCEPTION 'c1c: writer has no fixed search_path'; END IF;
END $$;
SAVEPOINT as_anon;
SET LOCAL ROLE anon;
DO $$
BEGIN
 PERFORM public.record_ghl_webhook_receipt('{}'::jsonb);
 RAISE EXCEPTION 'c1c: anon called record_ghl_webhook_receipt';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
ROLLBACK TO SAVEPOINT as_anon;

-- 1b. The writer, called as the receiver calls it (service_role).
SAVEPOINT as_service;
SET LOCAL ROLE service_role;
DO $$
DECLARE out jsonb;
BEGIN
 -- An R1 delivery captured: one ids-only row, received_at from the database.
 out:=public.record_ghl_webhook_receipt('{"event_type":"InboundMessage","webhook_id":"wh-r1-0001","message_id":"pffXnIL1v2FTaKnz4DHm","contact_id":"lYPee0K2DuQHXH2xHL1P","outcome":"event_created","reason":null,"event_id":"55555555-5555-4555-8555-555555555555","upgraded":false,"auth":"app_signature","auth_detail":null,"auth_mode":"observe","error_code":null,"targeted_read":null,"targeted_seen":null,"targeted_inserted":null,"targeted_duplicates":null,"targeted_skipped":null,"targeted_errors":null}');
 IF out->>'outcome' IS DISTINCT FROM 'recorded' THEN RAISE EXCEPTION 'c1c writer: R1 receipt not recorded: %',out; END IF;

 -- An id-less R1 delivery: unresolved_id with the targeted read's counts.
 out:=public.record_ghl_webhook_receipt('{"event_type":"InboundMessage","webhook_id":"wh-r1-noid-0001","contact_id":"lYPee0K2DuQHXH2xHL1P","outcome":"unresolved_id","auth":"app_signature","auth_mode":"observe","targeted_read":"ok","targeted_seen":4,"targeted_inserted":1,"targeted_duplicates":3,"targeted_skipped":0,"targeted_errors":0}');
 IF out->>'outcome' IS DISTINCT FROM 'recorded' THEN RAISE EXCEPTION 'c1c writer: unresolved_id receipt: %',out; END IF;

 -- No body: an unknown field (a body, or received_at) is refused and nothing is written.
 out:=public.record_ghl_webhook_receipt('{"event_type":"InboundMessage","outcome":"event_created","auth":"missing","auth_mode":"observe","body":"I haven''t received all three quotes as yet?"}');
 IF out->>'code' IS DISTINCT FROM 'receipt_unknown_field' OR out->'fields' IS DISTINCT FROM '["body"]'::jsonb THEN RAISE EXCEPTION 'c1c writer: a body field was not refused: %',out; END IF;
 out:=public.record_ghl_webhook_receipt('{"event_type":"InboundMessage","outcome":"event_created","auth":"missing","auth_mode":"observe","received_at":"2020-01-01T00:00:00Z"}');
 IF out->>'code' IS DISTINCT FROM 'receipt_unknown_field' THEN RAISE EXCEPTION 'c1c writer: caller received_at accepted: %',out; END IF;
 -- Text smuggled into an id column is refused by the table CHECKs.
 out:=public.record_ghl_webhook_receipt('{"event_type":"InboundMessage","message_id":"I haven''t received all three quotes as yet?","outcome":"event_created","auth":"missing","auth_mode":"observe"}');
 IF out->>'outcome' IS DISTINCT FROM 'error' OR out->>'code' IS DISTINCT FROM '23514' THEN RAISE EXCEPTION 'c1c writer: text in message_id not refused: %',out; END IF;
 out:=public.record_ghl_webhook_receipt('{"event_type":"InboundMessage","contact_id":"someone@example.test ","outcome":"event_created","auth":"missing","auth_mode":"observe"}');
 IF out->>'code' IS DISTINCT FROM '23514' THEN RAISE EXCEPTION 'c1c writer: an address in contact_id not refused: %',out; END IF;
 out:=public.record_ghl_webhook_receipt('{"event_type":"InboundMessage","outcome":"made_up","auth":"missing","auth_mode":"observe"}');
 IF out->>'code' IS DISTINCT FROM '23514' THEN RAISE EXCEPTION 'c1c writer: unknown outcome accepted: %',out; END IF;
 out:=public.record_ghl_webhook_receipt('[]');
 IF out->>'code' IS DISTINCT FROM 'receipt_invalid' THEN RAISE EXCEPTION 'c1c writer: non-object accepted: %',out; END IF;

 -- Direct writes around the writer are refused.
 BEGIN
  INSERT INTO public.ghl_webhook_receipts(event_type,outcome,auth,auth_mode) VALUES ('InboundMessage','event_created','missing','observe');
  RAISE EXCEPTION 'c1c: service_role inserted a receipt directly';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
-- Read back as the owner (plain PostgreSQL gives service_role no BYPASSRLS).
RESET ROLE;
DO $$
DECLARE g public.ghl_webhook_receipts; n int;
BEGIN
 SELECT count(*) INTO n FROM public.ghl_webhook_receipts;
 IF n<>2 THEN RAISE EXCEPTION 'c1c writer: expected the two accepted receipts only, found % (a refused receipt was written)',n; END IF;
 SELECT * INTO g FROM public.ghl_webhook_receipts WHERE webhook_id='wh-r1-0001';
 IF g.message_id<>'pffXnIL1v2FTaKnz4DHm' OR g.outcome<>'event_created' OR g.auth<>'app_signature' OR g.received_at IS NULL
  OR g.event_id<>'55555555-5555-4555-8555-555555555555' OR g.upgraded THEN RAISE EXCEPTION 'c1c writer: stored receipt wrong %',to_jsonb(g); END IF;
 SELECT * INTO g FROM public.ghl_webhook_receipts WHERE webhook_id='wh-r1-noid-0001';
 IF g.outcome<>'unresolved_id' OR g.message_id IS NOT NULL OR g.targeted_read<>'ok' OR g.targeted_inserted<>1 OR g.targeted_duplicates<>3
 THEN RAISE EXCEPTION 'c1c writer: unresolved_id receipt wrong %',to_jsonb(g); END IF;
END $$;
ROLLBACK TO SAVEPOINT as_service;

-- 1c. The 30-day purge: at most 200 old receipts per call; nothing younger.
DO $$
DECLARE n int;
BEGIN
 DELETE FROM public.ghl_webhook_receipts;
 INSERT INTO public.ghl_webhook_receipts(received_at,event_type,outcome,auth,auth_mode)
 SELECT now()-interval '31 days'-make_interval(mins=>i),'InboundMessage','event_created','missing','observe' FROM generate_series(1,250) i;
 INSERT INTO public.ghl_webhook_receipts(received_at,event_type,outcome,auth,auth_mode)
 VALUES (now()-interval '29 days','InboundMessage','duplicate','missing','observe');
 PERFORM public.record_ghl_webhook_receipt('{"event_type":"InboundMessage","outcome":"event_created","auth":"missing","auth_mode":"observe"}');
 SELECT count(*) INTO n FROM public.ghl_webhook_receipts WHERE received_at<now()-interval '30 days';
 IF n<>50 THEN RAISE EXCEPTION 'c1c purge: first call left % old receipts, expected 50',n; END IF;
 PERFORM public.record_ghl_webhook_receipt('{"event_type":"InboundMessage","outcome":"event_created","auth":"missing","auth_mode":"observe"}');
 IF EXISTS (SELECT 1 FROM public.ghl_webhook_receipts WHERE received_at<now()-interval '30 days') THEN RAISE EXCEPTION 'c1c purge: old receipts remain'; END IF;
 SELECT count(*) INTO n FROM public.ghl_webhook_receipts;
 IF n<>3 THEN RAISE EXCEPTION 'c1c purge: expected the 29-day receipt and the two new ones, found %',n; END IF;
END $$;

-- 2. The receiver's rows through capture_business_event and the live ladder.
DO $$
DECLARE
 org uuid:='00000000-0000-0000-0000-000000000001';
 r25_job uuid:=gen_random_uuid(); r1_a uuid:=gen_random_uuid(); r1_b uuid:=gen_random_uuid(); r9_job uuid:=gen_random_uuid();
 r26_a uuid:=gen_random_uuid(); r26_b uuid:=gen_random_uuid(); r28_job uuid:=gen_random_uuid(); r30_job uuid:=gen_random_uuid(); r31_job uuid:=gen_random_uuid();
 out jsonb; e public.business_events; n int; threads int;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,metadata) VALUES
  (r25_job,org,'accepted','fencing','C1C-261335','1VHBzZX6DsjMZW2WbgQn','{}'),
  (r1_a,org,'quoted','fencing','C1C-261448','lYPee0K2DuQHXH2xHL1P','{}'),
  (r1_b,org,'quoted','fencing','C1C-261431','lYPee0K2DuQHXH2xHL1P','{}'),
  (r9_job,org,'accepted','patio','C1C-26941','Oxqi7eCx2rGCsS0BXOH2','{}'),
  (r26_a,org,'quoted','fencing','C1C-261421','r26-contact-placeholder','{}'),
  (r26_b,org,'quoted','fencing','C1C-261422','r26-contact-placeholder','{}'),
  (r28_job,org,'accepted','fencing','C1C-R28','r28-contact-placeholder','{}'),
  (r30_job,org,'accepted','fencing','C1C-261424','r30-contact-placeholder','{}'),
  (r31_job,org,'accepted','fencing','C1C-261438','r31-contact-placeholder','{}');
 SELECT count(*) INTO threads FROM public.event_threads;

 -- R1: inbound, two open fencing quotes on the contact: review, never a guess;
 -- the conversation id is kept, never a job thread.
 out:=public.capture_business_event((SELECT r FROM c1c_rows WHERE label='r1'));
 IF out->>'outcome' IS DISTINCT FROM 'inserted' OR out->>'attribution_status' IS DISTINCT FROM 'pending_luna' OR out->>'job_id' IS NOT NULL THEN RAISE EXCEPTION 'c1c R1: %',out; END IF;
 SELECT * INTO e FROM public.business_events WHERE provider_message_id='ghl:pffXnIL1v2FTaKnz4DHm';
 IF e.event_type<>'client.reply' OR e.channel<>'sms' OR e.direction<>'inbound' OR e.thread_key IS NOT NULL OR e.conversation_key<>'I98nlO8dKPOAaylh7k23'
  OR e.event_at<>'2026-09-23T04:35:00Z' OR e.payload->>'body'<>'I haven''t received all three quotes as yet?' OR e.metadata->>'capture_mode'<>'live'
  OR e.source<>'ghl-webhook-receiver' THEN RAISE EXCEPTION 'c1c R1 stored: %',to_jsonb(e); END IF;
 -- GHL retries up to 12 times: a replay is a duplicate and changes nothing.
 out:=public.capture_business_event((SELECT r FROM c1c_rows WHERE label='r1'));
 IF out->>'outcome' IS DISTINCT FROM 'duplicate' OR (out->>'upgraded')::boolean THEN RAISE EXCEPTION 'c1c R1 replay: %',out; END IF;
 IF (SELECT count(*) FROM public.business_events WHERE provider_message_id='ghl:pffXnIL1v2FTaKnz4DHm')<>1 THEN RAISE EXCEPTION 'c1c R1: replay wrote a second row'; END IF;

 -- R3 "Thanks." and R4 (a GHL workflow follow-up) on the same contact: review;
 -- R4 records who sent it, so it is never counted as our human reply.
 out:=public.capture_business_event((SELECT r FROM c1c_rows WHERE label='r3'));
 IF out->>'attribution_status' IS DISTINCT FROM 'pending_luna' THEN RAISE EXCEPTION 'c1c R3: %',out; END IF;
 out:=public.capture_business_event((SELECT r FROM c1c_rows WHERE label='r4'));
 IF out->>'attribution_status' IS DISTINCT FROM 'pending_luna' THEN RAISE EXCEPTION 'c1c R4: %',out; END IF;
 IF (SELECT payload->>'sent_by_kind' FROM public.business_events WHERE provider_message_id='ghl:OPzxTmGv37UAMzf1hD3Q')<>'workflow' THEN
  RAISE EXCEPTION 'c1c R4: not recorded as a workflow text'; END IF;

 -- R9: "are the guys coming today?" to 774, one open job: single_open, line patio.
 out:=public.capture_business_event((SELECT r FROM c1c_rows WHERE label='r9'));
 IF out->>'attribution_status' IS DISTINCT FROM 'single_open' OR (out->>'job_id')::uuid IS DISTINCT FROM r9_job THEN RAISE EXCEPTION 'c1c R9: %',out; END IF;
 IF (SELECT payload->>'line' FROM public.business_events WHERE provider_message_id='ghl:1TPog9f79izPytVu8yoo')<>'patio' THEN RAISE EXCEPTION 'c1c R9: line'; END IF;

 -- R25: an internal note, full body, note / internal, linked single_open.
 out:=public.capture_business_event((SELECT r FROM c1c_rows WHERE label='r25'));
 IF out->>'outcome' IS DISTINCT FROM 'inserted' OR out->>'attribution_status' IS DISTINCT FROM 'single_open' OR (out->>'job_id')::uuid IS DISTINCT FROM r25_job THEN RAISE EXCEPTION 'c1c R25: %',out; END IF;
 SELECT * INTO e FROM public.business_events WHERE id=(out->>'id')::uuid;
 IF e.event_type<>'ghl.note_added' OR e.channel<>'note' OR e.direction<>'internal' OR e.payload->>'body'<>'Note text for the R25 fixture: price concession agreed.'
  OR e.provider_message_id<>'ghlnote:r25NotePlaceholder01:2026-09-08T02:10:00.000Z' THEN RAISE EXCEPTION 'c1c R25 stored: %',to_jsonb(e); END IF;

 -- R27: the NoteUpdate edit of R25 is a new row; R25's row is kept unchanged.
 out:=public.capture_business_event((SELECT r FROM c1c_rows WHERE label='r27'));
 IF out->>'outcome' IS DISTINCT FROM 'inserted' OR (out->>'job_id')::uuid IS DISTINCT FROM r25_job THEN RAISE EXCEPTION 'c1c R27: %',out; END IF;
 SELECT count(*) INTO n FROM public.business_events WHERE payload->>'ghl_note_id'='r25NotePlaceholder01';
 IF n<>2 THEN RAISE EXCEPTION 'c1c R27: expected the original and the edit, found % rows',n; END IF;
 IF (SELECT payload->>'body' FROM public.business_events WHERE provider_message_id='ghlnote:r25NotePlaceholder01:2026-09-08T02:10:00.000Z')
    <>'Note text for the R25 fixture: price concession agreed.' THEN RAISE EXCEPTION 'c1c R27: the edit overwrote the original'; END IF;
 IF (SELECT event_type FROM public.business_events WHERE id=(out->>'id')::uuid)<>'ghl.note_updated' THEN RAISE EXCEPTION 'c1c R27: event type'; END IF;

 -- R26: a scope handoff note on a contact with two option quotes: review.
 out:=public.capture_business_event((SELECT r FROM c1c_rows WHERE label='r26'));
 IF out->>'attribution_status' IS DISTINCT FROM 'pending_luna' OR out->>'job_id' IS NOT NULL THEN RAISE EXCEPTION 'c1c R26: %',out; END IF;

 -- R28: a task, status / internal (the live channel CHECK has no "task"),
 -- linked by the placement rules.
 out:=public.capture_business_event((SELECT r FROM c1c_rows WHERE label='r28'));
 IF out->>'outcome' IS DISTINCT FROM 'inserted' OR out->>'attribution_status' IS DISTINCT FROM 'single_open' OR (out->>'job_id')::uuid IS DISTINCT FROM r28_job THEN RAISE EXCEPTION 'c1c R28: %',out; END IF;
 SELECT * INTO e FROM public.business_events WHERE id=(out->>'id')::uuid;
 IF e.event_type<>'ghl.task_created' OR e.channel<>'status' OR e.direction<>'internal' OR e.payload->>'assigned_to'<>'r28-staff-user-placeholder'
 THEN RAISE EXCEPTION 'c1c R28 stored: %',to_jsonb(e); END IF;

 -- R29: completed, reopened, completed again: two completion rows; a retry of
 -- the first completion lands once.
 out:=public.capture_business_event((SELECT r FROM c1c_rows WHERE label='r29_first'));
 IF out->>'outcome' IS DISTINCT FROM 'inserted' THEN RAISE EXCEPTION 'c1c R29 first: %',out; END IF;
 out:=public.capture_business_event((SELECT r FROM c1c_rows WHERE label='r29_second'));
 IF out->>'outcome' IS DISTINCT FROM 'inserted' THEN RAISE EXCEPTION 'c1c R29 second: %',out; END IF;
 out:=public.capture_business_event((SELECT r FROM c1c_rows WHERE label='r29_first'));
 IF out->>'outcome' IS DISTINCT FROM 'duplicate' THEN RAISE EXCEPTION 'c1c R29 retry: %',out; END IF;
 SELECT count(*) INTO n FROM public.business_events WHERE event_type='ghl.task_completed' AND payload->>'ghl_task_id'='r28TaskPlaceholder01';
 IF n<>2 THEN RAISE EXCEPTION 'c1c R29: expected two completion rows, found %',n; END IF;

 -- R30: an appointment reschedule is a history row, never an answer path.
 out:=public.capture_business_event((SELECT r FROM c1c_rows WHERE label='r30'));
 IF out->>'attribution_status' IS DISTINCT FROM 'single_open' OR (out->>'job_id')::uuid IS DISTINCT FROM r30_job THEN RAISE EXCEPTION 'c1c R30: %',out; END IF;
 SELECT * INTO e FROM public.business_events WHERE id=(out->>'id')::uuid;
 IF e.event_type<>'ghl.appointment_updated' OR e.channel<>'status' OR e.payload->>'start_time'<>'2026-09-26T01:00:00.000Z'
  OR (e.payload->>'answer_path')::boolean THEN RAISE EXCEPTION 'c1c R30 stored: %',to_jsonb(e); END IF;

 -- R31: create linked single_open; the later delete recorded as its own row.
 out:=public.capture_business_event((SELECT r FROM c1c_rows WHERE label='r31_create'));
 IF out->>'attribution_status' IS DISTINCT FROM 'single_open' OR (out->>'job_id')::uuid IS DISTINCT FROM r31_job THEN RAISE EXCEPTION 'c1c R31 create: %',out; END IF;
 out:=public.capture_business_event((SELECT r FROM c1c_rows WHERE label='r31_delete'));
 IF out->>'outcome' IS DISTINCT FROM 'inserted' OR (out->>'job_id')::uuid IS DISTINCT FROM r31_job THEN RAISE EXCEPTION 'c1c R31 delete: %',out; END IF;
 IF (SELECT array_agg(event_type ORDER BY event_type) FROM public.business_events WHERE payload->>'ghl_appointment_id'='r31ApptPlaceholder01')
    <>ARRAY['ghl.appointment_created','ghl.appointment_deleted'] THEN RAISE EXCEPTION 'c1c R31: rows wrong'; END IF;

 -- Nothing here binds a job thread.
 IF (SELECT count(*) FROM public.event_threads)<>threads THEN RAISE EXCEPTION 'c1c: a receiver row bound a job thread'; END IF;
END $$;

-- 3. Slice T1: the call records a CallCompleted doorbell's targeted read saves
-- (transcripts.md §10 N1 to N3, recorded from GHL), through the same writer and
-- the live ladder. They pass the live channel and direction CHECKs, are keyed
-- ghl:<GHL message id> like a text, carry no words, and are placed by the
-- ladder: the SWP-26941 customer has one live job (the R9 job above), so each
-- call lands single_open on it. The job's creation time is pinned so the
-- at-time candidate rules read the same way whenever the contract runs.
DO $$
DECLARE job uuid; out jsonb; e public.business_events; lbl text; n int;
BEGIN
 SELECT id INTO job FROM public.jobs WHERE job_number='C1C-26941';
 UPDATE public.jobs SET created_at='2026-07-09T00:00:00Z' WHERE id=job;
 FOREACH lbl IN ARRAY ARRAY['n1','n2','n3'] LOOP
  out:=public.capture_business_event((SELECT r FROM c1c_rows WHERE label=lbl));
  IF out->>'outcome' IS DISTINCT FROM 'inserted' OR out->>'attribution_status' IS DISTINCT FROM 'single_open'
   OR (out->>'job_id')::uuid IS DISTINCT FROM job THEN RAISE EXCEPTION 'c1c T1 %: %',lbl,out; END IF;
  SELECT * INTO e FROM public.business_events WHERE id=(out->>'id')::uuid;
  IF e.event_type<>'client.call_logged' OR e.channel<>'call' OR e.source<>'ghl-webhook-receiver' OR e.thread_key IS NOT NULL
   OR e.conversation_key<>'3GOBTMJT1qEXkGwcodQK' OR e.metadata->>'capture_mode'<>'live' OR e.occurred_at IS NULL
   OR e.payload ? 'body' OR (e.payload->>'words')::boolean OR e.body_preview NOT LIKE '[Call, %'
  THEN RAISE EXCEPTION 'c1c T1 % stored: %',lbl,to_jsonb(e); END IF;
 END LOOP;
 SELECT * INTO e FROM public.business_events WHERE provider_message_id='ghl:6kn6WmrtfTMvhEJtmfeJ';
 IF e.direction<>'inbound' OR e.event_at<>'2026-09-23T07:40:55.171Z' OR (e.payload->>'duration_seconds')::numeric<>109
  OR e.payload->>'call_sid'<>'CAfcb0bf0b3d5308f16a6087ca116874a8' OR e.payload->>'line'<>'patio' THEN RAISE EXCEPTION 'c1c T1 N1 facts: %',to_jsonb(e); END IF;
 SELECT * INTO e FROM public.business_events WHERE provider_message_id='ghl:Py9PovOwc4I4vNkn9jXg';
 IF e.payload->>'call_status'<>'voicemail' OR e.payload->'duration_seconds'<>'null'::jsonb THEN RAISE EXCEPTION 'c1c T1 N2 facts: %',to_jsonb(e); END IF;
 SELECT * INTO e FROM public.business_events WHERE provider_message_id='ghl:0Gct0u0TQNZox8DRAVLo';
 IF e.direction<>'outbound' OR (e.payload->>'duration_seconds')::numeric<>67 THEN RAISE EXCEPTION 'c1c T1 N3 facts: %',to_jsonb(e); END IF;

 -- The webhook, the reconciler and lead-thread-capture meet the same key:
 -- a second save of N1 is a duplicate, never a second call row.
 out:=public.capture_business_event((SELECT r FROM c1c_rows WHERE label='n1'));
 IF out->>'outcome' IS DISTINCT FROM 'duplicate' THEN RAISE EXCEPTION 'c1c T1 N1 replay: %',out; END IF;
 SELECT count(*) INTO n FROM public.business_events WHERE provider_message_id='ghl:6kn6WmrtfTMvhEJtmfeJ';
 IF n<>1 THEN RAISE EXCEPTION 'c1c T1 N1: % rows for one call',n; END IF;

 -- A call GHL gave no direction for is stored `unknown`: the live direction CHECK accepts it.
 out:=public.capture_business_event(jsonb_set(jsonb_set((SELECT r FROM c1c_rows WHERE label='n3'),
  '{provider_message_id}','"ghl:t1UndirectedCall01"'),'{direction}','"unknown"'));
 IF out->>'outcome' IS DISTINCT FROM 'inserted' THEN RAISE EXCEPTION 'c1c T1 undirected call: %',out; END IF;
END $$;
ROLLBACK;

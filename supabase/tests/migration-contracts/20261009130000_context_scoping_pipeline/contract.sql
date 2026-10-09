-- Contract for 20261009130000_context_scoping_pipeline: the owner's ruling of 9 Oct 2026. The reader
-- reads active scoping (drafts), and the lead rule's window is the job type's: 6 weeks on a patio
-- job, 4 weeks on fencing and every other type. Failing first: section 1 runs first and reads only
-- the rule (context_lead_monitored_jobs), which exists before this migration, and fails on its
-- earlier body (break-contract.sql runs this migration's rollback and expects section 1's first check
-- to fail).
--  1. The rule, as of a fixed instant (Wed 7 Oct 2026 10:00 Perth): a draft is monitored while the
--     instant is inside its window after the newer of its newest real activity and its creation,
--     never with no real activity; each kind of real activity counts (a customer's text, our own
--     text, a call, a staff note, the customer's old-inbox mail, a quote viewed or declined, a scope
--     saved, a photo added) and nothing else does (the job created, the CRM link, the scoping tool's
--     refused and version rows, a workflow text, our crew template, mail among our own people, a
--     document's text, a marked copy, a retracted row, a CRM text with no kept time, a council's or
--     our own old-inbox mail, an auto-reply or spam, a text on the customer's other draft); the
--     window's edges on fencing (28 days), patio (42) and decking (28); a lead at quoted keeps the
--     7 Oct rule in its type's window (6 weeks on a patio lead, 4 on fencing); with no ids only the
--     drafts the rule monitors are listed; the one-job form is the same row; earlier instants.
--  2. The ledger (instants relative to now, since the judge judges now): a monitored draft is due a
--     backfill and claimed; a draft the rule does not monitor (quiet, or never touched) is not_live
--     and a claim answers not_due; a patio draft inside its 6 weeks is due; a lead no longer
--     followed up is still lead_not_monitored; the rollout list and the mode still decide.
--  3. The story: a patio lead no longer followed up says "6 weeks" in R7 and the first line; a quiet
--     patio draft with a quote out keeps its R7 and its line (no lead words, the customer's move)
--     while now.monitored is false; an active draft is monitored; a draft's phase is enquiry or
--     scope; the pure assembler is off only for a lead not followed up, never for a draft state.
--  4. The scorecard: live_jobs and monitored_jobs count a monitored draft, never a quiet or untouched
--     one, and leads_not_followed_up counts only the lead; the per-job page lists the monitored draft.
--  5. The window function: its numbers, flags and access.
--  6. Shape and access of the replaced bodies: flags, grants, the rule's columns, slice names first.
--  7. Re-applying changes nothing.
--  8. The service role reads the rule directly with drafts in the set, in a fresh session with the
--     table grants production has, while the record layer's ladder helper stays revoked from it.
-- Every fixture row is synthetic and rolled back; user triggers are off for it, and the column
-- defaults that would stamp the wall clock are pinned inside each fixture transaction.

-- 1 shares these fixtures (fixed instant 2026-10-07 02:00Z).
BEGIN;
SET LOCAL session_replication_role = replica;
ALTER TABLE public.business_events ALTER COLUMN context_captured_at SET DEFAULT '2026-07-01 00:00Z',
 ALTER COLUMN recorded_at SET DEFAULT '2026-07-01 00:00Z', ALTER COLUMN occurred_at SET DEFAULT '2026-07-01 00:00Z';
ALTER TABLE public.job_documents ALTER COLUMN created_at SET DEFAULT '2026-07-01 00:00Z';
ALTER TABLE public.job_events ALTER COLUMN created_at SET DEFAULT '2026-07-01 00:00Z';
ALTER TABLE public.jobs ALTER COLUMN created_at SET DEFAULT '2026-07-01 00:00Z', ALTER COLUMN updated_at SET DEFAULT '2026-07-01 00:00Z';
ALTER TABLE public.inbox_events ALTER COLUMN received_at SET DEFAULT '2026-07-01 00:00Z';

INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, client_email, ghl_contact_id, pricing_json, quoted_at, accepted_at,
  created_at, updated_at)
VALUES
 -- fencing drafts: a customer text 27 days ago (one), 28 days ago to the instant (two)
 ('9a000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000aa', 'SWF-99001', 'draft', 'fencing', 'Draft One', NULL, 'ct9901', '{}', NULL, NULL, '2026-08-08 02:00Z', '2026-08-08 02:00Z'),
 ('9a000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000aa', 'SWF-99002', 'draft', 'fencing', 'Draft Two', NULL, 'ct9902', '{}', NULL, NULL, '2026-08-08 02:00Z', '2026-08-08 02:00Z'),
 -- patio drafts: a customer text 28 days ago (three: inside its 6 weeks), our own text 42 days ago to the instant (four)
 ('9a000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000aa', 'SWP-99003', 'draft', 'patio', 'Draft Three', NULL, 'ct9903', '{}', NULL, NULL, '2026-08-08 02:00Z', '2026-08-08 02:00Z'),
 ('9a000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-0000000000aa', 'SWP-99004', 'draft', 'patio', 'Draft Four', NULL, 'ct9904', '{}', NULL, NULL, '2026-07-01 02:00Z', '2026-07-01 02:00Z'),
 -- made 2 days ago and nothing since but the machine rows (five); made 10 days ago, its only
 -- message 35 days ago, before it was made (six)
 ('9a000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-0000000000aa', 'SWF-99005', 'draft', 'fencing', 'Draft Five', NULL, 'ct9905', '{}', NULL, NULL, '2026-10-05 02:00Z', '2026-10-05 02:00Z'),
 ('9a000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-0000000000aa', 'SWF-99006', 'draft', 'fencing', 'Draft Six', NULL, 'ct9906', '{}', NULL, NULL, '2026-09-27 02:00Z', '2026-09-27 02:00Z'),
 -- a scope saved 3 days ago (seven); nothing that counts, everything that does not (eight)
 ('9a000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-0000000000aa', 'SWF-99007', 'draft', 'fencing', 'Draft Seven', NULL, 'ct9907', '{}', NULL, NULL, '2026-07-01 02:00Z', '2026-07-01 02:00Z'),
 ('9a000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-0000000000aa', 'SWF-99008', 'draft', 'fencing', 'Draft Eight', 'd8@example.test', 'ct9908', '{}', NULL, NULL, '2026-07-01 02:00Z', '2026-07-01 02:00Z'),
 -- patio drafts with a quote: viewed 20 days ago (nine), declined 50 days ago (ten)
 ('9a000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-0000000000aa', 'SWP-99009', 'draft', 'patio', 'Draft Nine', NULL, 'ct9909', '{}', NULL, NULL, '2026-06-01 02:00Z', '2026-06-01 02:00Z'),
 ('9a000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-0000000000aa', 'SWP-99010', 'draft', 'patio', 'Draft Ten', NULL, 'ct9910', '{}', NULL, NULL, '2026-06-01 02:00Z', '2026-06-01 02:00Z'),
 -- one customer, two booking drafts: their text is on the twelfth, the eleventh has nothing
 ('9a000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-0000000000aa', 'SWF-99011', 'draft', 'fencing', 'Draft Eleven', NULL, 'ct9911', '{}', NULL, NULL, '2026-09-30 02:00Z', '2026-09-30 02:00Z'),
 ('9a000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-0000000000aa', 'SWF-99012', 'draft', 'fencing', 'Draft Eleven', NULL, 'ct9911', '{}', NULL, NULL, '2026-09-30 02:00Z', '2026-09-30 02:00Z'),
 -- the customer's old-inbox mail from the client's address (thirteen); a staff note (fourteen)
 ('9a000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-0000000000aa', 'SWF-99013', 'draft', 'fencing', 'Draft Thirteen', 'd13@example.test', 'ct9913', '{}', NULL, NULL, '2026-07-01 02:00Z', '2026-07-01 02:00Z'),
 ('9a000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-0000000000aa', 'SWF-99014', 'draft', 'fencing', 'Draft Fourteen', NULL, 'ct9914', '{}', NULL, NULL, '2026-07-01 02:00Z', '2026-07-01 02:00Z'),
 -- a decking draft, a customer text 28 days ago to the instant: every other type has 4 weeks (fifteen)
 ('9a000000-0000-4000-8000-000000000015', '00000000-0000-4000-8000-0000000000aa', 'SWF-99015', 'draft', 'decking', 'Draft Fifteen', NULL, 'ct9915', '{}', NULL, NULL, '2026-08-08 02:00Z', '2026-08-08 02:00Z'),
 -- a missed call (sixteen); the client's address is our own mailbox, its mail never counts (seventeen);
 -- a photo added (eighteen)
 ('9a000000-0000-4000-8000-000000000016', '00000000-0000-4000-8000-0000000000aa', 'SWF-99016', 'draft', 'fencing', 'Draft Sixteen', NULL, 'ct9916', '{}', NULL, NULL, '2026-07-01 02:00Z', '2026-07-01 02:00Z'),
 ('9a000000-0000-4000-8000-000000000017', '00000000-0000-4000-8000-0000000000aa', 'SWF-99017', 'draft', 'fencing', 'Draft Seventeen', 'office@secureworkswa.com.au', 'ct9917', '{}', NULL, NULL, '2026-07-01 02:00Z', '2026-07-01 02:00Z'),
 ('9a000000-0000-4000-8000-000000000018', '00000000-0000-4000-8000-0000000000aa', 'SWF-99018', 'draft', 'fencing', 'Draft Eighteen', NULL, 'ct9918', '{}', NULL, NULL, '2026-07-01 02:00Z', '2026-07-01 02:00Z'),
 -- leads at quoted: patio sent 30 days ago (twenty-one), patio sent 43 days ago (twenty-two),
 -- fencing sent 30 days ago (twenty-three), patio sent 48 days ago and the customer's email 27 days ago (twenty-four)
 ('9a000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-0000000000aa', 'SWP-99021', 'quoted', 'patio', 'Lead Twenty-One', NULL, 'ct9921', '{}', NULL, NULL, '2026-07-01 02:00Z', '2026-07-01 02:00Z'),
 ('9a000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-0000000000aa', 'SWP-99022', 'quoted', 'patio', 'Lead Twenty-Two', NULL, 'ct9922', '{}', NULL, NULL, '2026-07-01 02:00Z', '2026-07-01 02:00Z'),
 ('9a000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-0000000000aa', 'SWF-99023', 'quoted', 'fencing', 'Lead Twenty-Three', NULL, 'ct9923', '{}', NULL, NULL, '2026-07-01 02:00Z', '2026-07-01 02:00Z'),
 ('9a000000-0000-4000-8000-000000000024', '00000000-0000-4000-8000-0000000000aa', 'SWP-99024', 'quoted', 'patio', 'Lead Twenty-Four', NULL, 'ct9924', '{}', NULL, NULL, '2026-07-01 02:00Z', '2026-07-01 02:00Z');

INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at, viewed_at, accepted_at, declined_at, superseded_at)
VALUES
 ('9a0e0000-0000-4000-8000-000000000009', '9a000000-0000-4000-8000-000000000009', 'quote', 'Q-99009', 1, '2026-06-10 01:00Z', '2026-06-10 02:00Z', '2026-09-17 02:00Z', NULL, NULL, NULL),
 ('9a0e0000-0000-4000-8000-000000000010', '9a000000-0000-4000-8000-000000000010', 'quote', 'Q-99010', 1, '2026-06-15 01:00Z', '2026-06-15 02:00Z', NULL, NULL, '2026-08-18 02:00Z', NULL),
 -- a quote made on a draft and never sent: no activity of its own (eight)
 ('9a0e0000-0000-4000-8000-000000000008', '9a000000-0000-4000-8000-000000000008', 'quote', 'Q-99008', 1, '2026-10-04 01:00Z', NULL, NULL, NULL, NULL, NULL),
 ('9a0e0000-0000-4000-8000-000000000021', '9a000000-0000-4000-8000-000000000021', 'quote', 'Q-99021', 1, '2026-09-07 01:00Z', '2026-09-07 02:00Z', NULL, NULL, NULL, NULL),
 ('9a0e0000-0000-4000-8000-000000000022', '9a000000-0000-4000-8000-000000000022', 'quote', 'Q-99022', 1, '2026-08-25 01:00Z', '2026-08-25 02:00Z', NULL, NULL, NULL, NULL),
 ('9a0e0000-0000-4000-8000-000000000023', '9a000000-0000-4000-8000-000000000023', 'quote', 'Q-99023', 1, '2026-09-07 01:00Z', '2026-09-07 02:00Z', NULL, NULL, NULL, NULL),
 ('9a0e0000-0000-4000-8000-000000000024', '9a000000-0000-4000-8000-000000000024', 'quote', 'Q-99024', 1, '2026-08-20 01:00Z', '2026-08-20 02:00Z', NULL, NULL, NULL, NULL);

INSERT INTO public.job_events (id, job_id, event_type, detail_json, created_at)
VALUES
 -- five and eight: the machine rows only
 ('9a0f0000-0000-4000-8000-000000000051', '9a000000-0000-4000-8000-000000000005', 'job_created', '{"source":"ghl_picker"}', '2026-10-05 02:00Z'),
 ('9a0f0000-0000-4000-8000-000000000052', '9a000000-0000-4000-8000-000000000005', 'ghl_linked', '{}', '2026-10-05 02:01Z'),
 ('9a0f0000-0000-4000-8000-000000000081', '9a000000-0000-4000-8000-000000000008', 'ghl_linked', '{}', '2026-10-04 02:00Z'),
 ('9a0f0000-0000-4000-8000-000000000082', '9a000000-0000-4000-8000-000000000008', 'scope_version_updated', '{}', '2026-10-04 02:00Z'),
 ('9a0f0000-0000-4000-8000-000000000083', '9a000000-0000-4000-8000-000000000008', 'scope_save_rejected', '{"source":"tool"}', '2026-10-04 02:00Z'),
 ('9a0f0000-0000-4000-8000-000000000084', '9a000000-0000-4000-8000-000000000008', 'scope_save_identity_warning', '{}', '2026-10-04 02:00Z'),
 ('9a0f0000-0000-4000-8000-000000000085', '9a000000-0000-4000-8000-000000000008', 'deduped_orphan', '{}', '2026-10-04 02:00Z'),
 -- seven: a scope saved in the scoping tool 3 days ago
 ('9a0f0000-0000-4000-8000-000000000071', '9a000000-0000-4000-8000-000000000007', 'scope_saved', '{"source":"tool"}', '2026-10-04 02:00Z'),
 -- eighteen: a photo added 4 days ago
 ('9a0f0000-0000-4000-8000-000000000181', '9a000000-0000-4000-8000-000000000018', 'photo_added', '{}', '2026-10-03 02:00Z');

INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_confidence, candidate_job_ids)
VALUES
 ('9a0b0000-0000-4000-8000-000000000001', '9a000000-0000-4000-8000-000000000001', 'client.reply', 'ghl', 'sms', 'inbound', 'ct9901',
  '{"body":"Can you come out next week?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
  '2026-09-10 02:00Z', '2026-09-10 02:00Z', '2026-09-10 02:00Z', '2026-09-10 02:00Z', 'direct', 1, NULL),
 ('9a0b0000-0000-4000-8000-000000000002', '9a000000-0000-4000-8000-000000000002', 'client.reply', 'ghl', 'sms', 'inbound', 'ct9902',
  '{"body":"Can you come out next week?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
  '2026-09-09 02:00Z', '2026-09-09 02:00Z', '2026-09-09 02:00Z', '2026-09-09 02:00Z', 'direct', 1, NULL),
 ('9a0b0000-0000-4000-8000-000000000003', '9a000000-0000-4000-8000-000000000003', 'client.reply', 'ghl', 'sms', 'inbound', 'ct9903',
  '{"body":"Is the patio quote ready?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
  '2026-09-09 02:00Z', '2026-09-09 02:00Z', '2026-09-09 02:00Z', '2026-09-09 02:00Z', 'direct', 1, NULL),
 -- four: our own text to the customer (not a workflow) 42 days ago
 ('9a0b0000-0000-4000-8000-000000000004', '9a000000-0000-4000-8000-000000000004', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct9904',
  '{"body":"Hi, following up on your patio enquiry"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff","recipient_role":"customer","audience":"customer"}}',
  '2026-08-26 02:00Z', '2026-08-26 02:00Z', '2026-08-26 02:00Z', '2026-08-26 02:00Z', 'direct', 1, NULL),
 ('9a0b0000-0000-4000-8000-000000000006', '9a000000-0000-4000-8000-000000000006', 'client.reply', 'ghl', 'sms', 'inbound', 'ct9906',
  '{"body":"Looking for a fence quote"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
  '2026-09-02 02:00Z', '2026-09-02 02:00Z', '2026-09-02 02:00Z', '2026-09-02 02:00Z', 'direct', 1, NULL),
 -- eight: a workflow text, our crew template, mail among our own people, a document's text, a
 -- marked copy, a retracted text, a CRM text whose CRM time is not kept, all 3 days ago
 ('9a0b0000-0000-4000-8000-000000000081', '9a000000-0000-4000-8000-000000000008', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct9908',
  '{"body":"Your booking is confirmed","sent_by_kind":"workflow"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff","audience":"customer"}}',
  '2026-10-04 02:00Z', '2026-10-04 02:00Z', '2026-10-04 02:00Z', '2026-10-04 02:00Z', 'direct', 1, NULL),
 ('9a0b0000-0000-4000-8000-000000000082', '9a000000-0000-4000-8000-000000000008', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ctCrew99',
  '{"body":"New job assigned: SWF-99008 fence scope"}', '{}',
  '2026-10-04 02:00Z', '2026-10-04 02:00Z', '2026-10-04 02:00Z', '2026-10-04 02:00Z', 'direct', 1, NULL),
 ('9a0b0000-0000-4000-8000-000000000083', '9a000000-0000-4000-8000-000000000008', 'staff.email_internal', 'outlook-mail-capture', 'email', 'internal', NULL,
  '{"body":"Can someone look at this one?","from":"sales@secureworkswa.com.au","subject":"Fence"}',
  '{"party_roles":{"sender_role":"staff","recipient_role":"staff","audience":"internal"}}',
  '2026-10-04 02:00Z', '2026-10-04 02:00Z', '2026-10-04 02:00Z', '2026-10-04 02:00Z', 'direct', 1, NULL),
 ('9a0b0000-0000-4000-8000-000000000084', '9a000000-0000-4000-8000-000000000008', 'document.text_extracted', 'document-text', 'document', 'inbound', NULL,
  '{"body":"Site plan, 24 m of fence"}', '{}',
  '2026-10-04 02:00Z', '2026-10-04 02:00Z', '2026-10-04 02:00Z', '2026-10-04 02:00Z', 'direct', 1, NULL),
 ('9a0b0000-0000-4000-8000-000000000085', '9a000000-0000-4000-8000-000000000008', 'client.reply', 'ghl', 'sms', 'inbound', 'ct9908',
  '{"body":"A copy of a text"}', '{"duplicate_of":"9a0b0000-0000-4000-8000-000000000099","party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
  '2026-10-04 02:00Z', '2026-10-04 02:00Z', '2026-10-04 02:00Z', '2026-10-04 02:00Z', 'direct', 1, NULL),
 ('9a0b0000-0000-4000-8000-000000000086', '9a000000-0000-4000-8000-000000000008', 'client.reply', 'ghl', 'sms', 'inbound', 'ct9908',
  '{"body":"A text taken back"}', '{"retracted_at":"2026-10-05T02:00:00Z","party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
  '2026-10-04 02:00Z', '2026-10-04 02:00Z', '2026-10-04 02:00Z', '2026-10-04 02:00Z', 'direct', 1, NULL),
 ('9a0b0000-0000-4000-8000-000000000087', '9a000000-0000-4000-8000-000000000008', 'client.reply', 'ghl_sms_cache_backfill', 'sms', 'inbound', 'ct9908',
  '{"body":"Loaded later from the CRM cache","ghl_message_id":"m99-87"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
  '2026-10-04 02:00Z', '2026-10-04 02:00Z', '2026-10-04 02:00Z', '2026-10-04 02:00Z', 'direct', 1, NULL),
 -- twelve: the customer's text on their second booking draft, 2 days ago (never the eleventh's)
 ('9a0b0000-0000-4000-8000-000000000012', '9a000000-0000-4000-8000-000000000012', 'client.reply', 'ghl', 'sms', 'inbound', 'ct9911',
  '{"body":"Booked for Thursday, thanks"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
  '2026-10-05 02:00Z', '2026-10-05 02:00Z', '2026-10-05 02:00Z', '2026-10-05 02:00Z', 'direct', 1, NULL),
 -- fourteen: a staff note 5 days ago
 ('9a0b0000-0000-4000-8000-000000000014', '9a000000-0000-4000-8000-000000000014', 'note.added', 'ops-api', 'note', 'internal', NULL,
  '{"body":"Measured up, quote to follow"}', '{}',
  '2026-10-02 02:00Z', '2026-10-02 02:00Z', '2026-10-02 02:00Z', '2026-10-02 02:00Z', 'direct', 1, NULL),
 ('9a0b0000-0000-4000-8000-000000000015', '9a000000-0000-4000-8000-000000000015', 'client.reply', 'ghl', 'sms', 'inbound', 'ct9915',
  '{"body":"Can you do a deck too?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
  '2026-09-09 02:00Z', '2026-09-09 02:00Z', '2026-09-09 02:00Z', '2026-09-09 02:00Z', 'direct', 1, NULL),
 -- sixteen: the customer's missed call 6 days ago
 ('9a0b0000-0000-4000-8000-000000000016', '9a000000-0000-4000-8000-000000000016', 'client.call_logged', 'ghl', 'call', 'inbound', 'ct9916',
  '{"body":"Call. Provider status: no-answer. Duration: 0 seconds","call_status":"no-answer"}',
  '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
  '2026-10-01 02:00Z', '2026-10-01 02:00Z', '2026-10-01 02:00Z', '2026-10-01 02:00Z', 'direct', 1, NULL),
 -- twenty-four: the customer's email on the lead 27 days ago
 ('9a0b0000-0000-4000-8000-000000000024', '9a000000-0000-4000-8000-000000000024', 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', 'ct9924',
  '{"body":"We are still deciding","from":"lead24@example.test","subject":"Patio"}',
  '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
  '2026-09-10 02:00Z', '2026-09-10 02:00Z', '2026-09-10 02:00Z', '2026-09-10 02:00Z', 'direct', 1, NULL);

-- the old inbox: thirteen's customer from the client's address (a case and space variant), 5 days
-- ago; eight's council mail, our own mail, an auto-reply and spam from the client's address;
-- seventeen's mail from its client address, which is our own mailbox
INSERT INTO public.inbox_events (id, job_id, from_email, subject, body_preview, received_at, processed_at, graph_message_id, mailbox, classification)
VALUES ('9a0d0000-0000-4000-8000-000000000013', '9a000000-0000-4000-8000-000000000013', ' D13@Example.test', 'Fence', 'When can you start?',
        '2026-10-02 02:00Z', '2026-10-02 02:00Z', 'g99-13', 'office@example.test', 'client_reply'),
       ('9a0d0000-0000-4000-8000-000000000081', '9a000000-0000-4000-8000-000000000008', 'planning@council.example.gov.au', 'Approval', 'Your application',
        '2026-10-04 02:00Z', '2026-10-04 02:00Z', 'g99-81', 'office@example.test', 'council'),
       ('9a0d0000-0000-4000-8000-000000000082', '9a000000-0000-4000-8000-000000000008', 'jan@secureworkswa.com.au', 'Fence', 'Forwarding this',
        '2026-10-04 02:00Z', '2026-10-04 02:00Z', 'g99-82', 'office@example.test', 'other'),
       ('9a0d0000-0000-4000-8000-000000000083', '9a000000-0000-4000-8000-000000000008', 'd8@example.test', 'Automatic reply: Fence', 'I am away',
        '2026-10-04 02:00Z', '2026-10-04 02:00Z', 'g99-83', 'office@example.test', 'client_reply'),
       ('9a0d0000-0000-4000-8000-000000000084', '9a000000-0000-4000-8000-000000000008', 'd8@example.test', 'Fence', 'Buy now',
        '2026-10-04 02:00Z', '2026-10-04 02:00Z', 'g99-84', 'office@example.test', 'spam'),
       ('9a0d0000-0000-4000-8000-000000000017', '9a000000-0000-4000-8000-000000000017', 'office@secureworkswa.com.au', 'Roster', 'Next week',
        '2026-10-02 02:00Z', '2026-10-02 02:00Z', 'g99-17', 'office@example.test', 'client_reply');

-- 1. The rule, as of each instant.
DO $rule$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; got text; want text;
BEGIN
 SELECT string_agg(concat_ws(' ', m.job_number, m.monitored::text, m.state, coalesce(to_char(m.quote_sent_at AT TIME ZONE 'UTC', 'MM-DD HH24:MI'), '-'),
                             coalesce(to_char(m.customer_at AT TIME ZONE 'UTC', 'MM-DD HH24:MI'), '-'), coalesce(to_char(m.cutoff_at AT TIME ZONE 'UTC', 'MM-DD HH24:MI'), '-')),
                   E'\n' ORDER BY m.job_number COLLATE "C") INTO got
 FROM public.context_lead_monitored_jobs(ARRAY(SELECT jb.id FROM public.jobs jb WHERE jb.job_number LIKE 'SW_-990%'), asof) m;
 want := concat_ws(E'\n',
  'SWF-99001 true draft_active - - 10-08 02:00',
  'SWF-99002 false draft_quiet - - 10-07 02:00',
  'SWF-99005 false draft_no_activity - - -',
  'SWF-99006 true draft_active - - 10-25 02:00',
  'SWF-99007 true draft_active - - 11-01 02:00',
  'SWF-99008 false draft_no_activity - - -',
  'SWF-99011 false draft_no_activity - - -',
  'SWF-99012 true draft_active - - 11-02 02:00',
  'SWF-99013 true draft_active - - 10-30 02:00',
  'SWF-99014 true draft_active - - 10-30 02:00',
  'SWF-99015 false draft_quiet - - 10-07 02:00',
  'SWF-99016 true draft_active - - 10-29 02:00',
  'SWF-99017 false draft_no_activity - - -',
  'SWF-99018 true draft_active - - 10-31 02:00',
  'SWF-99023 false not_followed_up 09-07 02:00 - 10-05 02:00',
  'SWP-99003 true draft_active - - 10-21 02:00',
  'SWP-99004 false draft_quiet - - 10-07 02:00',
  'SWP-99009 true draft_active 06-10 02:00 - 10-29 02:00',
  'SWP-99010 false draft_quiet 06-15 02:00 - 09-29 02:00',
  'SWP-99021 true within_6_weeks 09-07 02:00 - 10-19 02:00',
  'SWP-99022 false not_followed_up 08-25 02:00 - 10-06 02:00',
  'SWP-99024 true within_6_weeks 08-20 02:00 09-10 02:00 10-22 02:00');
 IF got IS DISTINCT FROM want THEN
  RAISE EXCEPTION 'scoping pipeline contract: the rule as of Wed 7 Oct 2026 10:00 Perth:% got% want%', E'\n', E'\n' || got || E'\n', E'\n' || want;
 END IF;
 -- as of other instants: one before its first text (nothing yet) and the instant its 4 weeks run out;
 -- six before it was made; the patio lead the day before and the instant its 6 weeks run out
 SELECT string_agg(concat_ws(' ', x.n, m.monitored::text, m.state), ', ' ORDER BY x.o) INTO got
 FROM (VALUES (1, 'SWF-99001', '2026-09-09 02:00Z'::timestamptz), (2, 'SWF-99001', '2026-10-08 02:00Z'), (3, 'SWF-99001', '2026-10-08 01:59:59Z'),
              (4, 'SWP-99022', '2026-10-05 02:00Z'), (5, 'SWP-99022', '2026-10-06 02:00Z'), (6, 'SWP-99003', '2026-10-21 02:00Z')) x(o, n, at)
 JOIN public.jobs jb ON jb.job_number = x.n
 CROSS JOIN LATERAL public.context_lead_monitored_jobs(ARRAY[jb.id], x.at) m;
 want := 'SWF-99001 false draft_no_activity, SWF-99001 false draft_quiet, SWF-99001 true draft_active, '
         || 'SWP-99022 true within_6_weeks, SWP-99022 false not_followed_up, SWP-99003 false draft_quiet';
 IF got IS DISTINCT FROM want THEN
  RAISE EXCEPTION 'scoping pipeline contract: the rule as of earlier instants: got % want %', got, want;
 END IF;
 -- with no ids: every live job, a draft only while it is monitored (never a quiet or untouched one)
 SELECT string_agg(m.job_number || ':' || m.monitored::text, ',' ORDER BY m.job_number COLLATE "C") INTO got
 FROM public.context_lead_monitored_jobs(NULL, asof) m WHERE m.job_number LIKE 'SW_-990%';
 IF got IS DISTINCT FROM 'SWF-99001:true,SWF-99006:true,SWF-99007:true,SWF-99012:true,SWF-99013:true,SWF-99014:true,SWF-99016:true,SWF-99018:true,'
                         || 'SWF-99023:false,SWP-99003:true,SWP-99009:true,SWP-99021:true,SWP-99022:false,SWP-99024:true' THEN
  RAISE EXCEPTION 'scoping pipeline contract: with no ids the rule lists the live jobs, a draft only while monitored: %', got;
 END IF;
 -- the one-job form is the set form's row for a draft too
 IF EXISTS (SELECT 1 FROM public.jobs jb CROSS JOIN LATERAL public.context_lead_monitored(jb.id, asof) lm
            JOIN public.context_lead_monitored_jobs(ARRAY(SELECT o.id FROM public.jobs o WHERE o.job_number LIKE 'SW_-990%'), asof) m ON m.job_id = jb.id
            WHERE jb.job_number LIKE 'SW_-990%' AND (lm.job_id, lm.job_number, lm.monitored, lm.state, lm.quote_sent_at, lm.customer_at, lm.cutoff_at)
                  IS DISTINCT FROM (m.job_id, m.job_number, m.monitored, m.state, m.quote_sent_at, m.customer_at, m.cutoff_at))
    OR (SELECT count(*) FROM public.jobs jb CROSS JOIN LATERAL public.context_lead_monitored(jb.id, asof) lm WHERE jb.job_number LIKE 'SW_-990%') <> 22 THEN
  RAISE EXCEPTION 'scoping pipeline contract: the one-job form must be the set form''s row';
 END IF;
END $rule$;
ROLLBACK;

-- 2. The ledger. The judge judges now, so these fixtures are placed relative to now; the ledger is in
-- shadow for the listed jobs only, the backfill hours open all day, every lane on.
BEGIN;
SET LOCAL session_replication_role = replica;
ALTER TABLE public.business_events ALTER COLUMN context_captured_at SET DEFAULT now() - interval '90 days',
 ALTER COLUMN recorded_at SET DEFAULT now() - interval '90 days';
UPDATE public.automation_switches SET capture = true, attribution = true, extraction = true, all_stop = false WHERE id = 1;
UPDATE public.context_ledger_settings SET mode = 'shadow', backfill_from_hour = NULL, backfill_to_hour = NULL,
 job_ids = ARRAY['9a000000-0000-4000-8000-000000000101', '9a000000-0000-4000-8000-000000000102', '9a000000-0000-4000-8000-000000000103',
                 '9a000000-0000-4000-8000-000000000104', '9a000000-0000-4000-8000-000000000105']::uuid[]
WHERE id;
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, ghl_contact_id, pricing_json, created_at, updated_at)
VALUES ('9a000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-0000000000aa', 'SWF-99101', 'draft', 'fencing', 'Draft A', 'ct99101', '{}', now() - interval '60 days', now() - interval '60 days'),
       ('9a000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-0000000000aa', 'SWF-99102', 'draft', 'fencing', 'Draft Q', 'ct99102', '{}', now() - interval '60 days', now() - interval '60 days'),
       ('9a000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-0000000000aa', 'SWF-99103', 'draft', 'fencing', 'Draft N', 'ct99103', '{}', now() - interval '1 day', now() - interval '1 day'),
       ('9a000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-0000000000aa', 'SWP-99104', 'draft', 'patio', 'Draft P', 'ct99104', '{}', now() - interval '60 days', now() - interval '60 days'),
       ('9a000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-0000000000aa', 'SWF-99105', 'quoted', 'fencing', 'Lead L', 'ct99105', '{}', now() - interval '60 days', now() - interval '60 days'),
       ('9a000000-0000-4000-8000-000000000106', '00000000-0000-4000-8000-0000000000aa', 'SWF-99106', 'draft', 'fencing', 'Draft R', 'ct99106', '{}', now() - interval '60 days', now() - interval '60 days');
INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at)
VALUES ('9a0e0000-0000-4000-8000-000000000105', '9a000000-0000-4000-8000-000000000105', 'quote', 'Q-99105', 1, now() - interval '41 days', now() - interval '40 days');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_confidence)
SELECT x.id::uuid, x.job::uuid, 'client.reply', 'ghl', 'sms', 'inbound', x.ct, jsonb_build_object('body', x.body),
       '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}', now() - x.ago, now() - x.ago, now() - x.ago, now() - x.ago,
       'direct', 1
FROM (VALUES ('9a0b0000-0000-4000-8000-000000000101', '9a000000-0000-4000-8000-000000000101', 'ct99101', 'Can you quote the back fence?', interval '2 days'),
             ('9a0b0000-0000-4000-8000-000000000102', '9a000000-0000-4000-8000-000000000102', 'ct99102', 'Can you quote the back fence?', interval '40 days'),
             ('9a0b0000-0000-4000-8000-000000000104', '9a000000-0000-4000-8000-000000000104', 'ct99104', 'Is the patio design ready?', interval '35 days'),
             ('9a0b0000-0000-4000-8000-000000000105', '9a000000-0000-4000-8000-000000000105', 'ct99105', 'Thanks, we will think about it', interval '39 days'),
             ('9a0b0000-0000-4000-8000-000000000106', '9a000000-0000-4000-8000-000000000106', 'ct99106', 'Can you quote the side fence?', interval '1 day')
     ) x(id, job, ct, body, ago);
DO $ledger$
DECLARE r record; c jsonb; due text;
BEGIN
 -- the judgement, job by job (fails on the earlier judge: every draft not_live)
 FOR r IN SELECT d.*, jb.job_number FROM public.context_ledger_judge(ARRAY['9a000000-0000-4000-8000-000000000101', '9a000000-0000-4000-8000-000000000102',
            '9a000000-0000-4000-8000-000000000103', '9a000000-0000-4000-8000-000000000104', '9a000000-0000-4000-8000-000000000105',
            '9a000000-0000-4000-8000-000000000106']::uuid[]) d JOIN public.jobs jb ON jb.id = d.job_id LOOP
  IF NOT CASE r.job_number
     -- a draft the customer texted 2 days ago, and a patio draft texted 35 days ago (inside its 6 weeks): a backfill
     WHEN 'SWF-99101' THEN r.due AND r.kind = 'backfill' AND r.reason = 'never_read' AND r.blocked_reason IS NULL AND r.evidence_rows = 1
     WHEN 'SWP-99104' THEN r.due AND r.kind = 'backfill' AND r.reason = 'never_read' AND r.blocked_reason IS NULL
     -- a draft whose 4 weeks ran out, and one made yesterday that nothing happened on: not live, as before
     WHEN 'SWF-99102' THEN NOT r.due AND r.blocked_reason = 'not_live'
     WHEN 'SWF-99103' THEN NOT r.due AND r.blocked_reason = 'not_live'
     -- a lead no longer followed up, as before
     WHEN 'SWF-99105' THEN NOT r.due AND r.blocked_reason = 'lead_not_monitored'
     -- a monitored draft off the rollout list
     WHEN 'SWF-99106' THEN NOT r.due AND r.kind = 'backfill' AND r.blocked_reason = 'not_in_rollout' END THEN
   RAISE EXCEPTION 'scoping pipeline contract: judgement of %: %', r.job_number, row_to_json(r);
  END IF;
 END LOOP;
 -- the due list holds the monitored drafts on the rollout list, newest evidence first
 SELECT string_agg(jb.job_number, ',' ORDER BY x.ord) INTO due
 FROM public.context_ledger_due(200) WITH ORDINALITY x(job_id, kind, reason, priority, newest_evidence_at, ord) JOIN public.jobs jb ON jb.id = x.job_id;
 IF due IS DISTINCT FROM 'SWF-99101,SWP-99104' THEN
  RAISE EXCEPTION 'scoping pipeline contract: the due list with a rollout list: %', due;
 END IF;
 -- with no rollout list, every monitored draft (the rest of the stack's jobs left out of the answer)
 UPDATE public.context_ledger_settings SET job_ids = NULL WHERE id;
 SELECT string_agg(jb.job_number, ',' ORDER BY x.ord) INTO due
 FROM public.context_ledger_due(200) WITH ORDINALITY x(job_id, kind, reason, priority, newest_evidence_at, ord) JOIN public.jobs jb ON jb.id = x.job_id
 WHERE jb.job_number LIKE 'SW_-991%';
 IF due IS DISTINCT FROM 'SWF-99106,SWF-99101,SWP-99104' THEN
  RAISE EXCEPTION 'scoping pipeline contract: the due list with no rollout list: %', due;
 END IF;
 -- a claim of a monitored draft opens a run; one the rule does not monitor answers not_due, naming why
 c := public.context_ledger_claim('9a000000-0000-4000-8000-000000000101', 'backfill', (now() AT TIME ZONE 'Australia/Perth')::date);
 IF c ->> 'outcome' IS DISTINCT FROM 'claimed' OR c ->> 'kind' IS DISTINCT FROM 'backfill'
    OR NOT EXISTS (SELECT 1 FROM public.context_extraction_runs x WHERE x.job_id = '9a000000-0000-4000-8000-000000000101' AND x.phase = 'ledger' AND x.status = 'running') THEN
  RAISE EXCEPTION 'scoping pipeline contract: a monitored draft is claimed: %', c;
 END IF;
 c := public.context_ledger_claim('9a000000-0000-4000-8000-000000000102', 'backfill', (now() AT TIME ZONE 'Australia/Perth')::date);
 IF c ->> 'outcome' IS DISTINCT FROM 'not_due' OR c ->> 'reason' IS DISTINCT FROM 'not_live'
    OR EXISTS (SELECT 1 FROM public.context_extraction_runs x WHERE x.job_id = '9a000000-0000-4000-8000-000000000102' AND x.phase = 'ledger') THEN
  RAISE EXCEPTION 'scoping pipeline contract: a claim of a draft the rule does not monitor answers not_due and opens no run: %', c;
 END IF;
 -- the mode off: nothing is due
 UPDATE public.context_ledger_settings SET mode = 'off' WHERE id;
 IF EXISTS (SELECT 1 FROM public.context_ledger_due(200)) THEN
  RAISE EXCEPTION 'scoping pipeline contract: mode off, the due list must be empty';
 END IF;
END $ledger$;
ROLLBACK;

-- 3. The story (fixed instant Wed 7 Oct 2026 10:00 Perth).
BEGIN;
SET LOCAL session_replication_role = replica;
ALTER TABLE public.business_events ALTER COLUMN context_captured_at SET DEFAULT '2026-07-01 00:00Z',
 ALTER COLUMN recorded_at SET DEFAULT '2026-07-01 00:00Z', ALTER COLUMN occurred_at SET DEFAULT '2026-07-01 00:00Z';
ALTER TABLE public.job_documents ALTER COLUMN created_at SET DEFAULT '2026-07-01 00:00Z';
ALTER TABLE public.job_events ALTER COLUMN created_at SET DEFAULT '2026-07-01 00:00Z';
ALTER TABLE public.jobs ALTER COLUMN created_at SET DEFAULT '2026-07-01 00:00Z', ALTER COLUMN updated_at SET DEFAULT '2026-07-01 00:00Z';
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, client_email, ghl_contact_id, pricing_json, quoted_at, accepted_at,
  created_at, updated_at)
VALUES
 -- a patio lead at quoted, its quote sent 43 days ago and nothing since
 ('9a000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-0000000000aa', 'SWP-99201', 'quoted', 'patio', 'Story One', NULL, 'ct99201', '{}', NULL, NULL, '2026-07-01 02:00Z', '2026-07-01 02:00Z'),
 -- a patio draft, its quote sent 48 days ago and nothing since (its 6 weeks ran out on 1 Oct)
 ('9a000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-0000000000aa', 'SWP-99202', 'draft', 'patio', 'Story Two', NULL, 'ct99202', '{}', NULL, NULL, '2026-07-01 02:00Z', '2026-07-01 02:00Z'),
 -- a fencing draft the customer texted 2 days ago; one with a scope saved 3 days ago; one nothing happened on
 ('9a000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-0000000000aa', 'SWF-99203', 'draft', 'fencing', 'Story Three', NULL, 'ct99203', '{}', NULL, NULL, '2026-09-30 02:00Z', '2026-09-30 02:00Z'),
 ('9a000000-0000-4000-8000-000000000204', '00000000-0000-4000-8000-0000000000aa', 'SWF-99204', 'draft', 'fencing', 'Story Four', NULL, 'ct99204', '{}', NULL, NULL, '2026-09-30 02:00Z', '2026-09-30 02:00Z'),
 ('9a000000-0000-4000-8000-000000000205', '00000000-0000-4000-8000-0000000000aa', 'SWF-99205', 'draft', 'fencing', 'Story Five', NULL, 'ct99205', '{}', NULL, NULL, '2026-07-01 02:00Z', '2026-07-01 02:00Z');
INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at)
VALUES ('9a0e0000-0000-4000-8000-000000000201', '9a000000-0000-4000-8000-000000000201', 'quote', 'Q-99201', 1, '2026-08-25 01:00Z', '2026-08-25 02:00Z'),
       ('9a0e0000-0000-4000-8000-000000000202', '9a000000-0000-4000-8000-000000000202', 'quote', 'Q-99202', 1, '2026-08-20 01:00Z', '2026-08-20 02:00Z');
INSERT INTO public.job_events (id, job_id, event_type, detail_json, created_at)
VALUES ('9a0f0000-0000-4000-8000-000000000204', '9a000000-0000-4000-8000-000000000204', 'scope_saved', '{"source":"tool"}', '2026-10-04 02:00Z');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_confidence, candidate_job_ids)
VALUES ('9a0b0000-0000-4000-8000-000000000203', '9a000000-0000-4000-8000-000000000203', 'client.reply', 'ghl', 'sms', 'inbound', 'ct99203',
        '{"body":"Can you come and measure up?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
        '2026-10-05 02:00Z', '2026-10-05 02:00Z', '2026-10-05 02:00Z', '2026-10-05 02:00Z', 'direct', 1, NULL);
DO $story$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; r record; s jsonb;
BEGIN
 -- a patio lead no longer followed up: R7 and the first line name its 6 weeks
 SELECT * INTO r FROM public.context_job_record_loops(ARRAY['9a000000-0000-4000-8000-000000000201'::uuid], asof) l WHERE l.rule = 'R7_quote_waiting';
 IF r.what IS DISTINCT FROM 'Quote Q-99201 v1 sent Tue 25 Aug 2026 (43 days), not viewed; no answer and no customer message since. '
                            || 'Lead not followed up since Tue 6 Oct 2026: 6 weeks after the last quote or message with no progress'
    OR r.why NOT LIKE '%; the lead is no longer followed up: no acceptance, invoice or bill, booking or later status in the 6 weeks after %' THEN
  RAISE EXCEPTION 'scoping pipeline contract: R7 of a patio lead no longer followed up names its 6 weeks: %', row_to_json(r);
 END IF;
 s := public.context_job_story('9a000000-0000-4000-8000-000000000201', asof);
 IF s->'now'->>'line' IS DISTINCT FROM 'Quoted since Tue 25 Aug. Lead not followed up since Tue 6 Oct: 6 weeks after the last quote or message with no progress.'
    OR s->'now'->>'whose_move' IS DISTINCT FROM 'not_followed_up' OR s->'now'->'monitored' IS DISTINCT FROM 'false'::jsonb
    OR s->'now'->>'not_followed_up_since' IS DISTINCT FROM '2026-10-06' THEN
  RAISE EXCEPTION 'scoping pipeline contract: the first line of a patio lead no longer followed up names its 6 weeks: %', s->'now';
 END IF;
 -- a quiet patio draft with a quote out: R7 as it was (a loop on the customer, no lead words), the
 -- line as it was, never "Lead not followed up"; only now.monitored says the rule does not monitor it
 SELECT * INTO r FROM public.context_job_record_loops(ARRAY['9a000000-0000-4000-8000-000000000202'::uuid], asof) l WHERE l.rule = 'R7_quote_waiting';
 IF r.what IS DISTINCT FROM 'Quote Q-99202 v1 sent Thu 20 Aug 2026 (48 days), not viewed; no answer and no customer message since'
    OR r.shown_as IS DISTINCT FROM 'loop' OR r.owner IS DISTINCT FROM 'customer' OR r.why LIKE '%no longer followed up%' THEN
  RAISE EXCEPTION 'scoping pipeline contract: R7 of a quiet draft carries no lead words: %', row_to_json(r);
 END IF;
 s := public.context_job_story('9a000000-0000-4000-8000-000000000202', asof);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'customer' OR s->'now'->'monitored' IS DISTINCT FROM 'false'::jsonb
    OR s->'now'->'not_followed_up_since' IS DISTINCT FROM 'null'::jsonb OR s->'now'->>'line' LIKE '%Lead not followed up%'
    OR s->'now'->>'phase' IS DISTINCT FROM 'quote'
    OR position('The customer''s move, waiting on the customer: Quote Q-99202 v1 sent Thu 20 Aug 2026 (48 days)' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'scoping pipeline contract: a quiet draft keeps its line, only now.monitored is false: %', s->'now';
 END IF;
 -- an active draft is monitored; a draft's phase is enquiry or scope; one nothing happened on is not
 -- monitored and its line never says "Lead not followed up"
 FOR r IN SELECT x.id, x.mon FROM (VALUES ('9a000000-0000-4000-8000-000000000203'::uuid, true), ('9a000000-0000-4000-8000-000000000204'::uuid, true),
                                         ('9a000000-0000-4000-8000-000000000205'::uuid, false)) x(id, mon) LOOP
  s := public.context_job_story(r.id, asof);
  IF s->'now'->'monitored' IS DISTINCT FROM to_jsonb(r.mon) OR s->'now'->>'phase' NOT IN ('enquiry', 'scope')
     OR s->'now'->>'whose_move' = 'not_followed_up' OR s->'now'->>'line' LIKE '%Lead not followed up%'
     OR s->'now'->'not_followed_up_since' IS DISTINCT FROM 'null'::jsonb THEN
   RAISE EXCEPTION 'scoping pipeline contract: draft % monitored %: %', r.id, r.mon, s->'now';
  END IF;
 END LOOP;
 -- the pure assembler: a draft state is never off; a lead row with no state, as before, is; the
 -- lead words are the job's own weeks
 s := public.context_job_story_assemble('{"id":"x","status":"draft","type":"patio","created_at":"2026-08-01T00:00:00Z"}',
       '{"lead":{"monitored":false,"state":"draft_quiet","cutoff_at":"2026-10-01T02:00:00Z"}}', NULL, NULL, asof, NULL);
 IF s->'now'->'monitored' IS DISTINCT FROM 'false'::jsonb OR s->'now'->>'whose_move' = 'not_followed_up'
    OR s->'now'->'not_followed_up_since' IS DISTINCT FROM 'null'::jsonb OR s->'now'->>'line' LIKE '%Lead not followed up%' THEN
  RAISE EXCEPTION 'scoping pipeline contract: a draft state is never off in the assembler: %', s->'now';
 END IF;
 s := public.context_job_story_assemble('{"id":"x","status":"draft","type":"fencing","created_at":"2026-08-01T00:00:00Z"}',
       '{"lead":{"monitored":false,"state":"draft_no_activity"}}', NULL, NULL, asof, NULL);
 IF s->'now'->'monitored' IS DISTINCT FROM 'false'::jsonb OR s->'now'->>'whose_move' = 'not_followed_up' OR s->'now'->>'line' LIKE '%Lead not followed up%' THEN
  RAISE EXCEPTION 'scoping pipeline contract: an untouched draft is never off in the assembler: %', s->'now';
 END IF;
 s := public.context_job_story_assemble('{"id":"x","status":"quoted","type":"patio","created_at":"2026-08-01T00:00:00Z"}',
       '{"lead":{"monitored":false,"state":"not_followed_up","cutoff_at":"2026-10-06T02:00:00Z"}}', NULL, NULL, asof, NULL);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'not_followed_up' OR s->'now'->'monitored' IS DISTINCT FROM 'false'::jsonb
    OR position('Lead not followed up since Tue 6 Oct: 6 weeks after the last quote or message with no progress' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'scoping pipeline contract: a patio lead not followed up says 6 weeks in the assembler: %', s->'now';
 END IF;
 s := public.context_job_story_assemble('{"id":"x","status":"quoted","type":"fencing","created_at":"2026-08-01T00:00:00Z"}',
       '{"lead":{"monitored":false,"cutoff_at":"2026-10-06T02:00:00Z"}}', NULL, NULL, asof, NULL);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'not_followed_up' OR s->'now'->'monitored' IS DISTINCT FROM 'false'::jsonb
    OR position('Lead not followed up since Tue 6 Oct: 4 weeks after the last quote or message with no progress' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'scoping pipeline contract: a lead row with no state is off as before, in 4 weeks on fencing: %', s->'now';
 END IF;
 s := public.context_job_story_assemble('{"id":"x","status":"draft","type":"patio","created_at":"2026-08-01T00:00:00Z"}', '{}'::jsonb, NULL, NULL, asof, NULL);
 IF s->'now'->'monitored' IS DISTINCT FROM 'true'::jsonb OR s->'now'->>'whose_move' = 'not_followed_up' THEN
  RAISE EXCEPTION 'scoping pipeline contract: with no lead passed in the job is followed up: %', s->'now';
 END IF;
END $story$;
ROLLBACK;

-- 4. The scorecard: every job already in the stack leaves the live list for this transaction, so the
-- scope counts the fixtures only (as of Wed 7 Oct 2026 12:00 Perth).
BEGIN;
SET LOCAL session_replication_role = replica;
UPDATE public.jobs SET status = 'lost' WHERE status::text NOT IN ('cancelled', 'archived', 'complete', 'completed', 'lost');
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, client_email, ghl_contact_id, pricing_json, quoted_at, accepted_at,
  created_at, updated_at)
VALUES ('9a000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-0000000000aa', 'SWF-99301', 'accepted', 'fencing', 'Card One', 'c1@example.test', 'ct99301', '{}', NULL, '2026-09-02 02:00Z', '2026-09-01 02:00Z', '2026-09-01 02:00Z'),
       ('9a000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-0000000000aa', 'SWP-99302', 'draft', 'patio', 'Card Two', 'c2@example.test', 'ct99302', '{}', NULL, NULL, '2026-09-01 02:00Z', '2026-09-01 02:00Z'),
       ('9a000000-0000-4000-8000-000000000303', '00000000-0000-4000-8000-0000000000aa', 'SWF-99303', 'draft', 'fencing', 'Card Three', 'c3@example.test', 'ct99303', '{}', NULL, NULL, '2026-07-01 02:00Z', '2026-07-01 02:00Z'),
       ('9a000000-0000-4000-8000-000000000304', '00000000-0000-4000-8000-0000000000aa', 'SWF-99304', 'draft', 'fencing', 'Card Four', 'c4@example.test', 'ct99304', '{}', NULL, NULL, '2026-10-01 02:00Z', '2026-10-01 02:00Z'),
       ('9a000000-0000-4000-8000-000000000305', '00000000-0000-4000-8000-0000000000aa', 'SWF-99305', 'quoted', 'fencing', 'Card Five', 'c5@example.test', 'ct99305', '{}', '2026-08-01 02:00Z', NULL, '2026-07-01 02:00Z', '2026-07-01 02:00Z');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_confidence, candidate_job_ids)
VALUES ('9a0b0000-0000-4000-8000-000000000302', '9a000000-0000-4000-8000-000000000302', 'client.reply', 'ghl', 'sms', 'inbound', 'ct99302',
        '{"body":"Happy with the design"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
        '2026-10-05 02:00Z', '2026-10-05 02:00Z', '2026-10-05 02:00Z', '2026-10-05 02:00Z', 'direct', 1, NULL),
       ('9a0b0000-0000-4000-8000-000000000303', '9a000000-0000-4000-8000-000000000303', 'client.reply', 'ghl', 'sms', 'inbound', 'ct99303',
        '{"body":"Not this year"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
        '2026-08-01 02:00Z', '2026-08-01 02:00Z', '2026-08-01 02:00Z', '2026-08-01 02:00Z', 'direct', 1, NULL);
DO $card$
DECLARE s jsonb := public.context_scorecard('2026-10-07 04:00Z'); j jsonb := public.context_scorecard_jobs(NULL, 300, '2026-10-07 04:00Z'); got text;
BEGIN
 -- the accepted job and the monitored patio draft are live and monitored; the quoted lead is live and
 -- not followed up; the quiet and the untouched draft are not live at all
 IF (s->>'live_jobs')::integer IS DISTINCT FROM 3 OR (s->>'monitored_jobs')::integer IS DISTINCT FROM 2
    OR (s->>'leads_not_followed_up')::integer IS DISTINCT FROM 1 THEN
  RAISE EXCEPTION 'scoping pipeline contract: scorecard scope: live %, monitored %, not followed up %',
   s->>'live_jobs', s->>'monitored_jobs', s->>'leads_not_followed_up';
 END IF;
 SELECT string_agg(x->>'job_number', ',' ORDER BY x->>'job_number' COLLATE "C") INTO got FROM jsonb_array_elements(j->'jobs') x;
 IF got IS DISTINCT FROM 'SWF-99301,SWP-99302' THEN
  RAISE EXCEPTION 'scoping pipeline contract: the scorecard''s job page lists the monitored jobs, the monitored draft among them: %', got;
 END IF;
END $card$;
ROLLBACK;

-- 5. The window function: 6 weeks on a patio job, 4 on fencing and every other type.
DO $window$
DECLARE p record;
BEGIN
 IF public.context_lead_window_hours('patio') IS DISTINCT FROM 1008 OR public.context_lead_window_hours(' Patio ') IS DISTINCT FROM 1008
    OR public.context_lead_window_hours('fencing') IS DISTINCT FROM 672 OR public.context_lead_window_hours('decking') IS DISTINCT FROM 672
    OR public.context_lead_window_hours('makesafe') IS DISTINCT FROM 672 OR public.context_lead_window_hours('') IS DISTINCT FROM 672
    OR public.context_lead_window_hours(NULL) IS DISTINCT FROM 672 THEN
  RAISE EXCEPTION 'scoping pipeline contract: the window is 1008 hours on a patio job and 672 on every other';
 END IF;
 SELECT pr.prosecdef, pr.provolatile, pr.proconfig, pr.prolang INTO p FROM pg_proc pr WHERE pr.oid = 'public.context_lead_window_hours(text)'::regprocedure;
 IF p.prosecdef OR p.provolatile <> 'i' OR p.proconfig IS NOT NULL OR p.prolang <> (SELECT l.oid FROM pg_language l WHERE l.lanname = 'sql') THEN
  RAISE EXCEPTION 'scoping pipeline contract: the window function is plain inlinable SQL (definer %, volatility %, config %)', p.prosecdef, p.provolatile, p.proconfig;
 END IF;
 IF has_function_privilege('anon', 'public.context_lead_window_hours(text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.context_lead_window_hours(text)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.context_lead_window_hours(text)', 'EXECUTE')
    OR coalesce(obj_description('public.context_lead_window_hours(text)'::regprocedure, 'pg_proc'), '') NOT LIKE 'Scoping pipeline (20261009130000): %' THEN
  RAISE EXCEPTION 'scoping pipeline contract: the window function''s access or comment';
 END IF;
END $window$;

-- 6. Shape and access of the replaced bodies.
DO $shape$
DECLARE x record; p record; rule_shape constant text :=
 'TABLE(job_id uuid, job_number text, monitored boolean, state text, quote_sent_at timestamp with time zone, customer_at timestamp with time zone, cutoff_at timestamp with time zone)';
BEGIN
 FOR x IN SELECT * FROM (VALUES
   ('public.context_lead_monitored_jobs(uuid[],timestamptz)', true, 'Lead cutoff (20261007010000): (scoping pipeline, 20261009130000) %'),
   ('public.context_ledger_judge(uuid[])', true,
    'Context ledger store (20261006013000), story safety (20261006040000): (lead cutoff, 20261007010000) (scoping pipeline, 20261009130000) %'),
   ('public.context_ledger_due(integer)', true, 'Context ledger store (20261006013000): (scoping pipeline, 20261009130000) %'),
   ('public.context_job_record_loops(uuid[],timestamptz)', true,
    'Job record (20261006011000), story fixes (20261006033000), story safety (20261006040000): (lead cutoff, 20261007010000) (scoping pipeline, 20261009130000) %'),
   ('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)', false,
    'Job story (20261006014000), story fixes (20261006033000), story safety (20261006040000): (lead cutoff, 20261007010000) (scoping pipeline, 20261009130000) %')
 ) v(sig, definer, cmt) LOOP
  SELECT pr.prosecdef, pr.provolatile, pr.proconfig, pr.prolang INTO p FROM pg_proc pr WHERE pr.oid = to_regprocedure(x.sig);
  IF p IS NULL THEN RAISE EXCEPTION 'scoping pipeline contract: % missing', x.sig; END IF;
  IF p.prosecdef IS DISTINCT FROM x.definer OR p.provolatile <> 's' OR p.prolang <> (SELECT l.oid FROM pg_language l WHERE l.lanname = 'sql')
     OR (x.definer AND p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']) OR (NOT x.definer AND p.proconfig IS NOT NULL) THEN
   RAISE EXCEPTION 'scoping pipeline contract: % flags (definer %, volatility %, config %)', x.sig, p.prosecdef, p.provolatile, p.proconfig;
  END IF;
  IF has_function_privilege('anon', x.sig, 'EXECUTE') OR has_function_privilege('authenticated', x.sig, 'EXECUTE')
     OR NOT has_function_privilege('service_role', x.sig, 'EXECUTE') THEN
   RAISE EXCEPTION 'scoping pipeline contract: % access wrong', x.sig;
  END IF;
  IF coalesce(obj_description(to_regprocedure(x.sig), 'pg_proc'), '') NOT LIKE x.cmt THEN
   RAISE EXCEPTION 'scoping pipeline contract: % comment must keep its slice names first and name the scoping pipeline', x.sig;
  END IF;
 END LOOP;
 IF pg_get_function_result('public.context_lead_monitored_jobs(uuid[],timestamptz)'::regprocedure) IS DISTINCT FROM rule_shape
    OR pg_get_function_result('public.context_lead_monitored(uuid,timestamptz)'::regprocedure) IS DISTINCT FROM rule_shape THEN
  RAISE EXCEPTION 'scoping pipeline contract: the rule''s columns changed';
 END IF;
END $shape$;

-- 7. Re-applying the migration changes nothing (its guard accepts its own bodies).
BEGIN;
CREATE TEMP TABLE scoping_pipeline_md5 AS
 SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS m, obj_description(p.oid, 'pg_proc') AS c FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('context_lead_window_hours', 'context_lead_monitored_jobs', 'context_ledger_judge',
  'context_ledger_due', 'context_job_record_loops', 'context_job_story_assemble');
\ir ../../../migrations/20261009130000_context_scoping_pipeline.sql
DO $again$
BEGIN
 IF (SELECT count(*) FROM scoping_pipeline_md5) <> 6 OR EXISTS (SELECT 1 FROM scoping_pipeline_md5 x JOIN pg_proc p ON p.oid = x.sig::regprocedure
       WHERE md5(p.prosrc) IS DISTINCT FROM x.m OR obj_description(p.oid, 'pg_proc') IS DISTINCT FROM x.c) THEN
  RAISE EXCEPTION 'scoping pipeline contract: a re-apply must change nothing';
 END IF;
END $again$;
ROLLBACK;

-- 8. The service role reads the rule directly with drafts in the set: a fresh session, so no plan
-- cached earlier hides a missing grant, and the table grants production gives the service role. The
-- draft's activity reads our crew and staff template helper (context_internal_text_role, which
-- 20261005090000 revoked from the service role), so a rule that ran as its caller would be refused.
\c
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, ghl_contact_id, pricing_json, created_at, updated_at)
VALUES ('9a000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-0000000000aa', 'SWF-99401', 'draft', 'fencing', 'Draft SR', 'ct99401', '{}', '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
       ('9a000000-0000-4000-8000-000000000402', '00000000-0000-4000-8000-0000000000aa', 'SWP-99402', 'draft', 'patio', 'Draft SR Two', 'ct99402', '{}', '2026-07-01 00:00Z', '2026-07-01 00:00Z');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_confidence)
VALUES ('9a0b0000-0000-4000-8000-000000000401', '9a000000-0000-4000-8000-000000000401', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct99401',
        '{"body":"Hi, checking a time to measure up"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff","audience":"customer"}}',
        '2026-10-05 02:00Z', '2026-10-05 02:00Z', '2026-10-05 02:00Z', '2026-10-05 02:00Z', 'direct', 1);
GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role;
SET LOCAL ROLE service_role;
DO $service$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; got text;
BEGIN
 IF has_function_privilege('service_role', 'public.context_internal_text_role(public.business_events)', 'EXECUTE') THEN
  RAISE EXCEPTION 'scoping pipeline contract: the ladder helper is meant to stay revoked from the service role here';
 END IF;
 BEGIN
  SELECT string_agg(concat_ws(' ', m.job_number, m.monitored::text, m.state), ', ' ORDER BY m.job_number COLLATE "C") INTO got
  FROM public.context_lead_monitored_jobs(ARRAY['9a000000-0000-4000-8000-000000000401', '9a000000-0000-4000-8000-000000000402']::uuid[], asof) m;
  IF got IS DISTINCT FROM 'SWF-99401 true draft_active, SWP-99402 false draft_no_activity' THEN
   RAISE EXCEPTION 'scoping pipeline contract: the service role read the set form wrong: %', got;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.context_lead_monitored_jobs(NULL, asof) m WHERE m.job_number = 'SWF-99401' AND m.monitored)
     OR EXISTS (SELECT 1 FROM public.context_lead_monitored_jobs(NULL, asof) m WHERE m.job_number = 'SWP-99402') THEN
   RAISE EXCEPTION 'scoping pipeline contract: the service role read the live set wrong';
  END IF;
 EXCEPTION WHEN insufficient_privilege THEN
  RAISE EXCEPTION 'scoping pipeline contract: the service role must read the rule with drafts in the set: % (%)', SQLERRM, SQLSTATE;
 END;
END $service$;
RESET ROLE;
ROLLBACK;

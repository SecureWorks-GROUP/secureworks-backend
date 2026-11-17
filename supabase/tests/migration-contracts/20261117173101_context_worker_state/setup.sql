-- Earlier registered fixtures supply the organisation, jobs, context settings,
-- cadence, pass days, story requests, attempts and changed-job marks.
-- The contract includes this file again inside its rolled-back transaction.
-- No stand-ins replace production functions. No fixture survives the contract.
\if :{?worker_state_seed}
SET LOCAL session_replication_role = replica;
INSERT INTO public.jobs (id, org_id, type, status, job_number)
VALUES ('00000000-0000-4000-8000-000000000401', '00000000-0000-0000-0000-000000000001',
  'fencing', 'accepted', 'ZZTEST-401');
INSERT INTO public.business_events (id, occurred_at, attribution_status, metadata)
VALUES
 ('00000000-0000-4000-8000-000000000401', '2000-01-01T00:00:00Z', 'pending_luna', '{}'),
 ('00000000-0000-4000-8000-000000000402', '2000-01-02T00:00:00Z', 'pending_luna', '{"capture_mode":"backfill"}'),
 ('00000000-0000-4000-8000-000000000403', '2000-01-02T00:00:00Z', 'pending_luna', '{"capture_mode":"relink","capture_mode_before":"backfill"}'),
 ('00000000-0000-4000-8000-000000000404', '2000-01-03T00:00:00Z', 'pending_luna', '{"capture_mode":"backfill","history_tier":"deep"}'),
 ('00000000-0000-4000-8000-000000000405', '2000-01-04T00:00:00Z', 'pending_luna', '{"capture_mode":"relink","capture_mode_before":"live"}'),
 ('00000000-0000-4000-8000-000000000406', '2000-01-05T00:00:00Z', 'pending_luna', '{"capture_mode":"live","capture_mode_before":"backfill"}'),
 ('00000000-0000-4000-8000-000000000407', '2000-01-06T00:00:00Z', 'pending_luna', '{"history_tier":"deep"}'),
 ('00000000-0000-4000-8000-000000000408', '2000-01-07T00:00:00Z', 'pending_luna', '{}'),
 ('00000000-0000-4000-8000-000000000409', '2000-01-08T00:00:00Z', 'unplaced', '{}');
INSERT INTO public.context_attribution_attempts (event_id, next_at)
VALUES ('00000000-0000-4000-8000-000000000401', now() + interval '1 hour');
SET LOCAL session_replication_role = origin;
\endif

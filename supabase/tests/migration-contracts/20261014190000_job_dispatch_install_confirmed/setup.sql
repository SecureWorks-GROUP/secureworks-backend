-- Prerequisites for 20261014190000_job_dispatch_install_confirmed. The registered
-- 20261014113000_job_dispatch_state case creates job_dispatch_state; its old rows are seeded here,
-- before the migration, so the contract can prove they come through unchanged.
DO $$
BEGIN
 IF to_regclass('public.job_dispatch_state') IS NULL THEN
  RAISE EXCEPTION 'install confirmed setup: job_dispatch_state missing from the registered stack';
 END IF;
END $$;

INSERT INTO public.jobs (id, org_id, status, type)
VALUES ('9d700000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing'),
       ('9d700000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'accepted', 'patio')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.job_dispatch_state (job_id, org_id, stage, stage_set_at, next_step, next_step_set_at, created_at, updated_at)
VALUES ('9d700000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'trade_scheduled',
        '2026-10-01 01:00:00+00', 'Ring the crew', '2026-10-01 01:00:00+00', '2026-10-01 01:00:00+00', '2026-10-01 01:00:00+00'),
       ('9d700000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', NULL,
        NULL, 'Waiting on deposit', '2026-10-02 01:00:00+00', '2026-10-02 01:00:00+00', '2026-10-02 01:00:00+00')
ON CONFLICT (job_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.ds7_old_rows AS
SELECT job_id, md5(row(job_id, org_id, stage, stage_set_at, stage_set_by, stage_set_by_email, next_step,
                       next_step_set_at, next_step_set_by, next_step_set_by_email, created_at, updated_at)::text) AS digest
FROM public.job_dispatch_state
WHERE job_id IN ('9d700000-0000-4000-8000-000000000001', '9d700000-0000-4000-8000-000000000002');

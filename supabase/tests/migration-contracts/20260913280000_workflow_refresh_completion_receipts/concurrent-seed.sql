BEGIN;
INSERT INTO public.jobs(id,org_id,status,type,job_number)
VALUES ('28000000-0000-4000-8000-000000000010',
        '00000000-0000-0000-0000-000000000001','new','patio','REFRESH-CONCURRENT');
INSERT INTO public.dispatch_refresh_test_sources(org_id,job_id,revision)
VALUES ('00000000-0000-0000-0000-000000000001',
        '28000000-0000-4000-8000-000000000010','concurrent-source');
SET LOCAL ROLE service_role;
SELECT public.register_workflow_refresh_driver(
  'dispatch','operations','dispatch_refresh/v1','concurrent-seed','registered'
);
COMMIT;

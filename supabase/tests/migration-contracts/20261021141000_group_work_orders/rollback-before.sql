-- Proof copy only. share_link and revoked rows exist when the down
-- migration runs. The down leaves those rows, leaves the widened method
-- check, and does not disable the append-only trigger.
INSERT INTO public.jobs (id, org_id, type, status, job_number)
VALUES (
  'd2140000-0000-4000-8000-0000000000e1',
  '00000000-0000-0000-0000-000000000001',
  'fencing',
  'scheduled',
  'SWF-ROLLBACK-SIGN'
);

INSERT INTO public.job_media (id, job_id, phase, type, storage_url)
VALUES (
  'd2140000-0000-4000-8000-0000000000e2',
  'd2140000-0000-4000-8000-0000000000e1',
  'signature',
  'photo',
  'https://example.invalid/signature.png'
);

INSERT INTO public.job_client_signoffs (
  id, org_id, job_id, method, signed_name, signature_media_id, captured_by_actor
) VALUES (
  'd2140000-0000-4000-8000-0000000000e3',
  '00000000-0000-0000-0000-000000000001',
  'd2140000-0000-4000-8000-0000000000e1',
  'share_link',
  'Alex Client',
  'd2140000-0000-4000-8000-0000000000e2',
  'client link'
);

INSERT INTO public.job_client_signoffs (
  id, org_id, job_id, method, captured_by_actor
) VALUES (
  'd2140000-0000-4000-8000-0000000000e4',
  '00000000-0000-0000-0000-000000000001',
  'd2140000-0000-4000-8000-0000000000e1',
  'revoked',
  'user:d2140000-0000-4000-8000-0000000000e1'
);

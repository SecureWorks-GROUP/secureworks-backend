-- The migration must fail closed instead of accepting an environment that
-- already has two active documents for the guarded key.

INSERT INTO public.jobs (id, org_id, status, type, job_number)
VALUES (
  '6509c9b3-753e-45ae-8e91-a56869bad226',
  '00000000-0000-0000-0000-000000000001',
  'draft',
  'fencing',
  'TEST-ATTACH-PREEXISTING-DUPLICATE'
);

INSERT INTO public.job_documents (
  job_id,
  type,
  file_name,
  storage_url,
  version
)
VALUES
  (
    '6509c9b3-753e-45ae-8e91-a56869bad226',
    'work_order',
    'duplicate.pdf',
    'https://example.invalid/first.pdf',
    1
  ),
  (
    '6509c9b3-753e-45ae-8e91-a56869bad226',
    'work_order',
    'duplicate.pdf',
    'https://example.invalid/second.pdf',
    2
  );

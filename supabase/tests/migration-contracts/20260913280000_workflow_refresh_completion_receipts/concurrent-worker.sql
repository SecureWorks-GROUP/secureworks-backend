SET ROLE service_role;
SELECT CASE
  WHEN (public.start_workflow_refresh(
    'dispatch',
    '{"job_id":"28000000-0000-4000-8000-000000000010"}'::jsonb,
    :'actor',
    '00000000-0000-0000-0000-000000000001'
  )->>'outcome') IN ('started','joined') THEN 'START_OK'
  ELSE 'START_BAD'
END;

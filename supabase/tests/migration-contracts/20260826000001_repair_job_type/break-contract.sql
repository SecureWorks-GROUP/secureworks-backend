-- Meta-test: deliberately remove the promise this migration makes, so ../run.sh
-- can prove contract.sql actually detects a migration that forgot to widen the
-- job type vocabulary.
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_type_check;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_type_check
  CHECK (type IN (
    'fencing',
    'patio',
    'combo',
    'decking',
    'renovation',
    'insurance',
    'roofing',
    'miscellaneous',
    'general',
    'makesafe'
  ));

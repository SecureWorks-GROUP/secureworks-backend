-- Root's read-only live check found this exact five-value constraint while
-- existing SMS handlers attempted to persist 'sent'. Preserve every old value.
-- Deploy before the checked receipt handler; do not repair historical rows.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $migration$
DECLARE
  current_definition text;
  constraint_validated boolean;
  expected_legacy constant text := $definition$CHECK ((status = ANY (ARRAY['pending'::text, 'auto_approved'::text, 'approved'::text, 'rejected'::text, 'expired'::text])))$definition$;
  expected_target constant text := $definition$CHECK ((status = ANY (ARRAY['pending'::text, 'auto_approved'::text, 'approved'::text, 'rejected'::text, 'expired'::text, 'sent'::text])))$definition$;
BEGIN
  LOCK TABLE public.ai_proposed_actions IN ACCESS EXCLUSIVE MODE;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.ai_proposed_actions'::regclass
      AND attname = 'status' AND NOT attisdropped
      AND atttypid = 'text'::regtype AND attnotnull
  ) THEN
    RAISE EXCEPTION 'proposed_sms_status_schema_unexpected';
  END IF;

  SELECT pg_get_constraintdef(oid), convalidated
    INTO current_definition, constraint_validated
  FROM pg_constraint
  WHERE conrelid = 'public.ai_proposed_actions'::regclass
    AND conname = 'ai_proposed_actions_status_check' AND contype = 'c';

  IF current_definition IS NULL OR NOT constraint_validated
     OR current_definition NOT IN (expected_legacy, expected_target) THEN
    RAISE EXCEPTION 'proposed_sms_status_constraint_unexpected';
  END IF;
  IF current_definition = expected_target THEN RETURN; END IF;

  ALTER TABLE public.ai_proposed_actions
    DROP CONSTRAINT ai_proposed_actions_status_check;
  ALTER TABLE public.ai_proposed_actions
    ADD CONSTRAINT ai_proposed_actions_status_check
    CHECK (status IN ('pending', 'auto_approved', 'approved', 'rejected', 'expired', 'sent'));
END;
$migration$;
COMMIT;

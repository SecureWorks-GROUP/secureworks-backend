BEGIN;

INSERT INTO public.ses_external_effects (
  id,
  operation_key,
  org_id,
  effect_kind,
  invoice_obligation_revision_id,
  payload_hash,
  external_token,
  state,
  failure
) VALUES
  (
    '61000000-0000-4000-8000-000000000001',
    'ses:invoice_create:proof-valid',
    '00000000-0000-4000-8000-000000000001',
    'invoice_create',
    '62000000-0000-4000-8000-000000000001',
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'SES-proof-valid',
    'failed',
    '{"disposition":"definite_no_dispatch","proof":"provider_called_false","provider_called":false,"provider_call_made":false}'::jsonb
  ),
  (
    '61000000-0000-4000-8000-000000000002',
    'ses:invoice_create:proof-null',
    '00000000-0000-4000-8000-000000000001',
    'invoice_create',
    '62000000-0000-4000-8000-000000000002',
    'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'SES-proof-null',
    'failed',
    'null'::jsonb
  ),
  (
    '61000000-0000-4000-8000-000000000003',
    'ses:invoice_create:proof-empty',
    '00000000-0000-4000-8000-000000000001',
    'invoice_create',
    '62000000-0000-4000-8000-000000000003',
    'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    'SES-proof-empty',
    'failed',
    '{}'::jsonb
  ),
  (
    '61000000-0000-4000-8000-000000000004',
    'ses:invoice_create:proof-missing-disposition',
    '00000000-0000-4000-8000-000000000001',
    'invoice_create',
    '62000000-0000-4000-8000-000000000004',
    'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    'SES-proof-missing-disposition',
    'failed',
    '{"proof":"provider_called_false","provider_called":false,"provider_call_made":false}'::jsonb
  ),
  (
    '61000000-0000-4000-8000-000000000005',
    'ses:invoice_create:proof-missing-proof',
    '00000000-0000-4000-8000-000000000001',
    'invoice_create',
    '62000000-0000-4000-8000-000000000005',
    'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    'SES-proof-missing-proof',
    'failed',
    '{"disposition":"definite_no_dispatch","provider_called":false,"provider_call_made":false}'::jsonb
  ),
  (
    '61000000-0000-4000-8000-000000000006',
    'ses:invoice_create:proof-missing-called',
    '00000000-0000-4000-8000-000000000001',
    'invoice_create',
    '62000000-0000-4000-8000-000000000006',
    'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    'SES-proof-missing-called',
    'failed',
    '{"disposition":"definite_no_dispatch","proof":"provider_called_false","provider_call_made":false}'::jsonb
  ),
  (
    '61000000-0000-4000-8000-000000000007',
    'ses:invoice_create:proof-missing-made',
    '00000000-0000-4000-8000-000000000001',
    'invoice_create',
    '62000000-0000-4000-8000-000000000007',
    'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    'SES-proof-missing-made',
    'failed',
    '{"disposition":"definite_no_dispatch","proof":"provider_called_false","provider_called":false}'::jsonb
  ),
  (
    '61000000-0000-4000-8000-000000000008',
    'ses:invoice_create:proof-string',
    '00000000-0000-4000-8000-000000000001',
    'invoice_create',
    '62000000-0000-4000-8000-000000000008',
    'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    'SES-proof-string',
    'failed',
    '{"disposition":"definite_no_dispatch","proof":"provider_called_false","provider_called":"false","provider_call_made":false}'::jsonb
  ),
  (
    '61000000-0000-4000-8000-000000000009',
    'ses:invoice_create:proof-contradiction',
    '00000000-0000-4000-8000-000000000001',
    'invoice_create',
    '62000000-0000-4000-8000-000000000009',
    'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    'SES-proof-contradiction',
    'failed',
    '{"disposition":"definite_no_dispatch","proof":"provider_called_false","provider_called":false,"provider_call_made":true}'::jsonb
  ),
  (
    '61000000-0000-4000-8000-000000000010',
    'ses:invoice_create:proof-checkpoint',
    '00000000-0000-4000-8000-000000000001',
    'invoice_create',
    '62000000-0000-4000-8000-000000000010',
    'sha256:4444444444444444444444444444444444444444444444444444444444444444',
    'SES-proof-checkpoint',
    'failed',
    '{"disposition":"definite_no_dispatch","proof":"provider_called_false","provider_called":false,"provider_call_made":false}'::jsonb
  ),
  (
    '61000000-0000-4000-8000-000000000011',
    'ses:invoice_authorise:proof-valid-but-ineligible',
    '00000000-0000-4000-8000-000000000001',
    'invoice_authorise',
    '62000000-0000-4000-8000-000000000011',
    'sha256:5555555555555555555555555555555555555555555555555555555555555555',
    'SES-authorise-proof-valid',
    'failed',
    '{"disposition":"definite_no_dispatch","proof":"provider_called_false","provider_called":false,"provider_call_made":false}'::jsonb
  ),
  (
    '61000000-0000-4000-8000-000000000012',
    'ses:invoice_create:proof-no-event',
    '00000000-0000-4000-8000-000000000001',
    'invoice_create',
    '62000000-0000-4000-8000-000000000012',
    'sha256:6666666666666666666666666666666666666666666666666666666666666666',
    'SES-proof-no-event',
    'failed',
    '{"disposition":"definite_no_dispatch","proof":"provider_called_false","provider_called":false,"provider_call_made":false}'::jsonb
  ),
  (
    '61000000-0000-4000-8000-000000000013',
    'ses:invoice_create:proof-unknown-state',
    '00000000-0000-4000-8000-000000000001',
    'invoice_create',
    '62000000-0000-4000-8000-000000000013',
    'sha256:7777777777777777777777777777777777777777777777777777777777777777',
    'SES-proof-unknown-state',
    'unknown',
    '{"disposition":"definite_no_dispatch","proof":"provider_called_false","provider_called":false,"provider_call_made":false}'::jsonb
  ),
  (
    '61000000-0000-4000-8000-000000000014',
    'ses:invoice_create:proof-dispatching-state',
    '00000000-0000-4000-8000-000000000001',
    'invoice_create',
    '62000000-0000-4000-8000-000000000014',
    'sha256:8888888888888888888888888888888888888888888888888888888888888888',
    'SES-proof-dispatching-state',
    'dispatching',
    '{"disposition":"definite_no_dispatch","proof":"provider_called_false","provider_called":false,"provider_call_made":false}'::jsonb
  );

UPDATE public.ses_external_effects
SET external_id = 'xero-checkpoint-1'
WHERE id = '61000000-0000-4000-8000-000000000010';

-- The application can create retryable proof only through the two narrow
-- failed-state transitions. The RPC requires one of these append-only events
-- in addition to the normalized failure JSON.
INSERT INTO public.ses_external_effect_events (
  effect_id, from_state, to_state, event_kind, detail, actor
)
SELECT
  id,
  'reserved',
  'failed',
  'dispatch_refused_before_provider',
  jsonb_build_object('failure', failure),
  'contract-proof'
FROM public.ses_external_effects
WHERE id = '61000000-0000-4000-8000-000000000001';

CREATE OR REPLACE FUNCTION pg_temp.assert_invoice_retry_null(p_effect_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  expectation jsonb;
  candidate public.ses_external_effects%ROWTYPE;
  invalid_input_rejected boolean := false;
BEGIN
  SELECT jsonb_build_object(
    'effect_id', id,
    'invoice_obligation_revision_id', invoice_obligation_revision_id,
    'operation_key', operation_key,
    'effect_kind', effect_kind,
    'external_token', external_token,
    'payload_hash', payload_hash,
    'state', state
  ) INTO expectation
  FROM public.ses_external_effects
  WHERE id = p_effect_id;

  BEGIN
    SELECT * INTO candidate
    FROM public.claim_ses_invoice_no_dispatch_retry_v1(
      expectation,
      'worker-invalid',
      'contract-invalid'
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    -- Wrong effect kinds and non-failed expectations are rejected at the
    -- public input boundary, before the stored-proof lookup can return null.
    IF expectation->>'effect_kind' = 'invoice_create'
       AND expectation->>'state' = 'failed' THEN
      RAISE;
    END IF;
    invalid_input_rejected := true;
  END;
  IF (expectation->>'effect_kind' <> 'invoice_create'
      OR expectation->>'state' <> 'failed')
     AND NOT invalid_input_rejected THEN
    RAISE EXCEPTION 'invalid expectation was not rejected for effect %', p_effect_id;
  END IF;
  IF candidate.id IS NOT NULL THEN
    RAISE EXCEPTION 'ineligible effect % acquired an invoice retry lease',
      p_effect_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.ses_external_effect_events
    WHERE effect_id = p_effect_id
      AND event_kind = 'definite_no_dispatch_redispatch_claimed'
  ) THEN
    RAISE EXCEPTION 'ineligible effect % retained a retry claim event', p_effect_id;
  END IF;
END;
$$;

DO $$
DECLARE
  valid_expectation jsonb;
  valid public.ses_external_effects%ROWTYPE;
  loser public.ses_external_effects%ROWTYPE;
  invalid_effect_id uuid;
BEGIN
  SELECT jsonb_build_object(
    'effect_id', id,
    'invoice_obligation_revision_id', invoice_obligation_revision_id,
    'operation_key', operation_key,
    'effect_kind', effect_kind,
    'external_token', external_token,
    'payload_hash', payload_hash,
    'state', state
  ) INTO valid_expectation
  FROM public.ses_external_effects
  WHERE id = '61000000-0000-4000-8000-000000000001';

  SELECT * INTO valid
  FROM public.claim_ses_invoice_no_dispatch_retry_v1(
    valid_expectation,
    'worker-valid',
    'contract-valid'
  );
  IF valid.id IS DISTINCT FROM '61000000-0000-4000-8000-000000000001'::uuid
     OR valid.state IS DISTINCT FROM 'dispatching'
     OR valid.lease_owner IS DISTINCT FROM 'worker-valid' THEN
    RAISE EXCEPTION 'valid proof did not acquire the invoice retry lease';
  END IF;

  SELECT * INTO loser
  FROM public.claim_ses_invoice_no_dispatch_retry_v1(
    valid_expectation,
    'worker-loser',
    'contract-loser'
  );
  IF loser.id IS NOT NULL THEN
    RAISE EXCEPTION 'concurrent retry loser acquired a second invoice lease';
  END IF;

  FOREACH invalid_effect_id IN ARRAY ARRAY[
    '61000000-0000-4000-8000-000000000002'::uuid,
    '61000000-0000-4000-8000-000000000003'::uuid,
    '61000000-0000-4000-8000-000000000004'::uuid,
    '61000000-0000-4000-8000-000000000005'::uuid,
    '61000000-0000-4000-8000-000000000006'::uuid,
    '61000000-0000-4000-8000-000000000007'::uuid,
    '61000000-0000-4000-8000-000000000008'::uuid,
    '61000000-0000-4000-8000-000000000009'::uuid,
    '61000000-0000-4000-8000-000000000010'::uuid,
    '61000000-0000-4000-8000-000000000011'::uuid,
    '61000000-0000-4000-8000-000000000012'::uuid,
    '61000000-0000-4000-8000-000000000013'::uuid,
    '61000000-0000-4000-8000-000000000014'::uuid
  ] LOOP
    PERFORM pg_temp.assert_invoice_retry_null(invalid_effect_id);
  END LOOP;
END;
$$;

ROLLBACK;

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
) VALUES (
  '61000000-0000-4000-8000-000000000021',
  'ses:invoice_create:concurrent-proof',
  '00000000-0000-4000-8000-000000000001',
  'invoice_create',
  '62000000-0000-4000-8000-000000000021',
  'sha256:2121212121212121212121212121212121212121212121212121212121212121',
  'SES-concurrent-proof',
  'failed',
  '{"disposition":"definite_no_dispatch","proof":"provider_called_false","provider_called":false,"provider_call_made":false}'::jsonb
);

INSERT INTO public.ses_external_effect_events (
  effect_id, from_state, to_state, event_kind, detail, actor
) VALUES (
  '61000000-0000-4000-8000-000000000021',
  'reserved',
  'failed',
  'dispatch_refused_before_provider',
  '{"failure":{"disposition":"definite_no_dispatch","proof":"provider_called_false","provider_called":false,"provider_call_made":false}}'::jsonb,
  'contract-concurrent-proof'
);

COMMIT;

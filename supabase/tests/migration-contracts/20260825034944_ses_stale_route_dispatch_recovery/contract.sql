-- Executed by ../run.sh against disposable PostgreSQL after the migration.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.idx_ses_route_dispatching_lease') IS NULL THEN
    RAISE EXCEPTION 'stale route dispatch scan index is missing';
  END IF;
END;
$$;

INSERT INTO public.makesafe_release_revision_members (
  release_revision_id, job_id
) VALUES
  (
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001'
  ),
  (
    '40000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002'
  ),
  (
    '40000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000003'
  ),
  (
    '40000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000004'
  );

INSERT INTO public.ses_external_effects (
  id, operation_key, org_id, effect_kind, release_revision_id, route_kind,
  payload_hash, external_token, state, lease_owner, lease_expires_at,
  created_at, updated_at
) VALUES
  (
    '50000000-0000-4000-8000-000000000001',
    'ses:route_send:expired-no-send',
    '00000000-0000-4000-8000-000000000001',
    'route_send',
    '40000000-0000-4000-8000-000000000001',
    'invoice',
    'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    'SES-expired-no-send',
    'dispatching',
    'worker-expired',
    statement_timestamp() - interval '5 minutes',
    statement_timestamp() - interval '7 minutes',
    statement_timestamp() - interval '7 minutes'
  ),
  (
    '50000000-0000-4000-8000-000000000002',
    'ses:route_send:expired-sent',
    '00000000-0000-4000-8000-000000000001',
    'route_send',
    '40000000-0000-4000-8000-000000000002',
    'report',
    'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    'SES-expired-sent',
    'dispatching',
    'worker-sent',
    statement_timestamp() - interval '4 minutes',
    statement_timestamp() - interval '6 minutes',
    statement_timestamp() - interval '6 minutes'
  ),
  (
    '50000000-0000-4000-8000-000000000003',
    'ses:route_send:fresh',
    '00000000-0000-4000-8000-000000000001',
    'route_send',
    '40000000-0000-4000-8000-000000000003',
    'photo',
    'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    'SES-fresh',
    'dispatching',
    'worker-fresh',
    statement_timestamp() + interval '2 minutes',
    statement_timestamp() - interval '1 minute',
    statement_timestamp() - interval '1 minute'
  ),
  (
    '50000000-0000-4000-8000-000000000004',
    'ses:route_send:expired-inconclusive',
    '00000000-0000-4000-8000-000000000001',
    'route_send',
    '40000000-0000-4000-8000-000000000004',
    'invoice',
    'sha256:4444444444444444444444444444444444444444444444444444444444444444',
    'SES-expired-inconclusive',
    'dispatching',
    'worker-inconclusive',
    statement_timestamp() - interval '8 minutes',
    statement_timestamp() - interval '10 minutes',
    statement_timestamp() - interval '10 minutes'
  );

INSERT INTO public.ses_external_effect_events (
  effect_id, from_state, to_state, event_kind, detail, actor, created_at
) VALUES
  (
    '50000000-0000-4000-8000-000000000001',
    'reserved', 'dispatching', 'dispatch_started', '{}'::jsonb,
    'worker-expired', statement_timestamp() - interval '7 minutes'
  ),
  (
    '50000000-0000-4000-8000-000000000002',
    'reserved', 'dispatching', 'dispatch_started', '{}'::jsonb,
    'worker-sent', statement_timestamp() - interval '6 minutes'
  ),
  (
    '50000000-0000-4000-8000-000000000003',
    'reserved', 'dispatching', 'dispatch_started', '{}'::jsonb,
    'worker-fresh', statement_timestamp() - interval '1 minute'
  ),
  (
    '50000000-0000-4000-8000-000000000004',
    'reserved', 'dispatching', 'dispatch_started', '{}'::jsonb,
    'worker-inconclusive', statement_timestamp() - interval '10 minutes'
  );

DO $$
DECLARE
  expired public.ses_external_effects%ROWTYPE;
  fresh public.ses_external_effects%ROWTYPE;
  settled public.ses_external_effects%ROWTYPE;
  retried public.ses_external_effects%ROWTYPE;
  renewed public.ses_external_effects%ROWTYPE;
  confirmed_after_retry public.ses_external_effects%ROWTYPE;
  expired_expectation jsonb;
  sent_expectation jsonb;
  fresh_expectation jsonb;
BEGIN
  SELECT jsonb_build_object(
    'effect_id', id,
    'release_revision_id', release_revision_id,
    'operation_key', operation_key,
    'route_kind', route_kind,
    'external_token', external_token,
    'payload_hash', payload_hash,
    'state', state,
    'lease_owner', lease_owner,
    'lease_expires_at', lease_expires_at
  ) INTO expired_expectation
  FROM public.ses_external_effects
  WHERE id = '50000000-0000-4000-8000-000000000001';

  SELECT * INTO expired
  FROM public.inspect_stale_ses_route_dispatch_v1(expired_expectation);
  IF expired.id IS DISTINCT FROM '50000000-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION 'expired exact dispatch was not inspectable';
  END IF;

  SELECT jsonb_build_object(
    'effect_id', id,
    'release_revision_id', release_revision_id,
    'operation_key', operation_key,
    'route_kind', route_kind,
    'external_token', external_token,
    'payload_hash', payload_hash,
    'state', state,
    'lease_owner', lease_owner,
    'lease_expires_at', lease_expires_at
  ) INTO fresh_expectation
  FROM public.ses_external_effects
  WHERE id = '50000000-0000-4000-8000-000000000003';

  SELECT * INTO fresh
  FROM public.inspect_stale_ses_route_dispatch_v1(fresh_expectation);
  IF fresh.id IS NOT NULL THEN
    RAISE EXCEPTION 'fresh dispatch was treated as stale';
  END IF;

  SELECT * INTO fresh
  FROM public.settle_stale_ses_route_dispatch_v1(
    expired_expectation || jsonb_build_object(
      'lease_owner', 'wrong-expired-generation'
    ),
    '{"kind":"no_send","match_count":0}'::jsonb,
    'recovery-test'
  );
  IF fresh.id IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM public.ses_external_effects
    WHERE id = '50000000-0000-4000-8000-000000000001'
      AND state = 'dispatching'
  ) THEN
    RAISE EXCEPTION 'stale settlement accepted a different lease generation';
  END IF;

  SELECT * INTO settled
  FROM public.settle_stale_ses_route_dispatch_v1(
    expired_expectation,
    '{"kind":"no_send","match_count":0}'::jsonb,
    'recovery-test'
  );
  IF settled.state IS DISTINCT FROM 'failed' THEN
    RAISE EXCEPTION 'no-send stale dispatch did not become failed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.ses_external_effect_events
    WHERE effect_id = settled.id
      AND event_kind = 'dispatch_lease_timed_out_no_send'
  ) THEN
    RAISE EXCEPTION 'timeout transition was not audit-recorded';
  END IF;

  expired_expectation := expired_expectation || jsonb_build_object(
    'state', 'failed'
  );
  SELECT * INTO retried
  FROM public.claim_ses_route_redispatch_v1(
    expired_expectation,
    'retry-generation',
    'recovery-test',
    120
  );
  IF retried.state IS DISTINCT FROM 'dispatching'
     OR retried.lease_owner IS DISTINCT FROM 'retry-generation'
     OR retried.lease_expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'failed route did not acquire a DB-clock redispatch lease';
  END IF;

  SELECT * INTO renewed
  FROM public.renew_ses_route_dispatch_lease_v1(
    jsonb_build_object(
      'effect_id', retried.id,
      'release_revision_id', retried.release_revision_id,
      'operation_key', retried.operation_key,
      'route_kind', retried.route_kind,
      'external_token', retried.external_token,
      'payload_hash', retried.payload_hash,
      'lease_owner', retried.lease_owner
    ),
    900
  );
  IF renewed.id IS DISTINCT FROM retried.id
     OR renewed.lease_expires_at <= retried.lease_expires_at THEN
    RAISE EXCEPTION 'active dispatch generation was not renewed';
  END IF;

  SELECT * INTO fresh
  FROM public.renew_ses_route_dispatch_lease_v1(
    jsonb_build_object(
      'effect_id', renewed.id,
      'release_revision_id', renewed.release_revision_id,
      'operation_key', renewed.operation_key,
      'route_kind', renewed.route_kind,
      'external_token', renewed.external_token,
      'payload_hash', renewed.payload_hash,
      'lease_owner', 'superseded-worker'
    ),
    900
  );
  IF fresh.id IS NOT NULL THEN
    RAISE EXCEPTION 'superseded dispatch generation renewed another owner lease';
  END IF;

  SELECT * INTO confirmed_after_retry
  FROM public.transition_ses_external_effect_v1(
    renewed.operation_key,
    'dispatching',
    'confirmed',
    'provider_confirmed',
    jsonb_build_object(
      'external_id', 'graph-retried-message',
      'provider_digest', jsonb_build_object(
        'message_id', 'graph-retried-message'
      ),
      'failure', '{}'::jsonb
    ),
    'recovery-test'
  );
  IF confirmed_after_retry.state IS DISTINCT FROM 'confirmed'
     OR confirmed_after_retry.failure IS DISTINCT FROM '{}'::jsonb THEN
    RAISE EXCEPTION 'successful redispatch retained its stale timeout failure';
  END IF;

  SELECT jsonb_build_object(
    'effect_id', id,
    'release_revision_id', release_revision_id,
    'operation_key', operation_key,
    'route_kind', route_kind,
    'external_token', external_token,
    'payload_hash', payload_hash,
    'state', state,
    'lease_owner', lease_owner,
    'lease_expires_at', lease_expires_at
  ) INTO sent_expectation
  FROM public.ses_external_effects
  WHERE id = '50000000-0000-4000-8000-000000000002';

  SELECT * INTO settled
  FROM public.settle_stale_ses_route_dispatch_v1(
    sent_expectation,
    jsonb_build_object(
      'kind', 'sent',
      'match_count', 1,
      'external_id', 'graph-sent-message',
      'provider_digest', jsonb_build_object(
        'message_id', 'graph-sent-message',
        'operation_token', 'SES-expired-sent'
      )
    ),
    'recovery-test'
  );
  IF settled.state IS DISTINCT FROM 'confirmed'
     OR settled.external_id IS DISTINCT FROM 'graph-sent-message' THEN
    RAISE EXCEPTION 'sent-found stale dispatch was not confirmed';
  END IF;
END;
$$;

DO $$
DECLARE
  surfaced record;
BEGIN
  SELECT * INTO surfaced
  FROM public.read_stuck_ses_route_dispatches_v1(
    ARRAY[
      '10000000-0000-4000-8000-000000000004'::uuid
    ]
  );
  IF surfaced.effect_id IS DISTINCT FROM
       '50000000-0000-4000-8000-000000000004'::uuid
     OR surfaced.operation_key IS DISTINCT FROM
       'ses:route_send:expired-inconclusive'
     OR surfaced.route_kind IS DISTINCT FROM 'invoice'
     OR surfaced.dispatch_age_seconds < 590
     OR surfaced.lease_owner IS DISTINCT FROM 'worker-inconclusive' THEN
    RAISE EXCEPTION 'expired inconclusive dispatch did not expose exact board alarm facts';
  END IF;

  SELECT * INTO surfaced
  FROM public.read_stuck_ses_route_dispatches_v1(
    ARRAY[
      '10000000-0000-4000-8000-000000000003'::uuid
    ]
  );
  IF surfaced.effect_id IS NOT NULL THEN
    RAISE EXCEPTION 'fresh dispatch appeared on the stuck board surface';
  END IF;
END;
$$;

-- Security-definer doors are never public/authenticated RPCs.
DO $$
DECLARE
  function_signature text;
BEGIN
  FOREACH function_signature IN ARRAY ARRAY[
    'public.inspect_stale_ses_route_dispatch_v1(jsonb)',
    'public.settle_stale_ses_route_dispatch_v1(jsonb,jsonb,text)',
    'public.claim_ses_route_redispatch_v1(jsonb,text,text,integer)',
    'public.renew_ses_route_dispatch_lease_v1(jsonb,integer)',
    'public.read_stuck_ses_route_dispatches_v1(uuid[])'
  ] LOOP
    IF has_function_privilege('anon', function_signature, 'EXECUTE')
       OR has_function_privilege(
         'authenticated',
         function_signature,
         'EXECUTE'
       ) THEN
      RAISE EXCEPTION 'privileged stale dispatch RPC is publicly executable: %', function_signature;
    END IF;
    IF NOT has_function_privilege(
      'service_role',
      function_signature,
      'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'service role cannot execute stale dispatch RPC: %', function_signature;
    END IF;
  END LOOP;
END;
$$;

ROLLBACK;

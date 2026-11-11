-- Contract for 20261111110000_job_deposit_gate_overrides.sql (RQ-19.e).
-- Only an admin, owner or ops manager of the job's own company records an
-- override, always with a reason, one live override per job, every grant and
-- revoke on the job's history, and the record can only ever be revoked once.
-- Synthetic data only.
BEGIN;

CREATE FUNCTION pg_temp.dg_refused(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE || ' ' || SQLERRM;
END $$;

CREATE TEMP TABLE dg (k text PRIMARY KEY, id uuid NOT NULL);
INSERT INTO dg VALUES
  ('org', '0a0a0a0a-0000-4000-8000-0000000019e1'), ('other_org', '0a0a0a0a-0000-4000-8000-0000000019e2'),
  ('owner', gen_random_uuid()), ('office', gen_random_uuid()), ('crew', gen_random_uuid()),
  ('estimator', gen_random_uuid()), ('outsider', gen_random_uuid()), ('job', gen_random_uuid());
INSERT INTO public.users(id, org_id, role, name, email)
  SELECT d.id, CASE WHEN d.k = 'outsider' THEN (SELECT id FROM dg WHERE k = 'other_org') ELSE (SELECT id FROM dg WHERE k = 'org') END,
         CASE d.k WHEN 'owner' THEN 'admin' WHEN 'office' THEN 'ops_manager' WHEN 'crew' THEN 'crew'
                  WHEN 'estimator' THEN 'estimator' ELSE 'admin' END,
         'ZZTEST Scope Checker', 'zztest-se-' || d.k || '@example.invalid'
  FROM dg d WHERE d.k IN ('owner', 'office', 'crew', 'estimator', 'outsider');
INSERT INTO public.jobs(id, org_id, type, status, job_number)
  VALUES ((SELECT id FROM dg WHERE k = 'job'), (SELECT id FROM dg WHERE k = 'org'),
          'fencing', 'awaiting_deposit', 'ZZTEST-SE-20261111-11');

-- 1. Who may grant: crew, an estimator and another company's admin are refused.
DO $$
DECLARE j uuid := (SELECT id FROM dg WHERE k = 'job'); err text; who text;
BEGIN
  FOREACH who IN ARRAY ARRAY['crew', 'estimator', 'outsider'] LOOP
    err := pg_temp.dg_refused(format('SELECT public.grant_job_deposit_gate_override(%L, %L, %L)',
      j, (SELECT id FROM dg WHERE k = who), 'Neighbour paying on site, owner agreed'));
    ASSERT err LIKE '%DG403 deposit_gate_override_not_allowed%', who || ' is refused: ' || coalesce(err, 'it went through');
  END LOOP;
  err := pg_temp.dg_refused(format('SELECT public.grant_job_deposit_gate_override(%L, %L, %L)',
    j, gen_random_uuid(), 'Neighbour paying on site, owner agreed'));
  ASSERT err LIKE '%DG403%', 'an unknown person is refused: ' || coalesce(err, 'it went through');
  ASSERT NOT EXISTS (SELECT 1 FROM public.job_deposit_gate_overrides WHERE job_id = j), 'nothing recorded';
END $$;

-- 2. A reason is required.
DO $$
DECLARE j uuid := (SELECT id FROM dg WHERE k = 'job'); err text;
BEGIN
  err := pg_temp.dg_refused(format('SELECT public.grant_job_deposit_gate_override(%L, %L, %L)',
    j, (SELECT id FROM dg WHERE k = 'office'), '   ok   '));
  ASSERT err LIKE '%DG400 deposit_gate_override_reason_required%', 'a short reason is refused: ' || coalesce(err, 'it went through');
  err := pg_temp.dg_refused(format('SELECT public.grant_job_deposit_gate_override(%L, %L, NULL)',
    j, (SELECT id FROM dg WHERE k = 'office')));
  ASSERT err LIKE '%DG400%', 'no reason is refused: ' || coalesce(err, 'it went through');
END $$;

-- 3. The office grants: the row names who, their role and the reason, the
-- unpaid reasons are kept, and the job history records it. A second live
-- override is refused.
DO $$
DECLARE j uuid := (SELECT id FROM dg WHERE k = 'job'); office uuid := (SELECT id FROM dg WHERE k = 'office');
  r public.job_deposit_gate_overrides; err text;
BEGIN
  r := public.grant_job_deposit_gate_override(j, office, '  Neighbour paying on site, owner agreed  ',
    '["party_without_deposit:B"]'::jsonb);
  ASSERT r.granted_by = office AND r.granted_by_role = 'ops_manager'
    AND r.granted_by_email = 'zztest-se-office@example.invalid'
    AND r.reason = 'Neighbour paying on site, owner agreed'
    AND r.unpaid_reasons = '["party_without_deposit:B"]'::jsonb
    AND r.org_id = (SELECT id FROM dg WHERE k = 'org') AND r.revoked_at IS NULL, 'the override names who and why';
  ASSERT (SELECT count(*) FROM public.job_events WHERE job_id = j AND event_type = 'deposit_gate_overridden'
            AND user_id = office AND detail_json->>'override_id' = r.id::text
            AND detail_json->>'reason' = r.reason) = 1, 'the job history records it';
  err := pg_temp.dg_refused(format('SELECT public.grant_job_deposit_gate_override(%L, %L, %L)',
    j, (SELECT id FROM dg WHERE k = 'owner'), 'A second override for the same job'));
  ASSERT err LIKE '%DG409 deposit_gate_override_exists%', 'one live override per job: ' || coalesce(err, 'it went through');
END $$;

-- 4. The record cannot be edited, deleted or truncated; only revoked, once.
DO $$
DECLARE j uuid := (SELECT id FROM dg WHERE k = 'job'); err text;
BEGIN
  err := pg_temp.dg_refused(format('UPDATE public.job_deposit_gate_overrides SET reason = %L WHERE job_id = %L',
    'Edited after the fact, not allowed', j));
  ASSERT err LIKE '23514%append only%', 'the reason cannot be edited: ' || coalesce(err, 'it went through');
  err := pg_temp.dg_refused(format('UPDATE public.job_deposit_gate_overrides SET revoked_at = now(), revoked_by = %L, revoke_reason = %L, reason = %L WHERE job_id = %L',
    (SELECT id FROM dg WHERE k = 'owner'), 'done', 'Rewritten while revoking', j));
  ASSERT err LIKE '23514%', 'a revoke cannot rewrite the grant: ' || coalesce(err, 'it went through');
  err := pg_temp.dg_refused(format('DELETE FROM public.job_deposit_gate_overrides WHERE job_id = %L', j));
  ASSERT err LIKE '23514%', 'it cannot be deleted: ' || coalesce(err, 'it went through');
  err := pg_temp.dg_refused('TRUNCATE public.job_deposit_gate_overrides');
  ASSERT err LIKE '23514%', 'it cannot be truncated: ' || coalesce(err, 'it went through');
END $$;

-- 5. Revoke: crew refused, a reason required, the owner revokes once, it is
-- recorded, a second revoke finds nothing live, and a fresh override can follow.
DO $$
DECLARE j uuid := (SELECT id FROM dg WHERE k = 'job'); owner_id uuid := (SELECT id FROM dg WHERE k = 'owner');
  r public.job_deposit_gate_overrides; err text;
BEGIN
  err := pg_temp.dg_refused(format('SELECT public.revoke_job_deposit_gate_override(%L, %L, %L)',
    j, (SELECT id FROM dg WHERE k = 'crew'), 'not mine'));
  ASSERT err LIKE '%DG403%', 'crew cannot revoke: ' || coalesce(err, 'it went through');
  err := pg_temp.dg_refused(format('SELECT public.revoke_job_deposit_gate_override(%L, %L, %L)', j, owner_id, ' '));
  ASSERT err LIKE '%DG400 deposit_gate_revoke_reason_required%', 'a revoke needs a reason: ' || coalesce(err, 'it went through');
  r := public.revoke_job_deposit_gate_override(j, owner_id, 'Neighbour did not pay');
  ASSERT r.revoked_by = owner_id AND r.revoked_at IS NOT NULL AND r.revoke_reason = 'Neighbour did not pay'
    AND r.reason = 'Neighbour paying on site, owner agreed', 'revoked, grant unchanged';
  ASSERT (SELECT count(*) FROM public.job_events WHERE job_id = j AND event_type = 'deposit_gate_override_revoked'
            AND user_id = owner_id) = 1, 'the revoke is on the job history';
  err := pg_temp.dg_refused(format('SELECT public.revoke_job_deposit_gate_override(%L, %L, %L)', j, owner_id, 'again'));
  ASSERT err LIKE '%DG409 deposit_gate_override_not_live%', 'nothing live to revoke: ' || coalesce(err, 'it went through');
  err := pg_temp.dg_refused(format('UPDATE public.job_deposit_gate_overrides SET revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL WHERE job_id = %L', j));
  ASSERT err LIKE '23514%', 'a revoke cannot be undone: ' || coalesce(err, 'it went through');
  r := public.grant_job_deposit_gate_override(j, owner_id, 'Owner agreed after the neighbour called', '[]');
  ASSERT (SELECT count(*) FROM public.job_deposit_gate_overrides WHERE job_id = j) = 2
    AND (SELECT count(*) FROM public.job_deposit_gate_overrides WHERE job_id = j AND revoked_at IS NULL) = 1,
    'a fresh override follows; the old one is kept';
END $$;

-- 6. Grants: browser roles cannot read the record or call either function.
DO $$
BEGIN
  ASSERT NOT has_table_privilege('authenticated', 'public.job_deposit_gate_overrides', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.job_deposit_gate_overrides', 'SELECT')
    AND NOT has_table_privilege('service_role', 'public.job_deposit_gate_overrides', 'INSERT')
    AND NOT has_table_privilege('service_role', 'public.job_deposit_gate_overrides', 'UPDATE')
    AND has_table_privilege('service_role', 'public.job_deposit_gate_overrides', 'SELECT'),
    'only the service role reads it, and writes go through the functions';
  ASSERT NOT has_function_privilege('authenticated', 'public.grant_job_deposit_gate_override(uuid,uuid,text,jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.revoke_job_deposit_gate_override(uuid,uuid,text)', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.grant_job_deposit_gate_override(uuid,uuid,text,jsonb)', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.revoke_job_deposit_gate_override(uuid,uuid,text)', 'EXECUTE'),
    'the functions are the service role''s only';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.job_deposit_gate_overrides'::regclass), 'row security on';
END $$;

ROLLBACK;

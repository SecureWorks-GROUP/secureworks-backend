-- Disposable prod-schema-clone contract test for the inert U1 migration.
-- Run only through scripts/test-makesafe-intake-case-migration.sh.
-- All fixture writes roll back. No AI, notification, job creation command or
-- production path is invoked.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.organisations') IS NULL
    OR to_regclass('public.jobs') IS NULL
    OR to_regclass('public.makesafe_companies') IS NULL
    OR to_regclass('public.makesafe_intake_drafts') IS NULL
    OR to_regclass('public.emails') IS NULL
    OR to_regclass('public.email_attachments') IS NULL
  THEN
    RAISE EXCEPTION 'prod-schema clone is missing a required live FK target';
  END IF;
END;
$$;

INSERT INTO public.organisations (id, name)
VALUES ('ffffffff-ffff-ffff-ffff-fffffffffff1', 'U1 disposable clone test org')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.makesafe_companies (id, org_id, slug, name)
VALUES (
  'ffffffff-ffff-ffff-ffff-fffffffffff2',
  'ffffffff-ffff-ffff-ffff-fffffffffff1',
  'u1-clone-builder',
  'U1 Clone Builder'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.emails (post_id, mailbox, received_at)
VALUES
  ('u1-original', 'u1-clone@example.invalid', now()),
  ('u1-twin', 'u1-clone@example.invalid', now()),
  ('u1-resend-1', 'u1-clone@example.invalid', now()),
  ('u1-resend-2', 'u1-clone@example.invalid', now()),
  ('u1-backfill', 'u1-clone@example.invalid', now())
ON CONFLICT (post_id) DO NOTHING;

INSERT INTO public.jobs (
  id, org_id, status, type, client_name, site_address
)
VALUES
  ('ffffffff-ffff-ffff-ffff-fffffffff101', 'ffffffff-ffff-ffff-ffff-fffffffffff1', 'accepted', 'makesafe', 'U1 A', '1 Test St'),
  ('ffffffff-ffff-ffff-ffff-fffffffff102', 'ffffffff-ffff-ffff-ffff-fffffffffff1', 'accepted', 'makesafe', 'U1 B', '1 Test St'),
  ('ffffffff-ffff-ffff-ffff-fffffffff103', 'ffffffff-ffff-ffff-ffff-fffffffffff1', 'accepted', 'makesafe', 'U1 C', '1 Test St')
ON CONFLICT (id) DO NOTHING;

-- Root live case. The BEFORE trigger fills lineage_id=id and cycle=1.
INSERT INTO public.makesafe_intake_cases (
  id, org_id, instruction_key, lineage_id, company_id, company_slug_raw,
  company_key, external_ref_raw, external_ref_canonical, builder_po_raw,
  builder_po_canonical, wo_po_identity_key, normaliser_version,
  field_provenance, client_name, site_address, state, job_id,
  last_decision_provenance, last_decision_actor, last_decision_reason,
  received_at
) VALUES (
  'ffffffff-ffff-ffff-ffff-fffffffff201',
  'ffffffff-ffff-ffff-ffff-fffffffffff1',
  'fixture:po-a',
  'ffffffff-ffff-ffff-ffff-fffffffff201',
  'ffffffff-ffff-ffff-ffff-fffffffffff2',
  'u1 raw builder',
  'company:ffffffff-ffff-ffff-ffff-fffffffffff2',
  'CLAIM-1',
  'CLAIM-1',
  'PO A',
  'PO-A',
  'wo:CLAIM-1/po:PO-A',
  'makesafe_refs.normaliseRef+wo_po_precedence@v1',
  '{"identity_v1":{"method":"deterministic"}}',
  'U1 A',
  '1 Test St',
  'confirmed_live_job',
  'ffffffff-ffff-ffff-ffff-fffffffff101',
  'deterministic',
  'clone_test',
  'initial fixture',
  now()
);

-- B1 hostile twins and resends: one case, four append-only sources.
INSERT INTO public.makesafe_intake_case_sources (
  org_id, case_id, post_id, role, provenance, received_at
) VALUES
  ('ffffffff-ffff-ffff-ffff-fffffffffff1', 'ffffffff-ffff-ffff-ffff-fffffffff201', 'u1-original', 'original', 'deterministic', now()),
  ('ffffffff-ffff-ffff-ffff-fffffffffff1', 'ffffffff-ffff-ffff-ffff-fffffffff201', 'u1-twin', 'twin', 'deterministic', now()),
  ('ffffffff-ffff-ffff-ffff-fffffffffff1', 'ffffffff-ffff-ffff-ffff-fffffffff201', 'u1-resend-1', 'resend', 'deterministic', now()),
  ('ffffffff-ffff-ffff-ffff-fffffffffff1', 'ffffffff-ffff-ffff-ffff-fffffffff201', 'u1-resend-2', 'resend', 'deterministic', now());

DO $$
BEGIN
  BEGIN
    INSERT INTO public.makesafe_intake_case_sources (
      org_id, case_id, post_id, role, provenance, received_at
    ) VALUES (
      'ffffffff-ffff-ffff-ffff-fffffffffff1',
      'ffffffff-ffff-ffff-ffff-fffffffff201',
      'u1-original',
      'twin',
      'deterministic',
      now()
    );
    RAISE EXCEPTION 'expected source replay uniqueness failure';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END;
$$;

-- B4 PO sibling does not collide on shared claim ref.
INSERT INTO public.makesafe_intake_cases (
  id, org_id, instruction_key, lineage_id, parent_case_id, parent_relation,
  company_id, company_slug_raw, company_key, external_ref_raw,
  external_ref_canonical, builder_po_raw, builder_po_canonical,
  wo_po_identity_key, normaliser_version, field_provenance,
  client_name, site_address, state, job_id, last_decision_provenance,
  last_decision_actor, last_decision_reason, received_at
) VALUES (
  'ffffffff-ffff-ffff-ffff-fffffffff202',
  'ffffffff-ffff-ffff-ffff-fffffffffff1',
  'fixture:po-b',
  'ffffffff-ffff-ffff-ffff-fffffffff201',
  'ffffffff-ffff-ffff-ffff-fffffffff201',
  'sibling_of',
  'ffffffff-ffff-ffff-ffff-fffffffffff2',
  'u1 raw builder',
  'company:ffffffff-ffff-ffff-ffff-fffffffffff2',
  'CLAIM-1',
  'CLAIM-1',
  'PO B',
  'PO-B',
  'wo:CLAIM-1/po:PO-B',
  'makesafe_refs.normaliseRef+wo_po_precedence@v1',
  '{"identity_v1":{"method":"deterministic"}}',
  'U1 B',
  '1 Test St',
  'confirmed_live_job',
  'ffffffff-ffff-ffff-ffff-fffffffff102',
  'deterministic',
  'clone_test',
  'PO sibling fixture',
  now()
);

-- Cycle-in-key reopen. Trigger forces cycle 2 regardless of caller default.
INSERT INTO public.makesafe_intake_cases (
  id, org_id, instruction_key, lineage_id, parent_case_id, parent_relation,
  company_id, company_slug_raw, company_key, external_ref_raw,
  external_ref_canonical, builder_po_raw, builder_po_canonical,
  wo_po_identity_key, normaliser_version, field_provenance,
  client_name, site_address, state, job_id, last_decision_provenance,
  last_decision_actor, last_decision_reason, received_at
) VALUES (
  'ffffffff-ffff-ffff-ffff-fffffffff203',
  'ffffffff-ffff-ffff-ffff-fffffffffff1',
  'fixture:po-a:reopen',
  'ffffffff-ffff-ffff-ffff-fffffffff201',
  'ffffffff-ffff-ffff-ffff-fffffffff201',
  'reopen_of',
  'ffffffff-ffff-ffff-ffff-fffffffffff2',
  'u1 raw builder',
  'company:ffffffff-ffff-ffff-ffff-fffffffffff2',
  'CLAIM-1',
  'CLAIM-1',
  'PO A',
  'PO-A',
  'wo:CLAIM-1/po:PO-A',
  'makesafe_refs.normaliseRef+wo_po_precedence@v1',
  '{"identity_v1":{"method":"deterministic"}}',
  'U1 C',
  '1 Test St',
  'confirmed_live_job',
  'ffffffff-ffff-ffff-ffff-fffffffff103',
  'deterministic',
  'clone_test',
  'reopen fixture',
  now()
);

DO $$
DECLARE actual_cycle integer;
BEGIN
  SELECT cycle INTO actual_cycle
  FROM public.makesafe_intake_cases
  WHERE id = 'ffffffff-ffff-ffff-ffff-fffffffff203';
  IF actual_cycle <> 2 THEN
    RAISE EXCEPTION 'expected reopen cycle 2, got %', actual_cycle;
  END IF;
END;
$$;

-- Hostile lineage and impossible-state writes must fail.
DO $$
BEGIN
  BEGIN
    UPDATE public.makesafe_intake_cases
    SET parent_case_id = 'ffffffff-ffff-ffff-ffff-fffffffff202'
    WHERE id = 'ffffffff-ffff-ffff-ffff-fffffffff203';
    RAISE EXCEPTION 'expected immutable parent failure';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'expected immutable parent failure' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO public.makesafe_intake_cases (
      id, org_id, instruction_key, lineage_id, state, reason_code, job_id,
      normaliser_version, last_decision_provenance, last_decision_actor,
      last_decision_reason, received_at
    ) VALUES (
      'ffffffff-ffff-ffff-ffff-fffffffff204',
      'ffffffff-ffff-ffff-ffff-fffffffffff1',
      'fixture:cancellation-with-job',
      'ffffffff-ffff-ffff-ffff-fffffffff204',
      'exception',
      'cancellation',
      'ffffffff-ffff-ffff-ffff-fffffffff101',
      'makesafe_refs.normaliseRef+wo_po_precedence@v1',
      'deterministic',
      'clone_test',
      'must fail',
      now()
    );
    RAISE EXCEPTION 'expected cancellation job check failure';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;

-- Backfill natural-key run two creates no case event or source write.
CREATE TEMP TABLE backfill_second_run_writes (
  case_writes integer,
  source_writes integer,
  event_writes integer
) ON COMMIT DROP;

WITH inserted AS (
  INSERT INTO public.makesafe_intake_cases (
    id, org_id, instruction_key, lineage_id, state, reason_code,
    side_effects_suppressed, normaliser_version, last_decision_provenance,
    last_decision_actor, last_decision_reason, received_at
  ) VALUES (
    'ffffffff-ffff-ffff-ffff-fffffffff205',
    'ffffffff-ffff-ffff-ffff-fffffffffff1',
    'fixture:backfill',
    'ffffffff-ffff-ffff-ffff-fffffffff205',
    'exception',
    'below_identity_floor',
    true,
    'makesafe_refs.normaliseRef+wo_po_precedence@v1',
    'backfill',
    'clone_backfill',
    'first run',
    now()
  ) ON CONFLICT (org_id, instruction_key) DO NOTHING
  RETURNING 1
)
SELECT count(*) FROM inserted;

INSERT INTO public.makesafe_intake_case_sources (
  org_id, case_id, post_id, role, provenance, received_at
) VALUES (
  'ffffffff-ffff-ffff-ffff-fffffffffff1',
  'ffffffff-ffff-ffff-ffff-fffffffff205',
  'u1-backfill',
  'original',
  'backfill',
  now()
) ON CONFLICT (org_id, post_id) DO NOTHING;

DO $$
DECLARE before_events integer;
DECLARE after_events integer;
DECLARE case_count integer;
DECLARE source_count integer;
BEGIN
  SELECT count(*) INTO before_events
  FROM public.makesafe_intake_case_events
  WHERE case_id = 'ffffffff-ffff-ffff-ffff-fffffffff205';

  WITH inserted AS (
    INSERT INTO public.makesafe_intake_cases (
      id, org_id, instruction_key, lineage_id, state, reason_code,
      side_effects_suppressed, normaliser_version, last_decision_provenance,
      last_decision_actor, last_decision_reason, received_at
    ) VALUES (
      'ffffffff-ffff-ffff-ffff-fffffffff205',
      'ffffffff-ffff-ffff-ffff-fffffffffff1',
      'fixture:backfill',
      'ffffffff-ffff-ffff-ffff-fffffffff205',
      'exception',
      'below_identity_floor',
      true,
      'makesafe_refs.normaliseRef+wo_po_precedence@v1',
      'backfill',
      'clone_backfill',
      'second run',
      now()
    ) ON CONFLICT (org_id, instruction_key) DO NOTHING
    RETURNING 1
  ) SELECT count(*) INTO case_count FROM inserted;

  WITH inserted AS (
    INSERT INTO public.makesafe_intake_case_sources (
      org_id, case_id, post_id, role, provenance, received_at
    ) VALUES (
      'ffffffff-ffff-ffff-ffff-fffffffffff1',
      'ffffffff-ffff-ffff-ffff-fffffffff205',
      'u1-backfill',
      'original',
      'backfill',
      now()
    ) ON CONFLICT (org_id, post_id) DO NOTHING
    RETURNING 1
  ) SELECT count(*) INTO source_count FROM inserted;

  SELECT count(*) INTO after_events
  FROM public.makesafe_intake_case_events
  WHERE case_id = 'ffffffff-ffff-ffff-ffff-fffffffff205';

  INSERT INTO backfill_second_run_writes
  VALUES (case_count, source_count, after_events - before_events);
  IF case_count <> 0 OR source_count <> 0 OR after_events <> before_events THEN
    RAISE EXCEPTION 'backfill run two was not zero-write';
  END IF;
END;
$$;

-- Event/source ledgers deny mutation even to service_role writes.
DO $$
BEGIN
  BEGIN
    UPDATE public.makesafe_intake_case_events
    SET decision_reason = 'tampered'
    WHERE case_id = 'ffffffff-ffff-ffff-ffff-fffffffff201';
    RAISE EXCEPTION 'expected append-only event failure';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'expected append-only event failure' THEN RAISE; END IF;
  END;
END;
$$;

-- RLS shape probes are catalogue-level so the clone runner need not assume its
-- login can SET ROLE. Runtime role probes belong to U10's dedicated tenant.
DO $$
DECLARE protected_count integer;
BEGIN
  SELECT count(*) INTO protected_count
  FROM pg_class relation
  JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relname IN (
      'makesafe_intake_cases',
      'makesafe_intake_case_sources',
      'makesafe_intake_case_events'
    )
    AND relation.relrowsecurity;
  IF protected_count <> 3 THEN
    RAISE EXCEPTION 'expected RLS on all three case tables';
  END IF;
END;
$$;

ROLLBACK;

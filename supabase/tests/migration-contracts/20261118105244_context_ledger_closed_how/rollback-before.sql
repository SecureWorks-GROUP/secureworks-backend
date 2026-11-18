BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.jobs (id, org_id, type, status, job_number, created_at)
VALUES ('00000000-0000-4000-8000-000000000429', '00000000-0000-0000-0000-000000000001', 'fencing', 'accepted', 'ZZTEST-429', '2026-10-01T00:00:00+08')
ON CONFLICT (id) DO NOTHING;
SET LOCAL session_replication_role = origin;
COMMIT;

INSERT INTO public.context_ledger_generations (id, job_id, kind, status, reader, promoted_at)
VALUES ('00000000-0000-4000-8000-000000000429', '00000000-0000-4000-8000-000000000429', 'rebuild', 'live', 'luna-ledger:v9-words1', '2026-11-03T10:00:00+08')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.context_ledger_items (
  id, generation_id, job_id, item_key, item_type, status, from_role, what,
  opened_at, opened_by, closed_at, closed_by, written_by
) VALUES (
  '00000000-0000-4000-8000-000000010429',
  '00000000-0000-4000-8000-000000000429',
  '00000000-0000-4000-8000-000000000429',
  'item:rollback:history',
  'request',
  'closed',
  'customer',
  'Quote requested.',
  '2026-11-03T09:00:00+08',
  '[{"table":"job_events","id":"rb-open"}]',
  '2026-11-04T09:00:00+08',
  '[{"table":"job_documents","id":"rb-doc"}]',
  'model:luna-ledger:v9-words1'
)
ON CONFLICT (id) DO NOTHING;

SELECT public.context_ledger_closed_how_install();

INSERT INTO public.context_ledger_transitions (item_id, generation_id, job_id, from_status, to_status, at, by, evidence, reason)
VALUES (
  '00000000-0000-4000-8000-000000010429',
  '00000000-0000-4000-8000-000000000429',
  '00000000-0000-4000-8000-000000000429',
  'open',
  'closed',
  '2026-11-04T09:00:00+08',
  'rule:record_close_v1',
  '[{"table":"job_documents","id":"rb-doc"}]',
  'Quote sent.'
);

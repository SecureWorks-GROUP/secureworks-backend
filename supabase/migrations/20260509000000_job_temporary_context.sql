-- ════════════════════════════════════════════════════════════
-- Migration — public.job_temporary_context (Slice 2)
--
-- Spec: cio/operations/board/Evidence-Spine-JARVIS-Memory/
--        fact-extractor-hardening/hardening-plan-2026-05-08.md
--
-- Business surface name: "temporary context".
-- This is a REAL TABLE, not an alias of public.smart_nudges. The temporary-
-- context layer is bounded to extracted facts that auto-expire on an explicit
-- TTL. smart_nudges remains JARVIS's proactive-alert queue and stays unchanged.
--
-- Lifecycle:
--   - extractor v2 Class B branch INSERTs rows here with expires_at set.
--   - dossier reads filter `where expires_at > now()`.
--   - cleanup is implicit (rows past expires_at are simply not read);
--     a future maintenance job MAY delete expired rows.
--
-- Boundaries enforced by this migration:
--   - expires_at is NOT NULL (every temp-context row carries a TTL).
--   - kind is constrained to the temp-context allowlist (current_state,
--     pending_action, quote_issue) via a CHECK constraint.
--   - job_id is REFERENCES public.jobs (id) so deleted jobs cascade clean.
--
-- Human-review gate:
--   This migration ships in a SEPARATE PR on secureworks-site. It is staged
--   here in the docs repo so the agent-side PR can reference the canonical
--   SQL. Marnin (or a future session) opens the site PR and applies the
--   migration via the standard supabase CLI flow. Until applied, the agent
--   code's writeFactV2() temp-context branch will fail at INSERT time —
--   acceptable because the v2 extractor is not yet wired into any cron path.
-- ════════════════════════════════════════════════════════════

create table if not exists public.job_temporary_context (
  id              uuid          primary key default gen_random_uuid(),
  job_id          uuid          not null references public.jobs(id) on delete cascade,
  kind            text          not null check (kind in ('current_state', 'pending_action', 'quote_issue')),
  value           jsonb         not null,
  provenance      jsonb         not null,
  expires_at      timestamptz   not null,
  correlation_id  uuid,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now()
);

-- Active-row reads filter `expires_at > now()` in the query. Do not put
-- now() in a partial-index predicate: Postgres requires index predicates to be
-- immutable. A plain (job_id, expires_at) index supports the same read shape.
create index if not exists idx_jtc_job_expires
  on public.job_temporary_context (job_id, expires_at);

-- Per-kind reads for dossier sub-panels.
create index if not exists idx_jtc_kind on public.job_temporary_context (kind);

-- String-hash lookup for application-level idempotency. This is intentionally
-- non-unique: the same temporary note may legitimately recur after an earlier
-- row expires.
create index if not exists idx_jtc_job_kind_value_hash
  on public.job_temporary_context (
    job_id,
    kind,
    md5(coalesce(value->>'text', '')),
    expires_at desc
  );

-- Updated-at trigger reuses the existing public.set_updated_at() function
-- if present in this project; otherwise this block is a no-op (the function
-- exists on every SecureWorks Supabase as part of the t7-evidence-spine
-- migration set).
do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at')
     and not exists (
       select 1 from pg_trigger
       where tgname = 'trg_jtc_updated_at'
         and tgrelid = 'public.job_temporary_context'::regclass
     ) then
    create trigger trg_jtc_updated_at
      before update on public.job_temporary_context
      for each row execute function public.set_updated_at();
  end if;
end$$;

-- RLS — service-role writes only. Reads gated by the same RLS pattern as
-- job_context. Apply the existing org-scoped read policy.
alter table public.job_temporary_context enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'job_temporary_context'
      and policyname = 'service_role_all_jtc'
  ) then
    create policy "service_role_all_jtc"
      on public.job_temporary_context for all
      to service_role
      using (true)
      with check (true);
  end if;
end$$;

comment on table public.job_temporary_context is
  'Temporary context layer — Slice 2 of fact-extractor v2 hardening. '
  'Class B (transient) facts land here with expires_at; dossier filters on expires_at > now(). '
  'Distinct from public.smart_nudges (JARVIS proactive alerts).';

comment on column public.job_temporary_context.kind is
  'Allowed: current_state | pending_action | quote_issue.';

comment on column public.job_temporary_context.expires_at is
  'TTL anchor derived from temporal hints in the source text. NOT NULL by contract.';

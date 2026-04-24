-- SecureSale v2 Release 1: lost_reasons capture
-- Spec: ~/Projects/secureworks-docs/features/sale-dashboard.md
-- Why: force reason capture when a lead dies. Feeds coaching + objection library later.

create table if not exists public.lost_reasons (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  job_id uuid not null references public.jobs(id) on delete cascade,
  reason_code text not null check (reason_code in (
    'price','timing','ghost','competitor','finance',
    'spouse_veto','site_not_ready','changed_scope','other'
  )),
  free_text text,
  rep_user_id uuid references public.users(id),
  created_at timestamptz not null default now()
);

create index if not exists lost_reasons_job_id_idx on public.lost_reasons(job_id);
create index if not exists lost_reasons_rep_user_id_idx on public.lost_reasons(rep_user_id);
create index if not exists lost_reasons_reason_code_idx on public.lost_reasons(reason_code);
create index if not exists lost_reasons_created_at_idx on public.lost_reasons(created_at desc);

alter table public.lost_reasons enable row level security;

-- Service role bypasses RLS; edge fns use service key. No client-side RLS policy for now.
-- (Per project convention: clients read via edge fns, not direct Supabase queries.)

comment on table public.lost_reasons is
  'SecureSale v2: structured capture of why a deal died. One row per lost job. Feeds R3 coaching + objection clustering.';

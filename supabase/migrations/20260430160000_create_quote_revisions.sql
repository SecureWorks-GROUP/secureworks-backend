-- 20260430160000_create_quote_revisions.sql
-- CAP0-QUOTE-REVISION-MINIMAL — Job Release Packet V1 anchor.
--
-- Lifecycle (controlled by triggers below):
--   INSERT  staged   sent_at IS NULL           created at /send-quote/send entry, before Resend
--   UPDATE  released sent_at IS NOT NULL       only ever flips NULL -> timestamptz; never reverses
--   UPDATE  any other column once released     refused
--   DELETE  any row                            refused
--
-- Idempotence: unique (job_id, version). A retry that fires before the staged
-- row was released matches via ON CONFLICT and reuses the same row. A retry on a
-- row already released (sent_at IS NOT NULL) is refused at the trigger level
-- before it can corrupt anything.

create table if not exists public.quote_revisions (
  id                    uuid primary key default gen_random_uuid(),
  job_id                uuid not null references public.jobs(id) on delete restrict,
  job_document_id       uuid not null references public.job_documents(id) on delete restrict,
  version               integer not null,
  recipient_email       text not null,
  recipient_label       text null,
  scope_snapshot_json   jsonb not null,
  pricing_snapshot_json jsonb not null,
  totals_snapshot_json  jsonb not null,
  manifest_url          text not null,
  manifest_hash         text not null,
  pdf_url               text not null,
  margin_pct            numeric(6,3) null,
  margin_floor_breached boolean not null default false,
  override_reason       text null,
  council_status        text not null default 'unknown',
  build_kind            text not null,
  neighbours_required   boolean null,
  released_via          text not null,
  sent_at               timestamptz null,
  staged_at             timestamptz not null default now(),
  released_by_user_id   uuid null,
  schema_version        text not null default '1.0',

  constraint quote_revisions_version_positive check (version > 0),
  constraint quote_revisions_council_status_valid
    check (council_status in ('not_required','required_pending','required_approved','unknown')),
  constraint quote_revisions_build_kind_valid
    check (build_kind in ('patio','fence','misc')),
  constraint quote_revisions_released_via_valid
    check (released_via in ('send-quote/send','send-quote/send-runs','ops-api/send_quick_quote_email')),
  constraint quote_revisions_unique_job_version unique (job_id, version)
);

create index if not exists quote_revisions_job_idx           on public.quote_revisions (job_id);
create index if not exists quote_revisions_doc_idx           on public.quote_revisions (job_document_id);
create index if not exists quote_revisions_sent_idx          on public.quote_revisions (sent_at) where sent_at is not null;
create index if not exists quote_revisions_staged_idx        on public.quote_revisions (job_id) where sent_at is null;
create index if not exists quote_revisions_manifest_hash_idx on public.quote_revisions (manifest_hash);

alter table public.quote_revisions enable row level security;
-- intentionally no policies; service role bypasses RLS (clients must read via
-- a release-packet read API, not directly).

-- ── Controlled-immutability trigger ────────────────────────────────────────
-- Permits exactly one transition per row: NULL sent_at -> non-NULL sent_at.
-- Refuses anything else. IS DISTINCT FROM is required (not <>) because nullable
-- columns (margin_pct, override_reason, recipient_label, neighbours_required,
-- released_by_user_id) compare to NULL with `<>` returning NULL — which would
-- silently allow mutation.
create or replace function public.quote_revisions_controlled_immutable()
returns trigger language plpgsql as $$
begin
  if OLD.sent_at is not null then
    raise exception 'quote_revisions rows are immutable once sent_at is set; row %', OLD.id
      using errcode = '23514';
  end if;
  if NEW.sent_at is null then
    raise exception 'quote_revisions: cannot UPDATE while leaving sent_at NULL; row %', OLD.id
      using errcode = '23514';
  end if;
  if NEW.id is distinct from OLD.id
     or NEW.job_id is distinct from OLD.job_id
     or NEW.job_document_id is distinct from OLD.job_document_id
     or NEW.version is distinct from OLD.version
     or NEW.recipient_email is distinct from OLD.recipient_email
     or NEW.recipient_label is distinct from OLD.recipient_label
     or NEW.scope_snapshot_json is distinct from OLD.scope_snapshot_json
     or NEW.pricing_snapshot_json is distinct from OLD.pricing_snapshot_json
     or NEW.totals_snapshot_json is distinct from OLD.totals_snapshot_json
     or NEW.manifest_url is distinct from OLD.manifest_url
     or NEW.manifest_hash is distinct from OLD.manifest_hash
     or NEW.pdf_url is distinct from OLD.pdf_url
     or NEW.margin_pct is distinct from OLD.margin_pct
     or NEW.margin_floor_breached is distinct from OLD.margin_floor_breached
     or NEW.override_reason is distinct from OLD.override_reason
     or NEW.council_status is distinct from OLD.council_status
     or NEW.build_kind is distinct from OLD.build_kind
     or NEW.neighbours_required is distinct from OLD.neighbours_required
     or NEW.released_via is distinct from OLD.released_via
     or NEW.staged_at is distinct from OLD.staged_at
     or NEW.released_by_user_id is distinct from OLD.released_by_user_id
     or NEW.schema_version is distinct from OLD.schema_version
  then
    raise exception 'quote_revisions: only sent_at may transition NULL -> NOT NULL on UPDATE; row %', OLD.id
      using errcode = '23514';
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_quote_revisions_controlled_immutable on public.quote_revisions;
create trigger trg_quote_revisions_controlled_immutable
  before update on public.quote_revisions
  for each row execute function public.quote_revisions_controlled_immutable();

-- ── No-delete trigger ──────────────────────────────────────────────────────
create or replace function public.quote_revisions_no_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'quote_revisions rows cannot be deleted; row %', OLD.id
    using errcode = '23514';
end;
$$;

drop trigger if exists trg_quote_revisions_no_delete on public.quote_revisions;
create trigger trg_quote_revisions_no_delete
  before delete on public.quote_revisions
  for each row execute function public.quote_revisions_no_delete();

comment on table public.quote_revisions is
  'Cap 0 Job Release Packet V1 anchor. Immutable per row once sent_at is set.
   See cio/reports/2026-04-30-job-release-packet-v1/release-packet-contract-v1.md.';
comment on column public.quote_revisions.sent_at is
  'NULL while staged (created pre-Resend). NOT NULL once released (post-Resend success + jobs.status flip). Never reverses.';
comment on column public.quote_revisions.manifest_hash is
  'SHA-256 hex of the canonicalized release packet manifest payload. Recursive
   deep-sort + SHA-256 (NOT JSON.stringify(obj, keys.sort()) — that pattern is
   broken for nested objects).';

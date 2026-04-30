-- 20260501100000_quote_revision_binding_and_read_shape.sql
-- CAP0-PO-REVISION-BINDING + CAP0-WORK-ORDER-REVISION-BINDING + CAP0-RELEASE-PACKET-READ-API (Postgres function only).
--
-- Three slices in one migration because they're all additive nullable
-- columns + one new SECURITY DEFINER function. No backfill, no destructive
-- changes, no constraint tightening. Existing rows stay NULL on the new
-- columns; future writes can populate them.

-- ──────────────────────────────────────────────────────────────────
-- 1. Additive FK columns: tie POs / WOs / job_documents to revisions
-- ──────────────────────────────────────────────────────────────────
alter table public.purchase_orders
  add column if not exists quote_revision_id uuid null
    references public.quote_revisions(id) on delete restrict;

create index if not exists purchase_orders_quote_revision_idx
  on public.purchase_orders (quote_revision_id) where quote_revision_id is not null;

alter table public.work_orders
  add column if not exists quote_revision_id uuid null
    references public.quote_revisions(id) on delete restrict;

create index if not exists work_orders_quote_revision_idx
  on public.work_orders (quote_revision_id) where quote_revision_id is not null;

alter table public.job_documents
  add column if not exists quote_revision_id uuid null
    references public.quote_revisions(id) on delete restrict;

create index if not exists job_documents_quote_revision_idx
  on public.job_documents (quote_revision_id) where quote_revision_id is not null;

comment on column public.purchase_orders.quote_revision_id is
  'Optional FK to the released quote_revisions row this PO was generated from. NULL on rows created before CAP0-PO-REVISION-BINDING. Backfill is a separate slice.';
comment on column public.work_orders.quote_revision_id is
  'Optional FK to the released quote_revisions row this WO was generated from.';
comment on column public.job_documents.quote_revision_id is
  'Optional FK to the released quote_revisions row this document was generated from.';

-- ──────────────────────────────────────────────────────────────────
-- 2. Postgres function get_release_packet(job_id) returns jsonb
--    Read-only. SECURITY INVOKER (callers must have read access).
--    Mirrors manifest_types.ReleasePacket shape.
-- ──────────────────────────────────────────────────────────────────
create or replace function public.get_release_packet(p_job_id uuid)
returns jsonb
language sql
stable
security invoker
as $$
  with rev as (
    select * from public.quote_revisions
    where job_id = p_job_id and sent_at is not null
    order by sent_at desc limit 1
  ),
  doc as (
    select jd.* from public.job_documents jd
    where jd.id = (select job_document_id from rev)
  ),
  pos as (
    select po.id, po.po_number, po.po_type, po.supplier_name,
           po.subtotal, po.tax, po.total, po.status, po.delivery_date,
           po.quote_revision_id
    from public.purchase_orders po where po.job_id = p_job_id
    order by po.created_at
  ),
  wos as (
    select wo.id, wo.wo_number, wo.status, wo.scope_items, wo.special_instructions,
           wo.share_token, wo.scheduled_date, wo.assigned_user_id,
           wo.quote_revision_id
    from public.work_orders wo where wo.job_id = p_job_id
    order by wo.created_at desc limit 1
  ),
  med as (
    select id, type, phase, storage_url, thumbnail_url, label,
           taken_at, lat, lng
    from public.job_media where job_id = p_job_id
    order by created_at
  ),
  evts as (
    select id, event_type, occurred_at::text as occurred_at, source,
           correlation_id, payload
    from public.business_events where job_id = p_job_id
    order by occurred_at desc limit 50
  ),
  job_row as (
    select id, job_number, type, status,
           quoted_at::text as quoted_at,
           accepted_at::text as accepted_at,
           completed_at::text as completed_at,
           client_name, client_email, site_address, site_suburb
    from public.jobs where id = p_job_id
  )
  select jsonb_build_object(
    'revision', (select to_jsonb(rev.*) from rev),
    'document', (select to_jsonb(doc.*) from doc),
    'purchase_orders', coalesce((select jsonb_agg(to_jsonb(pos.*)) from pos), '[]'::jsonb),
    'work_order', (select to_jsonb(wos.*) from wos),
    'media', coalesce((select jsonb_agg(to_jsonb(med.*)) from med), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(to_jsonb(evts.*)) from evts), '[]'::jsonb),
    'job', (select to_jsonb(job_row.*) from job_row),
    'staged', false  -- by definition, only released revisions are returned
  );
$$;

comment on function public.get_release_packet(uuid) is
  'CAP0-RELEASE-PACKET-READ-API. Returns the latest released quote_revision for
   a job + its document + downstream POs/WOs/media/events + the job row. Read-only.
   Used by Cap 1 Job Readiness Engine, Secure Sale, and JARVIS job-memory.
   Returns null if the job has no released revision yet (still in draft).';

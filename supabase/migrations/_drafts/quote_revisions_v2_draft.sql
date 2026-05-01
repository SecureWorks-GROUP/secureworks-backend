-- Cap 0 Full Release Packet V2 — quote_revisions schema additions (DRAFT).
--
-- DO NOT APPLY. This file lives in `_drafts/` so the Supabase CLI does not
-- auto-pick it up via `db push`. It is the migration plan for Loop 3 (P2)
-- of the V2 plan; Loop 1 (P0, this PR) only ships the contract/types/
-- validator/fixtures/tests. Loop 3 takes this draft, renames it with a real
-- timestamp, moves it to `supabase/migrations/`, and applies it.
--
-- What this migration does:
--   1. Add 8 new jsonb snapshot columns + 2 internal-cost columns to
--      `quote_revisions` so the V2 envelope + InternalCostSnapshot can be
--      sealed alongside the existing minimal-shape columns.
--   2. Extend the controlled-immutability trigger so the new columns are
--      protected by the same NULL→NOT NULL discipline as the existing
--      sent_at-only-may-transition rule.
--   3. Add `superseded_at` + `superseded_by_revision_id` to `job_documents`
--      so v2 share tokens can be auto-disabled when a higher-version
--      revision INSERTs (lifecycle wiring lands in Loop 5 / P4; column ships
--      now to avoid a second migration).
--
-- What this migration does NOT do:
--   - Does not back-fill existing rows. They keep schema_version='1.0' and
--     NULL on the new columns. The read API (get_release_packet_v2) returns
--     a class-3-style "minimal-only" shape for those rows.
--   - Does not create the lifecycle checkpoint tables (quote_acceptances,
--     invoice_packets, work_order_packets, completion_packets). Those are
--     Loop 5 / P4 work.
--   - Does not change the existing `manifest_url`, `manifest_hash`, or
--     `manifest_canonical_text` columns. V2 reuses them for the client-
--     facing manifest. The new internal-cost columns are parallel.

-- ── 1. New snapshot columns on quote_revisions ─────────────────────────────

alter table public.quote_revisions
  add column if not exists contacts_snapshot_json     jsonb null,
  add column if not exists documents_snapshot_json    jsonb null,
  add column if not exists media_snapshot_json        jsonb null,
  add column if not exists qa_snapshot_json           jsonb null,
  add column if not exists send_snapshot_json         jsonb null,
  add column if not exists terms_snapshot_json        jsonb null,
  add column if not exists provenance_snapshot_json   jsonb null,
  add column if not exists option_label               text  null;

comment on column public.quote_revisions.contacts_snapshot_json is
  'V2: frozen snapshot of all job_contacts at release time, including per-
   contact authority (can_view/can_accept/pays). NULL for pre-V2 rows.';
comment on column public.quote_revisions.documents_snapshot_json is
  'V2: frozen snapshot of quote PDF + per-contact PDFs + email inputs +
   attachments + council plans, each with sha256. NULL for pre-V2 rows.';
comment on column public.quote_revisions.media_snapshot_json is
  'V2: pinned manifest of job_media at release: id, type, phase, sha256,
   storage path, label, taken_at, lat/lng. NULL for pre-V2 rows.';
comment on column public.quote_revisions.qa_snapshot_json is
  'V2: hard_blockers_passed[], soft_warnings[], council_status,
   customer_facing_summary, qa_passed_by, overrides[]. NULL for pre-V2 rows.';
comment on column public.quote_revisions.send_snapshot_json is
  'V2: per-recipient send confirmations at release (Resend message id +
   sent_at). Live status (delivered/opened/bounced) lives in email_events
   joined on recall, not here. NULL for pre-V2 rows.';
comment on column public.quote_revisions.terms_snapshot_json is
  'V2: terms (valid_days, expires_at, payment_terms, deposit_pct,
   terms_version, terms_document_ref). terms_version defaults to
   ''legacy_unknown'' until canonical T&C exists. NULL for pre-V2 rows.';
comment on column public.quote_revisions.provenance_snapshot_json is
  'V2: scoping tool/version + pricing engine version + scoper user/name +
   scoped_at. Critical for forensic replay of "what code produced this
   manifest". NULL for pre-V2 rows.';
comment on column public.quote_revisions.option_label is
  'V2: structural support for option A/B/C quotes. Null when not an
   option-quote. End-to-end UI deferred per Cap 0 V2 plan §9.';

-- ── 2. Internal cost snapshot columns (private; separate hash) ─────────────

alter table public.quote_revisions
  add column if not exists internal_cost_snapshot_json   jsonb null,
  add column if not exists internal_cost_canonical_text  text  null,
  add column if not exists internal_cost_hash            text  null;

comment on column public.quote_revisions.internal_cost_snapshot_json is
  'V2: parallel sealed snapshot of internal commercial data (line costs,
   margins, supplier names, commission, override approver). NEVER
   serialized into manifest_canonical_text. SecureOps + JARVIS read via
   service-role; external/client/legal audit never receives it. NULL for
   pre-V2 rows.';
comment on column public.quote_revisions.internal_cost_canonical_text is
  'V2: canonical-JSON form of internal_cost_snapshot_json (recursive deep-
   sort + UTF-8 encoding). sha256(this) === internal_cost_hash by
   construction. Stored inline so verifiability survives a missing storage
   object. NULL for pre-V2 rows.';
comment on column public.quote_revisions.internal_cost_hash is
  'V2: SHA-256 hex of internal_cost_canonical_text. Verifiable
   independently of manifest_hash. NULL for pre-V2 rows.';

-- ── 3. Extended immutability trigger ───────────────────────────────────────
--
-- The existing quote_revisions_controlled_immutable() trigger refuses any
-- UPDATE that would change a non-sent_at column once sent_at IS NOT NULL.
-- It uses IS DISTINCT FROM (not <>) for nullable columns. Extend the
-- comparison list to cover the new V2 columns. Logic is otherwise unchanged
-- and existing rows continue to behave identically.

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
     or NEW.manifest_canonical_text is distinct from OLD.manifest_canonical_text
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
     -- V2 additions:
     or NEW.contacts_snapshot_json is distinct from OLD.contacts_snapshot_json
     or NEW.documents_snapshot_json is distinct from OLD.documents_snapshot_json
     or NEW.media_snapshot_json is distinct from OLD.media_snapshot_json
     or NEW.qa_snapshot_json is distinct from OLD.qa_snapshot_json
     or NEW.send_snapshot_json is distinct from OLD.send_snapshot_json
     or NEW.terms_snapshot_json is distinct from OLD.terms_snapshot_json
     or NEW.provenance_snapshot_json is distinct from OLD.provenance_snapshot_json
     or NEW.option_label is distinct from OLD.option_label
     or NEW.internal_cost_snapshot_json is distinct from OLD.internal_cost_snapshot_json
     or NEW.internal_cost_canonical_text is distinct from OLD.internal_cost_canonical_text
     or NEW.internal_cost_hash is distinct from OLD.internal_cost_hash
  then
    raise exception 'quote_revisions: only sent_at may transition NULL -> NOT NULL on UPDATE; row %', OLD.id
      using errcode = '23514';
  end if;
  return NEW;
end;
$$;

-- Trigger reference is unchanged (function definition replaced in-place).

-- ── 4. Indexes for the new columns we expect to query ──────────────────────

create index if not exists quote_revisions_internal_cost_hash_idx
  on public.quote_revisions (internal_cost_hash) where internal_cost_hash is not null;
create index if not exists quote_revisions_option_label_idx
  on public.quote_revisions (job_id, option_label) where option_label is not null;

-- ── 5. Supersession columns on job_documents ───────────────────────────────

alter table public.job_documents
  add column if not exists superseded_at              timestamptz null,
  add column if not exists superseded_by_revision_id  uuid null
    references public.quote_revisions(id) on delete restrict;

create index if not exists job_documents_superseded_by_revision_idx
  on public.job_documents (superseded_by_revision_id)
  where superseded_by_revision_id is not null;

comment on column public.job_documents.superseded_at is
  'V2: set when a higher-version quote_revision INSERTs for the same job.
   Accept endpoints check this and reject acceptance on superseded share
   tokens with code=quote_superseded. NULL while v1 is the current revision.';
comment on column public.job_documents.superseded_by_revision_id is
  'V2: FK to the quote_revisions row that superseded this document. Used by
   the share-link redirect handler to point the customer at the current
   share URL. NULL while not superseded.';

-- ── 6. (Future P4) lifecycle checkpoint tables ─────────────────────────────
--
-- The following tables are NOT part of this migration. They land in Loop 5
-- (P4) of the V2 plan with their own dedicated migration:
--   - quote_acceptances (per-contact accept/decline sealed packet)
--   - invoice_packets (per Xero invoice send sealed packet)
--   - work_order_packets (per WO send sealed packet)
--   - completion_packets (per job completion sealed packet)
--
-- This migration intentionally stops here so Loop 3 (P2) is small and
-- atomic: just the V2 quote_revisions write path plus the supersession
-- columns. Lifecycle checkpoint primitives ship later.

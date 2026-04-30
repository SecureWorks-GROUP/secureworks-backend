-- 20260430170000_add_quote_revisions_manifest_canonical_text.sql
-- CAP0-QUOTE-REVISION-MINIMAL hot-fix.
--
-- Codex stop-gate flagged that after PR #6 replaced Storage upload with the
-- 'supabase-internal://manifest/<hash>' stub URL, the manifest_hash is no
-- longer externally verifiable — a consumer can't fetch the canonical bytes
-- to recompute the hash. The canonical bytes can in principle be
-- reconstructed from scope_snapshot_json + pricing_snapshot_json +
-- totals_snapshot_json + recipient_email + build_kind + ..., but only if the
-- caller has access to the EXACT helper code (buildMinimalReleaseManifest +
-- canonicalize) at the version that wrote the row. That couples consumers
-- tightly to send-quote source.
--
-- Fix: capture the canonical bytes inline at write time. The new column is:
--   - nullable (existing rows from PR #6 stay NULL — backward compatible)
--   - text (canonical JSON is plain text, not jsonb — preserve byte-exact
--     representation since hashing is byte-sensitive; jsonb canonicalises
--     numbers/whitespace differently from JSON.stringify)
--
-- Verifiability contract for new rows:
--   sha256(manifest_canonical_text) === manifest_hash
-- Consumers can fetch the row, hash the column, compare. No external
-- Storage dependency, no source-code coupling.
--
-- The controlled-immutability trigger already guards manifest_canonical_text
-- — wait, no: the trigger's IS DISTINCT FROM list was written before this
-- column existed. We must add manifest_canonical_text to the list so that
-- once a row is released, this column also cannot be mutated.

alter table public.quote_revisions
  add column if not exists manifest_canonical_text text null;

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
  then
    raise exception 'quote_revisions: only sent_at may transition NULL -> NOT NULL on UPDATE; row %', OLD.id
      using errcode = '23514';
  end if;
  return NEW;
end;
$$;

comment on column public.quote_revisions.manifest_canonical_text is
  'Canonical JSON bytes (output of canonicalize() + JSON.stringify) hashed to
   produce manifest_hash. NULL on rows written before this column existed
   (pre-2026-04-30 17:00 UTC). On non-NULL rows, sha256(manifest_canonical_text)
   = manifest_hash; consumers can verify integrity without fetching from
   Storage. Once the controlled-immutability trigger fires (row is released),
   this column cannot be mutated.';

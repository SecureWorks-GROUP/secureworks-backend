-- 20260501140000_create_release_manifests_bucket.sql
-- CAP0-QUOTE-REVISION-MANIFEST-STORAGE: dedicated PRIVATE Storage bucket for
-- release packet manifests.
--
-- Why a new bucket (not job-pdfs):
--   The job-pdfs bucket has an RLS policy
--     (storage.foldername(name))[1] = auth_org_id()::text
--   which the service-role inside Edge Functions does not satisfy (no
--   auth_org_id() context). Both direct .upload() and signed-URL PUT failed in
--   production despite the URL minting succeeding (see send-quote/index.ts
--   recordReleasedQuoteRevision docstring). A dedicated bucket with NO RLS
--   policies leaves only the implicit service-role bypass — that's exactly
--   what we want for server-side manifest writes from Edge Functions.
--
-- Privacy posture: PRIVATE.
--   The manifest contains client_name, recipient_email, site_address, pricing
--   snapshots — all PII or commercial-sensitive. Public read MUST NOT be
--   enabled. Service role is the only writer; service role and (future)
--   release-packet read API are the only readers. Direct GETs from anon /
--   authenticated roles return 401 because there are no SELECT policies for
--   those roles on this bucket.
--
-- manifest_url shape after this migration:
--   https://<project>.supabase.co/storage/v1/object/release-manifests/<hash>.json
--   That URL returns 401 to anyone without service-role auth. Future read APIs
--   can mint signed URLs from it for time-limited public access.
--
-- Failure-mode policy (in helper, not migration):
--   If .upload() fails (network, transient outage, etc), the helper falls back
--   to writing manifest_url = 'supabase-internal://manifest/<hash>' and logs
--   [quote-revision-upload-fail]. The row is still INSERTed because
--   manifest_canonical_text is the inline verification source.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'release-manifests',
  'release-manifests',
  false,                              -- PRIVATE — service-role only
  1048576,                            -- 1 MB hard cap; manifests are typically <10KB
  array['application/json']           -- only JSON allowed
)
on conflict (id) do nothing;

-- No RLS policies on storage.objects for this bucket. With RLS enabled
-- (the storage default) and no policies, the anon and authenticated roles get
-- default-deny on read/write. Service role bypasses RLS, so Edge Functions can
-- read/write freely. This matches the privacy posture.

comment on table storage.buckets is
  'Supabase Storage buckets. release-manifests (added 20260501140000): private,
   service-role-only, holds Cap 0 release packet canonical-JSON manifests keyed
   by sha256 hash. Companion: quote_revisions.manifest_url + .manifest_hash.';

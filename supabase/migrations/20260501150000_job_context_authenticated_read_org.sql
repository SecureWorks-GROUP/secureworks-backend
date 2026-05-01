-- T5 Iteration 2 — Path A read contract for job_context (NOT YET APPLIED)
--
-- Status: file landed in main, NOT applied to production. Apply only after
-- explicit user approval naming this migration ("apply
-- 20260501150000_job_context_authenticated_read_org.sql").
--
-- Why: T4 Secure Sale Slice 4B Path A wants direct PostgREST authenticated
-- SELECT for `job_context`. Live RLS audit (2026-05-01) shows job_context has
-- RLS enabled with NO permissive SELECT policies — deny-by-default for
-- `authenticated` (and `anon`). Direct PostgREST reads silently return [].
--
-- The Job Dossier assembler (`ops-api?action=assemble_job_dossier`) bypasses
-- this via service-role; this policy is what the cockpit's `_loadIndexReal`
-- needs for direct table reads under the signed-in user's session.
--
-- Properties:
--   - read-only (FOR SELECT only — INSERT/UPDATE/DELETE remain deny-by-default
--     for `authenticated`)
--   - authenticated only — `anon` still blocked
--   - org-scoped via join through jobs.org_id = auth_org_id() (the helper
--     function used by the existing jobs SELECT policy "Users can view org
--     jobs"; no new functions added)
--   - service-role bypass unaffected (BYPASSRLS attribute)
--   - instant rollback: DROP POLICY "authenticated_read_org_job_context" ON
--     public.job_context;
--
-- Cross-references:
--   - cio/evidence/context-loop-v1/jarvis-job-dossier-v1-2026-05-01/README.md
--   - cio/evidence/secure-sale-cockpit-2026-04-30/slice-4b-path-a-acceptance.md
--   - existing pattern: 20260424120000_fix_business_events_job_id_type.sql
--     and the `Users can view org jobs` policy on `jobs`.

CREATE POLICY "authenticated_read_org_job_context"
  ON public.job_context
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE j.id = job_context.job_id
        AND j.org_id = auth_org_id()
    )
  );

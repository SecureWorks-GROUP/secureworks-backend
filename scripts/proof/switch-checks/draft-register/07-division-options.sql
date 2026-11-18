-- Draft register, check 7, for the ZZTEST job's organisation: every division
-- the drafts tag (the stock list in xero_draft_standard.ts) is an ACTIVE
-- option in the daily copy of Xero's options, and that copy was refreshed in
-- the last 36 hours. A missing option reads as a problem on every draft of
-- that division. 'Private Renovations' and 'SecureBuild' are reported, not
-- required: a job of those kinds is tagged only when Xero has the option.
\set zz_check 'draft_register.division_options'
\ir ../session.sql
WITH want(name) AS (VALUES ('SW - PATIOS'), ('SW - FENCING'), ('SW - DECKING'), ('SW - PRIVATE ROOFING'),
                           ('SW - MAKESAFE'), ('SW - INSURANCE WORK'), ('SW - RESTORATION'), ('SW Group')),
active AS (
  SELECT option_name FROM public.xero_tracking_options WHERE org_id = :'zz_org_id' AND status = 'ACTIVE'
), fresh AS (
  SELECT max(synced_at) AS newest FROM public.xero_tracking_options WHERE org_id = :'zz_org_id'
)
SELECT :'zz_check' AS "check",
       CASE WHEN NOT EXISTS (SELECT 1 FROM want w WHERE w.name NOT IN (SELECT option_name FROM active))
             AND (SELECT newest FROM fresh) > now() - interval '36 hours' THEN 'PASS' ELSE 'FAIL' END AS result,
       jsonb_build_object('missing', (SELECT coalesce(jsonb_agg(w.name ORDER BY w.name), '[]') FROM want w
                                      WHERE w.name NOT IN (SELECT option_name FROM active)),
                          'active_options', (SELECT count(*) FROM active),
                          'newest_sync', (SELECT newest FROM fresh),
                          'private_renovations_active', EXISTS (SELECT 1 FROM active WHERE option_name = 'Private Renovations'),
                          'securebuild_active', EXISTS (SELECT 1 FROM active WHERE option_name = 'SecureBuild'))::text AS evidence;

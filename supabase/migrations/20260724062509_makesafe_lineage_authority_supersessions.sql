-- Second-round, append-only correction overlay for the 2026-07-24 make-safe
-- deterministic-intake quarantine. The first correction ledger is immutable:
-- this migration records a reviewed supersession of an exact correction row.
--
-- Production footprint:
--   * 15 persisted authorities split across 33 correction-only authorities
--   * 58 source corrections superseded onto those authorities
--   * 2 stale identity expectations cleared without changing their authority
--
-- The migration is deliberately production-data-specific. It installs the
-- schema only on a fresh database and otherwise aborts the transaction unless
-- every source, content hash, first-round correction and prior case still
-- matches the reviewed snapshot. It never updates or deletes operational data.

CREATE TABLE public.makesafe_intake_source_authority_correction_supersessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL
    REFERENCES public.organisations(id) ON DELETE RESTRICT,
  source_post_id text NOT NULL
    REFERENCES public.emails(post_id) ON DELETE RESTRICT,
  superseded_correction_id uuid NOT NULL
    REFERENCES public.makesafe_intake_source_authority_corrections(id)
    ON DELETE RESTRICT,
  prior_authority_case_id uuid NOT NULL,
  effective_case_id uuid NOT NULL,
  correction_kind text NOT NULL CHECK (
    correction_kind IN (
      'persisted_authority_split',
      'identity_expectation_repair'
    )
  ),
  expected_identity_key text CHECK (
    expected_identity_key IS NULL
    OR btrim(expected_identity_key) <> ''
  ),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(evidence) = 'object'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT makesafe_source_authority_supersessions_source_key
    UNIQUE (org_id, source_post_id),
  CONSTRAINT makesafe_source_authority_supersessions_prior_fk
    FOREIGN KEY (org_id, prior_authority_case_id)
    REFERENCES public.makesafe_intake_cases(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT makesafe_source_authority_supersessions_effective_fk
    FOREIGN KEY (org_id, effective_case_id)
    REFERENCES public.makesafe_intake_cases(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT makesafe_source_authority_supersessions_shape CHECK (
    (
      correction_kind = 'persisted_authority_split'
      AND prior_authority_case_id <> effective_case_id
      AND expected_identity_key IS NOT NULL
    )
    OR (
      correction_kind = 'identity_expectation_repair'
      AND prior_authority_case_id = effective_case_id
      AND expected_identity_key IS NULL
    )
  )
);

CREATE INDEX idx_makesafe_source_authority_supersessions_effective
  ON public.makesafe_intake_source_authority_correction_supersessions (
    org_id, effective_case_id
  );
CREATE INDEX idx_makesafe_source_authority_supersessions_source
  ON public.makesafe_intake_source_authority_correction_supersessions (
    source_post_id
  );
CREATE INDEX idx_makesafe_source_authority_supersessions_correction
  ON public.makesafe_intake_source_authority_correction_supersessions (
    superseded_correction_id
  );
CREATE INDEX idx_makesafe_source_authority_supersessions_prior
  ON public.makesafe_intake_source_authority_correction_supersessions (
    org_id, prior_authority_case_id
  );

ALTER TABLE
  public.makesafe_intake_source_authority_correction_supersessions
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON
  public.makesafe_intake_source_authority_correction_supersessions
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON
  public.makesafe_intake_source_authority_correction_supersessions
  TO service_role;

CREATE POLICY service_role_read_makesafe_source_authority_supersessions
  ON public.makesafe_intake_source_authority_correction_supersessions
  FOR SELECT TO service_role USING (true);

CREATE TRIGGER trg_makesafe_source_authority_supersessions_append_only
  BEFORE UPDATE OR DELETE
  ON public.makesafe_intake_source_authority_correction_supersessions
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_makesafe_intake_append_only_mutation();

COMMENT ON TABLE
  public.makesafe_intake_source_authority_correction_supersessions IS
  'Append-only overlay that supersedes one exact first-round source authority correction after a guarded reconciliation. Runtime rejects stale correction ids or prior authorities.';

CREATE TEMP TABLE _ms_v2_manifest ON COMMIT DROP AS
WITH raw(item, partition_no) AS (
  SELECT item, partition_no::integer
  FROM jsonb_array_elements($manifest$
[
["7f7da0ac-3019-40aa-8faa-9517ee3e10d3","fingerprint:116ed65d72951847/deliverable:MLB-25828%3AGENERAL_MAKESAFE/cycle:1","accounted_non_wo","non_makesafe",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAeIwaaAAA="]],
["7f7da0ac-3019-40aa-8faa-9517ee3e10d3","fingerprint:116ed65d72951847/deliverable:MLB-25828%3AGENERAL_MAKESAFE/cycle:1","accounted_non_wo","non_makesafe",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAeIwaZAAA="]],
["7f7da0ac-3019-40aa-8faa-9517ee3e10d3","fingerprint:0e837c0a72951847/deliverable:MLB-25828%3AGENERAL_MAKESAFE/cycle:1","accounted_non_wo","non_makesafe",["mailbox_868d56017386eb7f4307346ab0a6cb2721e195f1843f627ece537500fd6fe3eb"]],
["bce1c9b6-afa2-4bb9-9c8c-530d9c48712b","fingerprint:2f9c1c4ef4fcb597/deliverable:wo%3AMLB-26705%2Fpo%3APO-55608/cycle:1","exception","adapter_parse_failure",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAeIwajAAA=","mailbox_cc32e83a5d4b4cb9e1432c90ab60f22669281faf1b1b9e21e9cd1af3d1ae1b1e"]],
["bce1c9b6-afa2-4bb9-9c8c-530d9c48712b","fingerprint:8e39a193f4fcb597/deliverable:wo%3AMLB-26705%2Fpo%3APO-55609/cycle:1","exception","adapter_parse_failure",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAeIwakAAA=","mailbox_71b5e52912806939ba524d73a4789ff47e33a0e8aeb831ef4ac810477e9bfded"]],
["3d8d785f-102c-4114-a050-a4c68f63f2c6","fingerprint:8daed7d3a91415b7/deliverable:MLB-26443%3AGENERAL_MAKESAFE-REOPEN/cycle:2","exception","below_identity_floor",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAhyHaSAAA="]],
["3d8d785f-102c-4114-a050-a4c68f63f2c6","fingerprint:8daed7d3a91415b7/deliverable:MLB-26443%3AGENERAL_MAKESAFE-REOPEN/cycle:3","exception","below_identity_floor",["mailbox_a2cf6e0b1fccbd314a218de377a122552bfa07887a9cc38a7fd96450baa8876b"]],
["beaee2e4-f437-4210-acd2-7f52c948a641","fingerprint:94f77f90a91415b7/deliverable:MLB-25971%3AGENERAL_MAKESAFE-REOPEN/cycle:2","exception","below_identity_floor",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAlxv4rAAA="]],
["beaee2e4-f437-4210-acd2-7f52c948a641","fingerprint:94f77f90a91415b7/deliverable:MLB-25971%3AGENERAL_MAKESAFE-REOPEN/cycle:3","exception","below_identity_floor",["mailbox_5cbe4fbc3051632090198e143c2bf080e36a3cdaf88d74bfbb91980fadd9396e"]],
["ae0af7db-0ba4-4701-907a-6220c0be51e4","fingerprint:2153288d3bbf1067/deliverable:MLB-26380%3AGENERAL_MAKESAFE/cycle:1","exception","below_identity_floor",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAjTu94AAA=","AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAApJdqQAAA=","mailbox_5d04aa6082dd0d5ef37dfae3a801eaa653fd0e77a3c1920f893828d0b1f107f9","mailbox_e5a95a263ec512ea211ab1cf69b26eca5532c335c6cb90a72ed480d84268e96b"]],
["ae0af7db-0ba4-4701-907a-6220c0be51e4","fingerprint:467719e072951847/deliverable:MLB-26380%3AGENERAL_MAKESAFE/cycle:1","accounted_non_wo","non_makesafe",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAlSHoGAAA="]],
["ae0af7db-0ba4-4701-907a-6220c0be51e4","fingerprint:467719e072951847/deliverable:MLB-26380%3AGENERAL_MAKESAFE/cycle:1","accounted_non_wo","non_makesafe",["mailbox_8487c90175c4971439c71bf5d6fc813bb18d5ef2982df99c5142ac8fc8f09053"]],
["465672e9-3ac4-4ac7-8050-f90d6cbbeee1","fingerprint:aef46a7ff4fcb597/deliverable:wo%3AMLB-26567%2Fpo%3APO-56164/cycle:1","exception","adapter_parse_failure",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAlSHoIAAA=","mailbox_394b3c2d50c03ed06365e7b768edf9689859de39ace39f41522fd087ea61af87"]],
["465672e9-3ac4-4ac7-8050-f90d6cbbeee1","fingerprint:2a2edd51f4fcb597/deliverable:wo%3AMLB-26567%2Fpo%3APO-56773/cycle:1","exception","adapter_parse_failure",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAApwRreAAA=","mailbox_bfec4dafae25a7ffb1b2592c5afb12918ef34a9e12bdd2c2a8a0d245750c83ed"]],
["0fa3fe46-95cf-4c6a-b696-73a54ce75549","fingerprint:520dd8d750237627/deliverable:MLB-26344%3AASSESSMENT_REPORT_QUOTE/cycle:1","exception","below_identity_floor",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAlxv4uAAA=","AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAApJdqNAAA=","mailbox_5cde113d435eaaad0bdc1f94bf89f45f954c09c57a8aaba1e40957ae9791ce57","mailbox_daf7ee447b81d15ce7925c455d376c86c5c3025414bbede2eebf91f0a8dd0bc3"]],
["0fa3fe46-95cf-4c6a-b696-73a54ce75549","fingerprint:2ab734e4687b519d/deliverable:MLB-26344%3AASSESSMENT_REPORT_QUOTE/cycle:1","accounted_non_wo","non_makesafe",["mailbox_f996b3267ea91381744a94aa4d107a89a7f42f2cc58dc6d10f24a85762f1a1cd"]],
["1a133593-91c9-4f18-bd4e-34bc6a389de6","fingerprint:34f66ba0f4fcb597/deliverable:wo%3AMLB-26267%2Fpo%3APO-56336/cycle:1","exception","adapter_parse_failure",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAmgcmtAAA=","mailbox_734a7b7695d528bdfbdc442e28d55aa4bb11f9eebff38fc28af39e58467c4334"]],
["1a133593-91c9-4f18-bd4e-34bc6a389de6","fingerprint:43fd2140f4fcb597/deliverable:wo%3AMLB-26267%2Fpo%3APO-56642/cycle:1","exception","adapter_parse_failure",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAApJdqPAAA=","mailbox_1484a3e5456e8a29289ba690fa99f0bb105bbbec436103386fe8de26170b3ba8"]],
["ec46b556-5fb2-434c-a404-33b3dc57461a","fingerprint:a764b720f4fcb597/deliverable:wo%3AMLB-27037%2Fpo%3APO-56395/cycle:1","exception","adapter_parse_failure",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAmgcm3AAA=","mailbox_d6f0670e3f7b3cd0323abccf5075ad84c08de4c0894edbf6fd2daf4a92d7adbd"]],
["ec46b556-5fb2-434c-a404-33b3dc57461a","fingerprint:fdc2d702f4fcb597/deliverable:wo%3AMLB-27037%2Fpo%3APO-56397/cycle:1","exception","adapter_parse_failure",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAmgcm4AAA=","mailbox_04c3dcc3d0d5c20637e9ddbd91095ea1089d55901a9533084174bab6079c5c20"]],
["ec46b556-5fb2-434c-a404-33b3dc57461a","fingerprint:b42af6ebf4fcb597/deliverable:wo%3AMLB-27037%2Fpo%3APO-56459/cycle:1","exception","adapter_parse_failure",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAmgcnIAAA=","mailbox_4ebea2b666e43b2aa1336cb81a63b33827f0f2c6f32586c6c7396793d197bb9f"]],
["f6341575-0242-455e-aca1-a4d6e9e19de6","fingerprint:57eea0aef4fcb597/deliverable:wo%3AMLB-27093%2Fpo%3APO-56479/cycle:1","exception","adapter_parse_failure",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAmgcnHAAA=","mailbox_2b787b7b9e37f401ded2056ea21e21595ceb656f1887dd8549744d9c2cc4e1e3"]],
["f6341575-0242-455e-aca1-a4d6e9e19de6","fingerprint:01649112f4fcb597/deliverable:wo%3AMLB-27093%2Fpo%3APO-56481/cycle:1","exception","adapter_parse_failure",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAmgcnJAAA=","mailbox_8fee5d6b64d777632938969b937f7f17bb8608840baf55727934019c616a49f9"]],
["c89bee8c-4e5a-452f-8a63-ba82d759d4dd","fingerprint:06f6f8e1a91415b7/deliverable:MLB-26012%3AGENERAL_MAKESAFE-REOPEN/cycle:2","exception","below_identity_floor",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAmgcnMAAA="]],
["c89bee8c-4e5a-452f-8a63-ba82d759d4dd","fingerprint:06f6f8e1a91415b7/deliverable:MLB-26012%3AGENERAL_MAKESAFE-REOPEN/cycle:3","exception","below_identity_floor",["mailbox_4c83959453490f50a0d0c9083dd3fb450b275cc1daa8ee38ee946dcd8d59dab1"]],
["49b91229-45ea-4038-8f3a-86d993f1e1da","fingerprint:a8df7f44f4fcb597/deliverable:wo%3AMLB-24574%2Fpo%3APO-56082/cycle:1","exception","adapter_parse_failure",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAApJdqOAAA=","mailbox_22471a9562cc3ffad29999f3ae80dfccced887d88de6e0169bfe782f270e3358"]],
["49b91229-45ea-4038-8f3a-86d993f1e1da","fingerprint:75a54d5b4bdd552f/deliverable:wo%3AMLB-24574/cycle:1","exception","adapter_parse_failure",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAApwRrVAAA=","mailbox_c901e3bdf6740493f4b972150901a1f74d0b27d9cd88094d9e0ac58044515e20"]],
["0d2c69eb-ec94-47d5-a0a1-d9291ef57e19","fingerprint:269c0570f4fcb597/deliverable:wo%3AMLB-24749%2Fpo%3APO-56699/cycle:1","exception","adapter_parse_failure",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAApwRrRAAA=","mailbox_0017cd7bf3f368472d240528bc22819834739cbabdc6e4bcd7bd95b173c1aa33"]],
["0d2c69eb-ec94-47d5-a0a1-d9291ef57e19","fingerprint:9cbc927917217a27/deliverable:wo%3AMLB-24749/cycle:1","exception","cancellation",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAqod-2AAA=","mailbox_cf8219b8db676e98c5ef129f5292e6e1a034ff7f25b213a7e31bb598d0dd2dcc"]],
["8802d97b-4f69-418e-a2ee-f754433b455d","fingerprint:193012dbf4fcb597/deliverable:wo%3AMLB-25400%2Fpo%3APO-56787/cycle:1","exception","adapter_parse_failure",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAApwRrfAAA=","mailbox_8b7f3f8e95064ad0bb96d3fdbb850a403cca03feb29e69efa7d1ac30514fed4b"]],
["8802d97b-4f69-418e-a2ee-f754433b455d","fingerprint:d318d6b4f4fcb597/deliverable:wo%3AMLB-25400%2Fpo%3APO-56788/cycle:1","exception","adapter_parse_failure",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAApwRrgAAA=","mailbox_f3ecca387e08b1397217d59102fee97ecf2dae572c2c1b41442b4d674854570a"]],
["a95e63a5-1c89-4f18-9465-85acfabcba3f","fingerprint:ab4aefa9f4fcb597/deliverable:wo%3AMLB-26537%2Fpo%3APO-56866/cycle:1","exception","adapter_parse_failure",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAqod-_AAA=","mailbox_7d340916a463fe044f58f070fdb265a0b0c24755fdf2d0c58bfdb591bf88fc8a"]],
["a95e63a5-1c89-4f18-9465-85acfabcba3f","fingerprint:0dd0f5b9f4fcb597/deliverable:wo%3AMLB-26537%2Fpo%3APO-56926/cycle:1","exception","adapter_parse_failure",["AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAqoeAFAAA=","mailbox_5143e866b74548d89c7404bae59229f3472e17e2f3e1e07de0ffac190c9e9565"]]
]
$manifest$::jsonb) WITH ORDINALITY AS expanded(item, partition_no)
),
decoded AS (
  SELECT
    partition_no,
    (item ->> 0)::uuid AS prior_authority_case_id,
    item ->> 1 AS planned_instruction_key,
    item ->> 2 AS state,
    item ->> 3 AS reason_code,
    item -> 4 AS source_post_ids,
    substring(item ->> 1 FROM '/deliverable:([^/]+)/cycle:')
      AS deliverable_segment
  FROM raw
),
identified AS (
  SELECT
    decoded.*,
    CASE
      WHEN deliverable_segment LIKE 'wo%3A%'
        THEN 'wo:' || substring(
          deliverable_segment FROM '^wo%3A([^%/]+)'
        )
      ELSE 'ref:' || substring(
        deliverable_segment FROM '^([^%/]+)%3A'
      )
    END AS expected_identity_key,
    CASE
      WHEN deliverable_segment LIKE 'wo%3A%'
        THEN substring(deliverable_segment FROM '^wo%3A([^%/]+)')
      ELSE substring(deliverable_segment FROM '^([^%/]+)%3A')
    END AS external_ref_canonical,
    CASE
      WHEN deliverable_segment LIKE 'wo%3A%'
        THEN substring(deliverable_segment FROM '^wo%3A([^%/]+)')
      ELSE NULL
    END AS builder_wo_canonical,
    substring(deliverable_segment FROM '%2Fpo%3A([^%/]+)')
      AS builder_po_canonical,
    CASE
      WHEN deliverable_segment LIKE 'wo%3A%'
        THEN 'GENERAL_MAKESAFE'
      ELSE substring(deliverable_segment FROM '^[^%/]+%3A(.+)$')
    END AS deliverable_ref_canonical
  FROM decoded
),
fingerprinted AS (
  SELECT
    identified.*,
    encode(
      extensions.digest(
        (
          SELECT string_agg(source_id, ',' ORDER BY source_id)
          FROM jsonb_array_elements_text(source_post_ids) source(source_id)
        ),
        'sha256'
      ),
      'hex'
    ) AS source_manifest_sha256
  FROM identified
)
SELECT
  fingerprinted.*,
  'fingerprint:' || source_manifest_sha256
    || '/deliverable:' || deliverable_segment || '/cycle:1'
    AS target_instruction_key,
  gen_random_uuid() AS effective_case_id
FROM fingerprinted;

DO $$
DECLARE
  v_org_id constant uuid :=
    '00000000-0000-0000-0000-000000000001'::uuid;
  v_base_corrections integer;
  v_case_count bigint;
  v_case_event_count bigint;
  v_case_source_count bigint;
  v_job_count bigint;
  v_assignment_count bigint;
  v_draft_count bigint;
  v_document_count bigint;
  v_notify_count bigint;
  v_outbound_count bigint;
  v_footprint_sha256 text;
  v_authority_sha256 text;
BEGIN
  SELECT count(*) INTO v_base_corrections
  FROM public.makesafe_intake_source_authority_corrections
  WHERE org_id = v_org_id;

  -- Fresh migration-provisioned environments intentionally install only the
  -- overlay schema. Any partially-present production footprint fails closed.
  IF v_base_corrections = 0 THEN
    RETURN;
  END IF;

  IF (SELECT count(*) FROM _ms_v2_manifest) <> 33
    OR (
      SELECT count(*)
      FROM _ms_v2_manifest manifest
      CROSS JOIN LATERAL jsonb_array_elements_text(
        manifest.source_post_ids
      ) source(post_id)
    ) <> 58
    OR (
      SELECT count(DISTINCT prior_authority_case_id)
      FROM _ms_v2_manifest
    ) <> 15
    OR EXISTS (
      SELECT 1
      FROM _ms_v2_manifest
      WHERE expected_identity_key IS NULL
        OR external_ref_canonical IS NULL
        OR deliverable_ref_canonical IS NULL
        OR source_manifest_sha256 !~ '^[0-9a-f]{64}$'
    )
    OR EXISTS (
      SELECT 1
      FROM _ms_v2_manifest manifest
      CROSS JOIN LATERAL jsonb_array_elements_text(
        manifest.source_post_ids
      ) source(post_id)
      GROUP BY source.post_id
      HAVING count(*) <> 1
    )
  THEN
    RAISE EXCEPTION
      'lineage v2 reconciliation refused: embedded manifest shape changed';
  END IF;

  CREATE TEMP TABLE _ms_v2_sources ON COMMIT DROP AS
  SELECT
    manifest.partition_no,
    manifest.prior_authority_case_id,
    manifest.target_instruction_key,
    manifest.effective_case_id,
    manifest.expected_identity_key,
    source.post_id,
    email.content_sha256,
    immutable.case_id AS immutable_case_id,
    correction.id AS superseded_correction_id,
    correction.legacy_case_id,
    correction.effective_case_id AS current_effective_case_id,
    correction.expected_identity_key AS current_expected_identity_key
  FROM _ms_v2_manifest manifest
  CROSS JOIN LATERAL jsonb_array_elements_text(
    manifest.source_post_ids
  ) source(post_id)
  LEFT JOIN public.emails email
    ON email.post_id = source.post_id
  LEFT JOIN public.makesafe_intake_case_sources immutable
    ON immutable.org_id = v_org_id
   AND immutable.post_id = source.post_id
  LEFT JOIN public.makesafe_intake_source_authority_corrections correction
    ON correction.org_id = v_org_id
   AND correction.source_post_id = source.post_id;

  IF (SELECT count(*) FROM _ms_v2_sources) <> 58
    OR EXISTS (
      SELECT 1
      FROM _ms_v2_sources
      WHERE content_sha256 IS NULL
        OR superseded_correction_id IS NULL
        OR current_effective_case_id IS DISTINCT FROM
          prior_authority_case_id
    )
    OR EXISTS (
      SELECT 1
      FROM _ms_v2_sources
      GROUP BY prior_authority_case_id
      HAVING count(DISTINCT target_instruction_key) <= 1
    )
  THEN
    RAISE EXCEPTION
      'lineage v2 reconciliation refused: split authority footprint changed';
  END IF;

  CREATE TEMP TABLE _ms_v2_repairs ON COMMIT DROP AS
  SELECT
    source.post_id,
    email.content_sha256,
    immutable.case_id AS immutable_case_id,
    correction.id AS superseded_correction_id,
    correction.legacy_case_id,
    correction.effective_case_id AS prior_authority_case_id,
    correction.expected_identity_key AS current_expected_identity_key
  FROM unnest(ARRAY[
    'AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAeIwaoAAA=',
    'mailbox_bd5cb4080106328b30db51e24c6cb248795bff13a20dd95f4d882395b994a644'
  ]::text[]) source(post_id)
  LEFT JOIN public.emails email
    ON email.post_id = source.post_id
  LEFT JOIN public.makesafe_intake_case_sources immutable
    ON immutable.org_id = v_org_id
   AND immutable.post_id = source.post_id
  LEFT JOIN public.makesafe_intake_source_authority_corrections correction
    ON correction.org_id = v_org_id
   AND correction.source_post_id = source.post_id;

  IF (SELECT count(*) FROM _ms_v2_repairs) <> 2
    OR EXISTS (
      SELECT 1
      FROM _ms_v2_repairs
      WHERE content_sha256 IS NULL
        OR superseded_correction_id IS NULL
        OR prior_authority_case_id IS DISTINCT FROM
          'ccff4677-1883-48b8-bf4c-cbc2f642487c'::uuid
        OR current_expected_identity_key <> 'wo:MLB-MW-26873'
    )
  THEN
    RAISE EXCEPTION
      'lineage v2 reconciliation refused: correction identity footprint changed';
  END IF;

  WITH footprint AS (
    SELECT
      partition_no,
      post_id,
      content_sha256,
      immutable_case_id,
      superseded_correction_id,
      legacy_case_id,
      prior_authority_case_id,
      current_expected_identity_key,
      'persisted_authority_split'::text AS correction_kind,
      target_instruction_key AS target_effective_case,
      expected_identity_key
    FROM _ms_v2_sources
    UNION ALL
    SELECT
      0,
      post_id,
      content_sha256,
      immutable_case_id,
      superseded_correction_id,
      legacy_case_id,
      prior_authority_case_id,
      current_expected_identity_key,
      'identity_expectation_repair',
      prior_authority_case_id::text,
      NULL
    FROM _ms_v2_repairs
  )
  SELECT encode(
    extensions.digest(
      string_agg(
        concat_ws(
          '|',
          partition_no::text,
          post_id,
          coalesce(content_sha256, ''),
          coalesce(immutable_case_id::text, ''),
          coalesce(superseded_correction_id::text, ''),
          coalesce(legacy_case_id::text, ''),
          coalesce(prior_authority_case_id::text, ''),
          coalesce(current_expected_identity_key, ''),
          correction_kind,
          target_effective_case,
          coalesce(expected_identity_key, '')
        ),
        ',' ORDER BY post_id
      ),
      'sha256'
    ),
    'hex'
  )
  INTO v_footprint_sha256
  FROM footprint;

  IF v_footprint_sha256 <>
    '47ac7f941cb5ed5800a9c9877fe73561ace8383961a0b09224ebfe38a1e40525'
  THEN
    RAISE EXCEPTION
      'lineage v2 reconciliation refused: source/correction hash changed';
  END IF;

  SELECT encode(
    extensions.digest(
      string_agg(
        concat_ws(
          '|',
          intake_case.id::text,
          intake_case.instruction_key,
          intake_case.lineage_id::text,
          coalesce(intake_case.parent_case_id::text, ''),
          coalesce(intake_case.parent_relation, ''),
          intake_case.cycle::text,
          coalesce(intake_case.company_id::text, ''),
          coalesce(intake_case.external_ref_canonical, ''),
          coalesce(intake_case.builder_wo_canonical, ''),
          coalesce(intake_case.builder_po_canonical, ''),
          coalesce(intake_case.deliverable_ref_canonical, ''),
          intake_case.state,
          coalesce(intake_case.reason_code, ''),
          coalesce(intake_case.job_id::text, ''),
          coalesce(intake_case.source_fingerprint, '')
        ),
        ',' ORDER BY intake_case.id
      ),
      'sha256'
    ),
    'hex'
  ), count(*)
  INTO v_authority_sha256, v_case_count
  FROM public.makesafe_intake_cases intake_case
  WHERE intake_case.org_id = v_org_id
    AND intake_case.id IN (
      '0d2c69eb-ec94-47d5-a0a1-d9291ef57e19'::uuid,
      '0fa3fe46-95cf-4c6a-b696-73a54ce75549'::uuid,
      '1a133593-91c9-4f18-bd4e-34bc6a389de6'::uuid,
      '3d8d785f-102c-4114-a050-a4c68f63f2c6'::uuid,
      '465672e9-3ac4-4ac7-8050-f90d6cbbeee1'::uuid,
      '49b91229-45ea-4038-8f3a-86d993f1e1da'::uuid,
      '7f7da0ac-3019-40aa-8faa-9517ee3e10d3'::uuid,
      '8802d97b-4f69-418e-a2ee-f754433b455d'::uuid,
      'a95e63a5-1c89-4f18-9465-85acfabcba3f'::uuid,
      'ae0af7db-0ba4-4701-907a-6220c0be51e4'::uuid,
      'bce1c9b6-afa2-4bb9-9c8c-530d9c48712b'::uuid,
      'beaee2e4-f437-4210-acd2-7f52c948a641'::uuid,
      'c89bee8c-4e5a-452f-8a63-ba82d759d4dd'::uuid,
      'ccff4677-1883-48b8-bf4c-cbc2f642487c'::uuid,
      'ec46b556-5fb2-434c-a404-33b3dc57461a'::uuid,
      'f6341575-0242-455e-aca1-a4d6e9e19de6'::uuid
    );

  IF v_case_count <> 16
    OR v_authority_sha256 <>
      '1080dba092f7f1ea82d22111404680b634348544c09cf02674d8f0acbeb6f913'
  THEN
    RAISE EXCEPTION
      'lineage v2 reconciliation refused: prior authority manifest changed';
  END IF;

  IF v_base_corrections <> 602
    OR (
      SELECT count(*)
      FROM public.makesafe_intake_case_authority_corrections
      WHERE org_id = v_org_id
    ) <> 369
    OR (
      SELECT count(*)
      FROM public.makesafe_intake_source_authority_corrections
      WHERE org_id = v_org_id
        AND correction_kind = 'existing_job_binding'
        AND target_job_id =
          '985708c4-ffae-48e4-aab7-9c8ead7dac0e'::uuid
    ) <> 2
  THEN
    RAISE EXCEPTION
      'lineage v2 reconciliation refused: first-round ledger changed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.makesafe_intake_source_authority_correction_supersessions
    WHERE org_id = v_org_id
  ) OR EXISTS (
    SELECT 1
    FROM public.makesafe_intake_cases intake_case
    JOIN _ms_v2_manifest manifest
      ON manifest.target_instruction_key = intake_case.instruction_key
    WHERE intake_case.org_id = v_org_id
  ) THEN
    RAISE EXCEPTION
      'lineage v2 reconciliation refused: target rows already exist';
  END IF;

  SELECT count(*) INTO v_case_count FROM public.makesafe_intake_cases;
  SELECT count(*) INTO v_case_event_count
    FROM public.makesafe_intake_case_events;
  SELECT count(*) INTO v_case_source_count
    FROM public.makesafe_intake_case_sources;
  SELECT count(*) INTO v_job_count FROM public.jobs;
  SELECT count(*) INTO v_assignment_count FROM public.job_assignments;
  SELECT count(*) INTO v_draft_count FROM public.makesafe_intake_drafts;
  SELECT count(*) INTO v_document_count FROM public.job_documents;
  SELECT count(*) INTO v_notify_count FROM public.makesafe_notify_log;
  SELECT count(*) INTO v_outbound_count FROM public.outbound_message_queue;

  INSERT INTO public.makesafe_intake_cases (
    id,
    org_id,
    instruction_key,
    lineage_id,
    cycle,
    company_id,
    company_slug_raw,
    company_key,
    external_ref_raw,
    external_ref_canonical,
    builder_wo_raw,
    builder_wo_canonical,
    builder_po_raw,
    builder_po_canonical,
    deliverable_ref_raw,
    deliverable_ref_canonical,
    wo_po_identity_key,
    normaliser_version,
    raw_identity_json,
    field_provenance,
    state,
    reason_code,
    is_authoritative,
    side_effects_suppressed,
    last_decision_provenance,
    last_decision_actor,
    last_decision_reason,
    received_at,
    source_fingerprint
  )
  SELECT
    manifest.effective_case_id,
    v_org_id,
    manifest.target_instruction_key,
    manifest.effective_case_id,
    1,
    '12c26cdb-d1a5-404f-973f-c3dbaff37285'::uuid,
    'mlb',
    'company:12c26cdb-d1a5-404f-973f-c3dbaff37285',
    manifest.external_ref_canonical,
    manifest.external_ref_canonical,
    manifest.builder_wo_canonical,
    manifest.builder_wo_canonical,
    manifest.builder_po_canonical,
    manifest.builder_po_canonical,
    manifest.deliverable_ref_canonical,
    manifest.deliverable_ref_canonical,
    CASE
      WHEN manifest.builder_wo_canonical IS NULL THEN NULL
      WHEN manifest.builder_po_canonical IS NULL
        THEN 'wo:' || manifest.builder_wo_canonical
      ELSE 'wo:' || manifest.builder_wo_canonical
        || '/po:' || manifest.builder_po_canonical
    END,
    'makesafe_refs.normaliseRef+wo_po_precedence@v2+authority_split@v2',
    jsonb_strip_nulls(jsonb_build_object(
      'external_ref', manifest.external_ref_canonical,
      'builder_wo', manifest.builder_wo_canonical,
      'builder_po', manifest.builder_po_canonical,
      'deliverable', manifest.deliverable_ref_canonical,
      'correction', 'persisted_authority_split'
    )),
    jsonb_build_object(
      'lineage_reconciliation',
      jsonb_build_object(
        'method', 'backfill',
        'sourcePostId', (
          SELECT min(source_id)
          FROM jsonb_array_elements_text(
            manifest.source_post_ids
          ) source(source_id)
        )
      )
    ),
    manifest.state,
    manifest.reason_code,
    true,
    true,
    'backfill',
    'migration:20260724062509',
    'split quarantined persisted authority without operational side effects',
    (
      SELECT min(email.received_at)
      FROM jsonb_array_elements_text(
        manifest.source_post_ids
      ) source(source_id)
      JOIN public.emails email ON email.post_id = source.source_id
    ),
    manifest.source_manifest_sha256
  FROM _ms_v2_manifest manifest;

  INSERT INTO
    public.makesafe_intake_source_authority_correction_supersessions (
      org_id,
      source_post_id,
      superseded_correction_id,
      prior_authority_case_id,
      effective_case_id,
      correction_kind,
      expected_identity_key,
      evidence
    )
  SELECT
    v_org_id,
    source.post_id,
    source.superseded_correction_id,
    source.prior_authority_case_id,
    source.effective_case_id,
    'persisted_authority_split',
    source.expected_identity_key,
    jsonb_build_object(
      'planned_instruction_key',
      manifest.planned_instruction_key,
      'effective_source_manifest_sha256',
      manifest.source_manifest_sha256,
      'quarantine_reason',
      'persisted_authority_split_reconciliation_required',
      'migration',
      '20260724062509'
    )
  FROM _ms_v2_sources source
  JOIN _ms_v2_manifest manifest
    ON manifest.partition_no = source.partition_no;

  INSERT INTO
    public.makesafe_intake_source_authority_correction_supersessions (
      org_id,
      source_post_id,
      superseded_correction_id,
      prior_authority_case_id,
      effective_case_id,
      correction_kind,
      expected_identity_key,
      evidence
    )
  SELECT
    v_org_id,
    repair.post_id,
    repair.superseded_correction_id,
    repair.prior_authority_case_id,
    repair.prior_authority_case_id,
    'identity_expectation_repair',
    NULL,
    jsonb_build_object(
      'prior_expected_identity_key',
      repair.current_expected_identity_key,
      'reconstructed_instruction_key',
      'fingerprint:4200bf6936479267/deliverable:unknown%3AGENERAL_MAKESAFE/cycle:1',
      'quarantine_reason',
      'source_correction_identity_mismatch_reconciliation_required',
      'migration',
      '20260724062509'
    )
  FROM _ms_v2_repairs repair;

  IF (
    SELECT count(*)
    FROM public.makesafe_intake_source_authority_correction_supersessions
    WHERE org_id = v_org_id
  ) <> 60
    OR (
      SELECT count(*)
      FROM public.makesafe_intake_source_authority_correction_supersessions
      WHERE org_id = v_org_id
        AND correction_kind = 'persisted_authority_split'
    ) <> 58
    OR (
      SELECT count(*)
      FROM public.makesafe_intake_source_authority_correction_supersessions
      WHERE org_id = v_org_id
        AND correction_kind = 'identity_expectation_repair'
        AND expected_identity_key IS NULL
    ) <> 2
    OR (
      SELECT count(*)
      FROM public.makesafe_intake_cases
      WHERE org_id = v_org_id
        AND normaliser_version =
          'makesafe_refs.normaliseRef+wo_po_precedence@v2+authority_split@v2'
    ) <> 33
  THEN
    RAISE EXCEPTION
      'lineage v2 reconciliation post-check failed: correction counts';
  END IF;

  IF (SELECT count(*) FROM public.makesafe_intake_cases)
      <> v_case_count + 33
    OR (SELECT count(*) FROM public.makesafe_intake_case_events)
      <> v_case_event_count + 33
    OR (SELECT count(*) FROM public.makesafe_intake_case_sources)
      <> v_case_source_count
    OR (SELECT count(*) FROM public.jobs) <> v_job_count
    OR (SELECT count(*) FROM public.job_assignments) <> v_assignment_count
    OR (SELECT count(*) FROM public.makesafe_intake_drafts) <> v_draft_count
    OR (SELECT count(*) FROM public.job_documents) <> v_document_count
    OR (SELECT count(*) FROM public.makesafe_notify_log) <> v_notify_count
    OR (SELECT count(*) FROM public.outbound_message_queue) <> v_outbound_count
  THEN
    RAISE EXCEPTION
      'lineage v2 reconciliation post-check failed: side-effect footprint changed';
  END IF;
END
$$;

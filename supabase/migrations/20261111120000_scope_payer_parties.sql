-- RQ-17.c: one quote, one invoice per payer. Each payer the sealed quote names
-- becomes a party on the job through the one party writer, upsert_job_party
-- (20261002120000), so that payer's deposit, its own invoice and the deposit
-- gate all read the same party row. Keyed by the sealed payer id: the client
-- is the job's own owner party ('primary'), a neighbour keeps its payer id.
-- A legacy party row with no key is adopted by that writer (the owner by
-- is_primary, a neighbour by equal phone or email); one it cannot match refuses
-- the whole call rather than leave two parties for one share.
-- No new writer of job_contacts, no Xero, no send, no switch, no backfill.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.register_scope_payer_parties(
  p_job_id uuid, p_scope_revision_id uuid, p_org_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  j public.jobs%ROWTYPE; r public.scope_revisions%ROWTYPE; s public.scope_job_draft_sets%ROWTYPE;
  pricing jsonb; parties jsonb; party jsonb; total jsonb; fields jsonb; k text; role text;
  out jsonb := '[]'::jsonb; res jsonb;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job_id;
  IF NOT FOUND OR p_org_id IS NULL OR j.org_id IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'scope_payer_parties_job_forbidden' USING ERRCODE = '42501';
  END IF;
  -- Only the revision the payer drafts were prepared from, so the parties and
  -- the drafts can never come from two different quotes.
  SELECT * INTO s FROM public.scope_job_draft_sets WHERE job_id = p_job_id;
  IF NOT FOUND OR s.scope_revision_id IS DISTINCT FROM p_scope_revision_id THEN
    RAISE EXCEPTION 'scope_payer_parties_revision_stale' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO r FROM public.scope_revisions WHERE id = p_scope_revision_id AND job_id = p_job_id;
  IF NOT FOUND OR r.status <> 'frozen'
    OR encode(sha256(convert_to(r.pricing_canonical_text, 'UTF8')), 'hex') <> r.pricing_hash THEN
    RAISE EXCEPTION 'scope_payer_parties_revision_stale' USING ERRCODE = '23514';
  END IF;
  pricing := r.pricing_canonical_text::jsonb;
  parties := pricing->'parties';
  -- One payer: the job's own client pays, and the existing owner rule holds.
  IF jsonb_typeof(parties) IS DISTINCT FROM 'array' OR jsonb_array_length(parties) < 2 THEN
    RETURN jsonb_build_object('job_id', p_job_id, 'scope_revision_id', p_scope_revision_id,
      'outcome', 'single_payer', 'parties', '[]'::jsonb);
  END IF;
  total := CASE WHEN jsonb_typeof(pricing->'totalIncGST') = 'number' THEN pricing->'totalIncGST' ELSE 'null'::jsonb END;
  FOR party IN SELECT value FROM jsonb_array_elements(parties) LOOP
    role := lower(btrim(coalesce(party->>'role', '')));
    IF party->>'id' = '__client__' OR role IN ('client', 'owner') THEN
      k := 'primary';
      -- The owner's name and ids follow the job (the writer refuses them).
      fields := jsonb_build_object('party_role', 'owner');
    ELSE
      k := party->>'id';
      fields := jsonb_build_object(
        'client_name', CASE WHEN jsonb_typeof(party->'name') = 'string' THEN party->'name' ELSE 'null'::jsonb END,
        'client_phone', CASE WHEN jsonb_typeof(party->'phone') = 'string' THEN party->'phone' ELSE 'null'::jsonb END,
        'client_email', CASE WHEN jsonb_typeof(party->'email') = 'string' THEN party->'email' ELSE 'null'::jsonb END,
        'site_address', CASE WHEN jsonb_typeof(party->'address') = 'string' THEN party->'address' ELSE 'null'::jsonb END,
        'ghl_contact_id', CASE WHEN jsonb_typeof(party->'ghl_contact_id') = 'string' THEN party->'ghl_contact_id' ELSE 'null'::jsonb END,
        'party_role', to_jsonb(CASE WHEN role IN ('neighbour', 'strata', 'strata_rep', 'builder', 'tenant', 'agent', 'other_payer')
          THEN role ELSE 'neighbour' END));
    END IF;
    -- The payer's own share of the one quote. An unknown figure stays unknown.
    fields := fields || jsonb_build_object(
      'portion_inc_gst', CASE WHEN jsonb_typeof(party->'inc_gst') = 'number' THEN party->'inc_gst' ELSE 'null'::jsonb END,
      'portion_ex_gst', CASE WHEN jsonb_typeof(party->'ex_gst') = 'number' THEN party->'ex_gst' ELSE 'null'::jsonb END,
      'portions_total_inc_gst', total);
    res := public.upsert_job_party(p_job_id, k, fields, 'scope_payer_parties');
    out := out || jsonb_build_array(jsonb_build_object('payer_id', party->>'id',
      'job_contact_id', res->'job_contact_id', 'label', res->'label',
      'source_party_key', res->'source_party_key', 'outcome', res->'outcome'));
  END LOOP;
  -- The writer adopts an older unkeyed neighbour row only on an equal phone or
  -- email. One it could not match would now sit beside the sealed payer as a
  -- second party for the same share, so refuse and roll the whole call back:
  -- the job keeps its older parties until someone matches them by hand.
  IF EXISTS (SELECT 1 FROM public.job_contacts c WHERE c.job_id = p_job_id AND c.source_party_key IS NULL
    AND c.is_primary IS NOT TRUE AND c.removed_at IS NULL AND coalesce(c.status, '') <> 'removed') THEN
    RAISE EXCEPTION 'scope_payer_parties_legacy_unmatched' USING ERRCODE = '23514';
  END IF;
  RETURN jsonb_build_object('job_id', p_job_id, 'scope_revision_id', p_scope_revision_id,
    'outcome', 'registered', 'parties', out);
END $$;

COMMENT ON FUNCTION public.register_scope_payer_parties(uuid, uuid, uuid) IS
  'RQ-17.c (20261111120000): each payer the sealed quote names (pricing parties of the revision the payer drafts were prepared from) becomes a job party through upsert_job_party, keyed by its payer id (the client is primary). Single-payer quotes write nothing. An older unkeyed neighbour row the writer could not adopt refuses the call (scope_payer_parties_legacy_unmatched). Any refusal rolls the whole call back.';

REVOKE ALL ON FUNCTION public.register_scope_payer_parties(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_scope_payer_parties(uuid, uuid, uuid) TO service_role;

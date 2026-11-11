-- RQ-17.c: one quote, one invoice per payer. Each payer the sealed quote names
-- becomes a party on the job through the one party writer, upsert_job_party
-- (20261002120000), so that payer's deposit, its own invoice and the deposit
-- gate all read the same party row. Keyed by the sealed payer id: the client
-- is the job's own owner party ('primary'), a neighbour keeps its payer id.
-- A legacy party row with no key is adopted by that writer (the owner by
-- is_primary, a neighbour by equal phone or email); one it cannot match refuses
-- the whole call rather than leave two parties for one share.
-- A contact detail the sealed quote leaves out or blank is not sent, so the
-- writer keeps what the party already holds. A payer this function registered
-- before that the current quote no longer names is soft-removed through the
-- same writer (status removed: the row and its receipts stay), so it neither
-- holds the deposit gate nor stands in for a payer the quote now needs.
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
  out jsonb := '[]'::jsonb; res jsonb; kept uuid[] := '{}'; gone jsonb := '[]'::jsonb;
  stale public.job_contacts%ROWTYPE; f text; owner_id uuid;
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
  total := CASE WHEN jsonb_typeof(pricing->'totalIncGST') = 'number' THEN pricing->'totalIncGST' ELSE 'null'::jsonb END;
  -- One payer: the job's own client pays, and the existing owner rule holds.
  -- A job this function never registered is left exactly as it is; on one it
  -- did, the earlier payers are removed below and the owner holds the whole quote.
  IF jsonb_typeof(parties) IS DISTINCT FROM 'array' OR jsonb_array_length(parties) < 2 THEN
    SELECT c2.id INTO owner_id FROM public.job_contacts c2
    WHERE c2.job_id = p_job_id AND c2.source_party_key = 'primary'
      AND EXISTS (SELECT 1 FROM public.job_party_events e WHERE e.job_contact_id = c2.id
        AND e.actor = 'scope_payer_parties');
    IF owner_id IS NOT NULL THEN
      kept := ARRAY[owner_id];
      IF jsonb_typeof(total) = 'number' AND (total#>>'{}')::numeric > 0 THEN
        PERFORM public.upsert_job_party(p_job_id, 'primary', jsonb_build_object('party_role', 'owner',
          'portion_inc_gst', total, 'portions_total_inc_gst', total,
          'portion_ex_gst', CASE WHEN jsonb_typeof(pricing->'totalExGST') = 'number' THEN pricing->'totalExGST' ELSE 'null'::jsonb END),
          'scope_payer_parties');
      END IF;
    END IF;
  ELSE
  FOR party IN SELECT value FROM jsonb_array_elements(parties) LOOP
    role := lower(btrim(coalesce(party->>'role', '')));
    IF party->>'id' = '__client__' OR role IN ('client', 'owner') THEN
      k := 'primary';
      -- The owner's name and ids follow the job (the writer refuses them).
      fields := jsonb_build_object('party_role', 'owner');
    ELSE
      k := party->>'id';
      fields := jsonb_build_object('party_role', to_jsonb(CASE WHEN role IN
        ('neighbour', 'strata', 'strata_rep', 'builder', 'tenant', 'agent', 'other_payer') THEN role ELSE 'neighbour' END));
      -- Only a detail the quote actually gives: a key sent to the writer
      -- overwrites, so a missing or blank one would erase what the party holds.
      FOREACH f IN ARRAY ARRAY['name:client_name', 'phone:client_phone', 'email:client_email',
        'address:site_address', 'ghl_contact_id:ghl_contact_id'] LOOP
        IF jsonb_typeof(party->split_part(f, ':', 1)) = 'string'
          AND btrim(party->>split_part(f, ':', 1)) <> '' THEN
          fields := fields || jsonb_build_object(split_part(f, ':', 2), party->split_part(f, ':', 1));
        END IF;
      END LOOP;
    END IF;
    -- The payer's own share of the one quote. An unknown figure stays unknown.
    fields := fields || jsonb_build_object(
      'portion_inc_gst', CASE WHEN jsonb_typeof(party->'inc_gst') = 'number' THEN party->'inc_gst' ELSE 'null'::jsonb END,
      'portion_ex_gst', CASE WHEN jsonb_typeof(party->'ex_gst') = 'number' THEN party->'ex_gst' ELSE 'null'::jsonb END,
      'portions_total_inc_gst', total);
    res := public.upsert_job_party(p_job_id, k, fields, 'scope_payer_parties');
    kept := kept || (res->>'job_contact_id')::uuid;
    out := out || jsonb_build_array(jsonb_build_object('payer_id', party->>'id',
      'job_contact_id', res->'job_contact_id', 'label', res->'label',
      'source_party_key', res->'source_party_key', 'outcome', res->'outcome'));
  END LOOP;
  END IF;
  -- A payer an earlier registration made that this quote no longer names stops
  -- paying: soft-removed by the one writer, row and receipts kept. Only rows
  -- this function registered; the owner is never removed.
  FOR stale IN SELECT * FROM public.job_contacts c3 WHERE c3.job_id = p_job_id
    AND c3.source_party_key IS NOT NULL AND c3.source_party_key <> 'primary'
    AND c3.removed_at IS NULL AND coalesce(c3.status, '') <> 'removed'
    AND NOT (c3.id = ANY (kept))
    AND EXISTS (SELECT 1 FROM public.job_party_events e WHERE e.job_contact_id = c3.id
      AND e.actor = 'scope_payer_parties')
    ORDER BY c3.contact_label LOOP
    res := public.upsert_job_party(p_job_id, stale.source_party_key, '{"status":"removed"}'::jsonb, 'scope_payer_parties');
    gone := gone || jsonb_build_array(jsonb_build_object('job_contact_id', stale.id, 'label', stale.contact_label,
      'source_party_key', stale.source_party_key, 'outcome', res->'outcome'));
  END LOOP;
  IF jsonb_typeof(parties) IS DISTINCT FROM 'array' OR jsonb_array_length(parties) < 2 THEN
    RETURN jsonb_build_object('job_id', p_job_id, 'scope_revision_id', p_scope_revision_id,
      'outcome', 'single_payer', 'parties', '[]'::jsonb, 'removed', gone);
  END IF;
  -- The writer adopts an older unkeyed neighbour row only on an equal phone or
  -- email. One it could not match would now sit beside the sealed payer as a
  -- second party for the same share, so refuse and roll the whole call back:
  -- the job keeps its older parties until someone matches them by hand.
  IF EXISTS (SELECT 1 FROM public.job_contacts c WHERE c.job_id = p_job_id AND c.source_party_key IS NULL
    AND c.is_primary IS NOT TRUE AND c.removed_at IS NULL AND coalesce(c.status, '') <> 'removed') THEN
    RAISE EXCEPTION 'scope_payer_parties_legacy_unmatched' USING ERRCODE = '23514';
  END IF;
  RETURN jsonb_build_object('job_id', p_job_id, 'scope_revision_id', p_scope_revision_id,
    'outcome', 'registered', 'parties', out, 'removed', gone);
END $$;

COMMENT ON FUNCTION public.register_scope_payer_parties(uuid, uuid, uuid) IS
  'RQ-17.c (20261111120000): each payer the sealed quote names (pricing parties of the revision the payer drafts were prepared from) becomes a job party through upsert_job_party, keyed by its payer id (the client is primary). A detail the quote leaves out or blank is not sent, so the party keeps it. A payer this function registered before that the quote no longer names is soft-removed through the same writer (row and receipts kept). Single-payer quotes write nothing on a job this function never registered. An older unkeyed neighbour row the writer could not adopt refuses the call (scope_payer_parties_legacy_unmatched). Any refusal rolls the whole call back.';

REVOKE ALL ON FUNCTION public.register_scope_payer_parties(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_scope_payer_parties(uuid, uuid, uuid) TO service_role;

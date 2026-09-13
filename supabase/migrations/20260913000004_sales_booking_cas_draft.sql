-- Atomic draft CAS. Isolated booking_test only. Not a production apply.
CREATE UNIQUE INDEX IF NOT EXISTS sales_booking_drafts_org_case ON sales_booking_drafts (org_id, case_id);

CREATE OR REPLACE FUNCTION sales_booking_cas_draft(
  p_org_id uuid,
  p_case_id text,
  p_text text,
  p_human_edited boolean,
  p_sender text,
  p_actor_id uuid,
  p_expected_revision integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cur integer;
  nxt integer;
BEGIN
  IF p_org_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'org_required');
  END IF;
  SELECT revision INTO cur FROM sales_booking_drafts
    WHERE org_id = p_org_id AND case_id = p_case_id
    FOR UPDATE;
  IF NOT FOUND THEN cur := 0; END IF;
  IF p_expected_revision IS NOT NULL AND cur <> p_expected_revision THEN
    RETURN jsonb_build_object('ok', false, 'code', 'cas_conflict', 'revision', cur);
  END IF;
  nxt := cur + 1;
  INSERT INTO sales_booking_drafts (case_id, org_id, text, human_edited, sender, actor_id, revision, updated_at)
  VALUES (p_case_id, p_org_id, p_text, COALESCE(p_human_edited, false), p_sender, p_actor_id, nxt, now())
  ON CONFLICT (case_id) DO UPDATE
    SET text = EXCLUDED.text,
        human_edited = EXCLUDED.human_edited,
        sender = EXCLUDED.sender,
        actor_id = EXCLUDED.actor_id,
        revision = nxt,
        updated_at = now(),
        org_id = sales_booking_drafts.org_id
    WHERE sales_booking_drafts.org_id = p_org_id
      AND sales_booking_drafts.revision = cur;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'cas_conflict', 'revision', cur);
  END IF;
  RETURN jsonb_build_object('ok', true, 'revision', nxt, 'text', p_text, 'case_id', p_case_id, 'human_edited', COALESCE(p_human_edited, false), 'sender', p_sender);
END;
$$;

REVOKE ALL ON FUNCTION sales_booking_cas_draft(uuid, text, text, boolean, text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION sales_booking_cas_draft(uuid, text, text, boolean, text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION sales_booking_cas_draft(uuid, text, text, boolean, text, uuid, integer) TO marninstobbe;

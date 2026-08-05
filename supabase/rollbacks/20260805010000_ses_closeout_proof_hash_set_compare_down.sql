-- Rollback: restore route_kind-ordered closeout proof comparison
-- (the pre-20260805010000 order-sensitive defect). Prefer forward-fix only.

CREATE OR REPLACE FUNCTION public.commit_ses_release_closeout_v1(p_closeout jsonb)
 RETURNS makesafe_closeout_revisions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  target_release_id uuid := (p_closeout->>'release_revision_id')::uuid;
  target public.makesafe_closeout_revisions%ROWTYPE;
  required_count integer;
  proof_count integer;
  member record;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ses-release-closeout:' || target_release_id::text, 0)
  );
  SELECT * INTO target
  FROM public.makesafe_closeout_revisions
  WHERE release_revision_id = target_release_id;
  IF FOUND THEN
    IF target.content_hash = p_closeout->>'content_hash' THEN
      RETURN target;
    END IF;
    RAISE EXCEPTION 'release closeout already exists with different content'
      USING ERRCODE = '23505';
  END IF;

  SELECT count(*) INTO required_count
  FROM public.makesafe_release_revision_routes
  WHERE release_revision_id = target_release_id AND required;
  SELECT count(*) INTO proof_count
  FROM public.ses_release_route_proofs
  WHERE release_revision_id = target_release_id;
  IF required_count = 0 OR proof_count <> required_count THEN
    RAISE EXCEPTION 'not every required release route has a confirmed proof'
      USING ERRCODE = '23514';
  END IF;

  IF ARRAY(
    SELECT proof_hash
    FROM public.ses_release_route_proofs
    WHERE release_revision_id = target_release_id
    ORDER BY route_kind
  ) IS DISTINCT FROM ARRAY(
    SELECT jsonb_array_elements_text(p_closeout->'required_proof_hashes')
    ORDER BY 1
  ) THEN
    RAISE EXCEPTION 'closeout proof hashes do not match the confirmed route ledger'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.makesafe_release_revision_members member_rows
    LEFT JOIN public.makesafe_invoice_obligation_revisions obligation_revision
      ON obligation_revision.id = member_rows.invoice_obligation_revision_id
    WHERE member_rows.release_revision_id = target_release_id
      AND (
        obligation_revision.id IS NULL
        OR NOT (
          obligation_revision.state = 'authorised'
          OR (
            obligation_revision.state = 'proposed'
            AND obligation_revision.pricing_disposition =
              'no_additional_charge'
          )
        )
      )
  ) THEN
    RAISE EXCEPTION
      'release member lacks either an AUTHORISED invoice or an explicit no-additional-charge obligation'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.makesafe_closeout_revisions (
    id,
    org_id,
    release_revision_id,
    content_hash,
    required_proof_hashes,
    verified,
    verified_at,
    created_by
  ) VALUES (
    (p_closeout->>'id')::uuid,
    (p_closeout->>'org_id')::uuid,
    target_release_id,
    p_closeout->>'content_hash',
    ARRAY(
      SELECT jsonb_array_elements_text(p_closeout->'required_proof_hashes')
      ORDER BY 1
    ),
    true,
    clock_timestamp(),
    p_closeout->>'created_by'
  ) RETURNING * INTO target;

  UPDATE public.makesafe_release_revisions
  SET state = 'released', updated_at = clock_timestamp()
  WHERE id = target_release_id;

  FOR member IN
    SELECT *
    FROM public.makesafe_release_revision_members
    WHERE release_revision_id = target_release_id
  LOOP
    IF member.invoice_obligation_revision_id IS NOT NULL THEN
      UPDATE public.makesafe_invoice_obligation_revisions
      SET state = 'released'
      WHERE id = member.invoice_obligation_revision_id
        AND (
          state = 'authorised'
          OR (
            state = 'proposed'
            AND pricing_disposition = 'no_additional_charge'
          )
        );
      UPDATE public.makesafe_invoice_obligation_cycles
      SET commercially_closed = true
      WHERE obligation_revision_id = member.invoice_obligation_revision_id;
      UPDATE public.makesafe_invoice_obligations obligation
      SET status = 'released'
      WHERE obligation.id = (
        SELECT revision.obligation_id
        FROM public.makesafe_invoice_obligation_revisions revision
        WHERE revision.id = member.invoice_obligation_revision_id
      );
    END IF;

    INSERT INTO public.makesafe_terminal_proofs (
      org_id,
      job_id,
      kind,
      attendance_cycle_ids,
      attendance_cycle_set_hash,
      readiness_revision,
      release_revision_id,
      closeout_revision_id,
      evidence_refs,
      proven_by
    )
    SELECT
      release.org_id,
      member.job_id,
      'release_closeout',
      member.attendance_cycle_ids,
      public.makesafe_attendance_cycle_set_hash_v1(member.attendance_cycle_ids),
      binding->>'readiness_revision',
      target_release_id,
      target.id,
      jsonb_build_array(
        jsonb_build_object(
          'kind', 'ses_release_closeout',
          'release_revision_id', target_release_id,
          'closeout_revision_id', target.id
        )
      ),
      p_closeout->>'created_by'
    FROM public.makesafe_release_revisions release,
         jsonb_array_elements(release.readiness_bindings) binding
    WHERE release.id = target_release_id
      AND binding->>'job_id' = member.job_id::text;

    INSERT INTO public.job_events (
      job_id,
      event_type,
      detail_json
    ) VALUES (
      member.job_id,
      'note',
      jsonb_build_object(
        'text',
        'MAKESAFE_PACK_SENT | main | SES release ' ||
          target_release_id::text || ' | closeout=' || target.id::text,
        'release_revision_id',
        target_release_id,
        'closeout_revision_id',
        target.id,
        'source',
        'ses-u6r'
      )
    );
  END LOOP;
  RETURN target;
END;
$function$;

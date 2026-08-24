-- Executed by ../run.sh after the matching migration is applied to PostgreSQL.
BEGIN;

INSERT INTO public.jobs (id, org_id, status, type, job_number)
VALUES (
  'f6453cb9-243c-45d7-88f2-01a2750b67a4',
  '00000000-0000-0000-0000-000000000001',
  'draft',
  'fencing',
  'TEST-ATTACH-IDEMPOTENCY'
);

INSERT INTO public.job_documents (
  id,
  job_id,
  type,
  file_name,
  storage_url,
  version
)
VALUES (
  '9912b89a-57aa-473a-bacf-6b84439c1204',
  'f6453cb9-243c-45d7-88f2-01a2750b67a4',
  'work_order',
  'work-order.pdf',
  'https://example.invalid/original.pdf',
  7
);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.job_documents (
      job_id,
      type,
      file_name,
      storage_url,
      version
    )
    VALUES (
      'f6453cb9-243c-45d7-88f2-01a2750b67a4',
      'work_order',
      'work-order.pdf',
      'https://example.invalid/duplicate.pdf',
      1
    );
    RAISE EXCEPTION 'active duplicate was accepted';
  EXCEPTION
    WHEN unique_violation THEN
      IF SQLERRM NOT LIKE '%ux_job_documents_makesafe_attach_key%' THEN
        RAISE;
      END IF;
  END;

  IF NOT EXISTS (
    SELECT 1
    FROM public.job_documents
    WHERE id = '9912b89a-57aa-473a-bacf-6b84439c1204'
      AND storage_url = 'https://example.invalid/original.pdf'
      AND version = 7
  ) THEN
    RAISE EXCEPTION 'existing active document changed after duplicate refusal';
  END IF;
END;
$$;

INSERT INTO public.job_documents (
  job_id,
  type,
  file_name,
  storage_url,
  version,
  superseded_at
)
VALUES (
  'f6453cb9-243c-45d7-88f2-01a2750b67a4',
  'work_order',
  'work-order.pdf',
  'https://example.invalid/superseded.pdf',
  1,
  now()
);

DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM public.job_documents
    WHERE job_id = 'f6453cb9-243c-45d7-88f2-01a2750b67a4'
      AND type = 'work_order'
      AND file_name = 'work-order.pdf'
      AND superseded_at IS NULL
  ) <> 1 THEN
    RAISE EXCEPTION 'active document uniqueness was not preserved';
  END IF;

  IF (
    SELECT count(*)
    FROM public.job_documents
    WHERE job_id = 'f6453cb9-243c-45d7-88f2-01a2750b67a4'
      AND type = 'work_order'
      AND file_name = 'work-order.pdf'
  ) <> 2 THEN
    RAISE EXCEPTION 'superseded document was not allowed';
  END IF;
END;
$$;

-- Pin every guarded document class in the partial-index predicate. A future
-- edit that accidentally removes one class must make this contract fail.
DO $$
DECLARE
  guarded_type text;
  guarded_file text;
BEGIN
  FOREACH guarded_type IN ARRAY ARRAY[
    'work_order',
    'makesafe_report',
    'roof_report',
    'invoice',
    'swms'
  ]
  LOOP
    guarded_file := 'all-types-' || guarded_type || '.pdf';

    INSERT INTO public.job_documents (
      job_id,
      type,
      file_name,
      storage_url,
      version
    )
    VALUES (
      'f6453cb9-243c-45d7-88f2-01a2750b67a4',
      guarded_type,
      guarded_file,
      'https://example.invalid/' || guarded_type || '-original.pdf',
      1
    );

    BEGIN
      INSERT INTO public.job_documents (
        job_id,
        type,
        file_name,
        storage_url,
        version
      )
      VALUES (
        'f6453cb9-243c-45d7-88f2-01a2750b67a4',
        guarded_type,
        guarded_file,
        'https://example.invalid/' || guarded_type || '-duplicate.pdf',
        2
      );
      RAISE EXCEPTION 'active duplicate was accepted for type %', guarded_type;
    EXCEPTION
      WHEN unique_violation THEN
        IF SQLERRM NOT LIKE '%ux_job_documents_makesafe_attach_key%' THEN
          RAISE;
        END IF;
    END;
  END LOOP;
END;
$$;

-- The authored predicate deliberately excludes null filenames and document
-- classes outside the MakeSafe attach surface.
INSERT INTO public.job_documents (
  job_id,
  type,
  file_name,
  storage_url,
  version
)
VALUES
  (
    'f6453cb9-243c-45d7-88f2-01a2750b67a4',
    'quote',
    'outside-guard.pdf',
    'https://example.invalid/quote-1.pdf',
    1
  ),
  (
    'f6453cb9-243c-45d7-88f2-01a2750b67a4',
    'quote',
    'outside-guard.pdf',
    'https://example.invalid/quote-2.pdf',
    2
  ),
  (
    'f6453cb9-243c-45d7-88f2-01a2750b67a4',
    'work_order',
    NULL,
    'https://example.invalid/null-name-1.pdf',
    1
  ),
  (
    'f6453cb9-243c-45d7-88f2-01a2750b67a4',
    'work_order',
    NULL,
    'https://example.invalid/null-name-2.pdf',
    2
  );

ROLLBACK;

-- Contract: 20261020170000_job_media_signature_voice_note_phases. job_media accepts the completion
-- wizard's 'signature' and 'voice_note' rows, still accepts every earlier phase, and still refuses
-- an unknown one.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO public.job_media (job_id, phase, type, storage_url)
SELECT '9b000000-0000-4000-8000-000000000001', p, 'photo', 'https://example.invalid/' || p
FROM unnest(ARRAY['scope', 'in_progress', 'completion', 'receipt', 'marketing', 'neighbour_signoff',
                  'issue', 'quote_builder', 'signature', 'voice_note']) AS p;
DO $$
BEGIN
 IF (SELECT count(*) FROM public.job_media WHERE job_id = '9b000000-0000-4000-8000-000000000001') <> 10 THEN
  RAISE EXCEPTION 'signature phase contract: job_media must accept signature, voice_note and every earlier phase';
 END IF;
 BEGIN
  INSERT INTO public.job_media (job_id, phase, type) VALUES ('9b000000-0000-4000-8000-000000000001', 'nope', 'photo');
  RAISE EXCEPTION 'signature phase contract: job_media accepted an unknown phase';
 EXCEPTION WHEN check_violation THEN
  NULL;
 END;
END $$;
ROLLBACK;

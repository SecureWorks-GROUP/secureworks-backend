-- Rollback contract: 20261019120000_job_media_signature_voice_note_phases. The down narrows the
-- job_media phase check back to the 20261009120000 list (no row used either new phase) and nothing
-- else: 'quote_builder' is still accepted and 'signature' is refused again.
\set ON_ERROR_STOP on
DO $$
BEGIN
 BEGIN
  INSERT INTO public.job_media (phase, type) VALUES ('signature', 'photo');
  RAISE EXCEPTION 'signature phase rollback contract: job_media still accepts the signature phase';
 EXCEPTION WHEN check_violation THEN
  NULL;
 END;
 BEGIN
  INSERT INTO public.job_media (phase, type) VALUES ('quote_builder', 'photo');
  RAISE EXCEPTION 'rollback-probe-ok';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'rollback-probe-ok' THEN RAISE; END IF;
 END;
END $$;

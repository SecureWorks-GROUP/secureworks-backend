-- Someone else's record timeline and vision policy where story safety's and the call budget's should
-- be: the migration must refuse to overwrite either, naming both.
CREATE OR REPLACE FUNCTION public.context_document_vision_policy() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT jsonb_build_object('max_image_bytes', 1) $$;
DO $pre$
DECLARE def text := pg_get_functiondef('public.context_job_record_timeline(uuid[],timestamptz)'::regprocedure);
BEGIN
 EXECUTE replace(def, 'Job created (', 'A job was created (');
END $pre$;

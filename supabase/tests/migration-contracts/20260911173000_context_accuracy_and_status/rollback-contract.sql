DO $$ BEGIN
 IF has_function_privilege('service_role','public.context_accuracy_draw(date)','EXECUTE') THEN RAISE EXCEPTION 'B4 rollback still draws'; END IF;
 IF to_regclass('public.context_accuracy_samples') IS NULL OR to_regclass('public.context_accuracy_alerts') IS NULL THEN RAISE EXCEPTION 'B4 rollback lost audit'; END IF;
END $$;

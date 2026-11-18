-- A helper of the same name with another body must refuse the migration.
CREATE FUNCTION public.match_clues_unchanged(p_subject_kind text, p_subject_id text, p_clues jsonb, p_rule_version text)
RETURNS boolean LANGUAGE sql AS $fn$ SELECT true $fn$;

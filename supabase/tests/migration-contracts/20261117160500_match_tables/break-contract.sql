-- Removing this boundary must make the AI counts assertion fail.
ALTER TABLE public.match_clue_types DROP CONSTRAINT match_clue_types_counts_class_check;

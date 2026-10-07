-- A table named context_placement_grades already exists with another shape (a
-- hand-made sheet, an older draft). Applying the migration over it would leave
-- the scorecard reading grades it cannot trust: the guard must refuse and say so.
CREATE TABLE public.context_placement_grades (id uuid PRIMARY KEY, verdict text);

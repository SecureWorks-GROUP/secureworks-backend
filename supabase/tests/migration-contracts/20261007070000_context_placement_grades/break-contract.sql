-- Count an unsure verdict as right (an unsure grade is a grade the records
-- could not decide): the contract's "an unsure verdict is never right" check
-- must catch it.
CREATE OR REPLACE FUNCTION public.context_placement_grades_newest(p_as_of timestamptz DEFAULT now())
RETURNS TABLE (sample_id text, as_of timestamptz, graded_at timestamptz, graded integer, right_count integer,
 wrong_count integer, unsure_count integer, right_share numeric, weighted_right_share numeric, strata jsonb, samples integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH stored AS (
  SELECT g.sample_id, g.as_of, g.stratum, g.stratum_rows, g.verdict, g.graded_at
  FROM public.context_placement_grades g
  WHERE g.created_at <= coalesce(p_as_of, now()) AND g.graded_at <= coalesce(p_as_of, now())
 ), newest AS (
  SELECT s.sample_id AS sid FROM stored s GROUP BY s.sample_id
  ORDER BY max(s.as_of) DESC, s.sample_id COLLATE "C" DESC LIMIT 1
 ), g AS (
  SELECT s.* FROM stored s JOIN newest n ON n.sid = s.sample_id
 ), per AS (
  SELECT g.stratum AS st, count(*)::integer AS graded, count(*) FILTER (WHERE g.verdict IN ('right', 'unsure'))::integer AS r,
         count(*) FILTER (WHERE g.verdict = 'wrong')::integer AS w, count(*) FILTER (WHERE g.verdict = 'unsure')::integer AS u,
         max(g.stratum_rows) AS rows_
  FROM g GROUP BY g.stratum
 ), tot AS (
  SELECT max(g.as_of) AS as_of_, max(g.graded_at) AS graded_at_, count(*)::integer AS graded_,
         count(*) FILTER (WHERE g.verdict IN ('right', 'unsure'))::integer AS r_, count(*) FILTER (WHERE g.verdict = 'wrong')::integer AS w_,
         count(*) FILTER (WHERE g.verdict = 'unsure')::integer AS u_
  FROM g
 ), wt AS (
  SELECT sum(per.rows_::numeric * per.r / per.graded) / nullif(sum(per.rows_), 0) AS weighted,
         jsonb_object_agg(per.st, jsonb_build_object('graded', per.graded, 'right', per.r, 'wrong', per.w, 'unsure', per.u,
          'stratum_rows', per.rows_)) AS strata_
  FROM per
 )
 SELECT (SELECT n.sid FROM newest n), tot.as_of_, tot.graded_at_, tot.graded_, tot.r_, tot.w_, tot.u_,
        CASE WHEN tot.graded_ = 0 THEN NULL ELSE round(floor(tot.r_::numeric * 10000 / tot.graded_) / 10000, 4) END,
        CASE WHEN tot.graded_ = 0 OR wt.weighted IS NULL THEN NULL ELSE round(floor(round(wt.weighted, 10) * 10000) / 10000, 4) END,
        coalesce(wt.strata_, '{}'::jsonb),
        (SELECT count(DISTINCT s.sample_id)::integer FROM stored s)
 FROM tot CROSS JOIN wt
$fn$;

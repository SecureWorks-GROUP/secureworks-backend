-- Count an unsure verdict as right (an unsure grade is a grade the records
-- could not decide): the contract's "an unsure verdict is never right" check
-- must catch it.
CREATE OR REPLACE FUNCTION public.context_placement_grades_newest(p_as_of timestamptz DEFAULT now(),
 p_population text DEFAULT 'customer_facing')
RETURNS TABLE (sample_id text, population text, as_of timestamptz, graded_at timestamptz, drawn integer, graded integer,
 missing integer, right_count integer, wrong_count integer, unsure_count integer, right_share numeric, weighted_right_share numeric,
 placed_share numeric, right_of_all numeric, strata jsonb, samples integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH stored AS (
  SELECT g.* FROM public.context_placement_grades g
  WHERE g.population = coalesce(p_population, 'customer_facing')
    AND g.created_at <= coalesce(p_as_of, now()) AND g.graded_at <= coalesce(p_as_of, now())
 ), newest AS (
  SELECT s.sample_id AS sid FROM stored s GROUP BY s.sample_id
  ORDER BY max(s.as_of) DESC, s.sample_id COLLATE "C" DESC LIMIT 1
 ), g AS (
  SELECT s.* FROM stored s JOIN newest n ON n.sid = s.sample_id
 ), per AS (
  -- A stratum's share is right over what the draw took from it: an item drawn and not graded is never right.
  SELECT g.stratum AS st, count(*)::integer AS graded, count(*) FILTER (WHERE g.verdict IN ('right', 'unsure'))::integer AS r,
         count(*) FILTER (WHERE g.verdict = 'wrong')::integer AS w, count(*) FILTER (WHERE g.verdict = 'unsure')::integer AS u,
         max(g.stratum_rows) AS rows_, max(g.stratum_drawn) AS drawn_
  FROM g GROUP BY g.stratum
 ), tot AS (
  SELECT max(g.as_of) AS as_of_, max(g.graded_at) AS graded_at_, count(*)::integer AS graded_, max(g.drawn) AS drawn_,
         max(g.population_rows) AS pop_rows, max(g.population_all) AS pop_all,
         count(*) FILTER (WHERE g.verdict IN ('right', 'unsure'))::integer AS r_, count(*) FILTER (WHERE g.verdict = 'wrong')::integer AS w_,
         count(*) FILTER (WHERE g.verdict = 'unsure')::integer AS u_
  FROM g
 ), raw AS (
  -- Unrounded shares. right_share is over the whole draw; a stratum's share is over what the draw took from it,
  -- weighted by its size at the draw (a stratum left out of the load entirely still lowers right_share).
  SELECT tot.*,
         CASE WHEN coalesce(tot.drawn_, 0) = 0 THEN NULL ELSE tot.r_::numeric / tot.drawn_ END AS rs,
         (SELECT sum(per.rows_::numeric * per.r / greatest(per.drawn_, per.graded)) / nullif(sum(per.rows_), 0) FROM per) AS ws,
         CASE WHEN coalesce(tot.pop_all, 0) = 0 THEN NULL ELSE tot.pop_rows::numeric / tot.pop_all END AS ps
  FROM tot
 ), st AS (
  SELECT jsonb_object_agg(per.st, jsonb_build_object('drawn', per.drawn_, 'graded', per.graded, 'right', per.r, 'wrong', per.w,
          'unsure', per.u, 'stratum_rows', per.rows_)) AS strata_
  FROM per
 )
 SELECT (SELECT n.sid FROM newest n), coalesce(p_population, 'customer_facing'), raw.as_of_, raw.graded_at_, raw.drawn_, raw.graded_,
        CASE WHEN raw.drawn_ IS NULL THEN NULL ELSE greatest(raw.drawn_ - raw.graded_, 0) END, raw.r_, raw.w_, raw.u_,
        CASE WHEN raw.rs IS NULL THEN NULL ELSE round(floor(round(raw.rs, 10) * 10000) / 10000, 4) END,
        CASE WHEN raw.ws IS NULL THEN NULL ELSE round(floor(round(raw.ws, 10) * 10000) / 10000, 4) END,
        CASE WHEN raw.ps IS NULL THEN NULL ELSE round(floor(round(raw.ps, 10) * 10000) / 10000, 4) END,
        CASE WHEN raw.rs IS NULL OR raw.ws IS NULL OR raw.ps IS NULL THEN NULL
             ELSE round(floor(round(least(raw.rs, raw.ws) * raw.ps, 10) * 10000) / 10000, 4) END,
        coalesce(st.strata_, '{}'::jsonb),
        (SELECT count(DISTINCT s.sample_id)::integer FROM stored s)
 FROM raw CROSS JOIN st
$fn$;

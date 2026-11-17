-- FU11: bound refollow candidate reads before the P2-01.8 cost-line backfill.
-- Same result and row-lock order; no trigger, schedule, switch or source write.
-- Index build follows the pending-marker migration's bounded lock pattern.
-- Parent lookup: job_cost_lines_document_idx; line followers: the index below;
-- document followers: job_cost_lines_follows_document_idx; final row: primary key.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE INDEX IF NOT EXISTS job_cost_lines_follows_line_idx
  ON public.job_cost_lines (follows_line_id);

COMMENT ON INDEX public.job_cost_lines_follows_line_idx IS
  'FU11: refollow children by parent line, and foreign-key checks on parent deletion.';

CREATE OR REPLACE FUNCTION public.job_cost_lines_refollow(p_document_kind text, p_document_id text)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.job_cost_lines%ROWTYPE; ids uuid[]; parts jsonb; total numeric;
  count_parts int; bad boolean; state text; rewritten int := 0; did_write boolean; BEGIN
  -- Each arm has its own access path. UNION keeps a follower that names both
  -- its parent line and document in this pass exactly once, as the old OR did.
  FOR f IN
    SELECT l.* FROM public.job_cost_lines l
    JOIN (
      SELECT child.id FROM public.job_cost_lines parent
      JOIN public.job_cost_lines child
        ON child.follows_line_id = parent.id AND child.org_id = parent.org_id
      WHERE parent.document_kind = p_document_kind AND parent.document_id = p_document_id
      UNION
      SELECT child.id FROM public.job_cost_lines child
      WHERE child.follows_document_kind = p_document_kind
        AND child.follows_document_id = p_document_id
    ) candidates ON candidates.id = l.id
    WHERE l.decided_by_kind IS DISTINCT FROM 'person' AND l.state IS NOT NULL
      -- Recheck the locked row too: its follow coordinates may have changed
      -- while this SELECT waited for another transaction's row lock.
      AND CASE WHEN l.follows_document_kind = p_document_kind
          AND l.follows_document_id = p_document_id THEN true
        ELSE EXISTS (SELECT 1 FROM public.job_cost_lines parent
          WHERE parent.id = l.follows_line_id AND parent.org_id = l.org_id
            AND parent.document_kind = p_document_kind AND parent.document_id = p_document_id)
        END
    ORDER BY (l.follows_line_id IS NULL), l.id FOR UPDATE OF l
  LOOP
    SELECT array_agg(l.id ORDER BY l.line_no, l.line_key COLLATE "C"),
      bool_or(l.state IS NULL OR l.state = 'needs_person' OR l.amount_ex IS NULL)
      INTO ids, bad FROM public.job_cost_lines l WHERE l.org_id = f.org_id
        AND (CASE WHEN f.follows_line_id IS NOT NULL THEN l.id = f.follows_line_id
          ELSE l.document_kind = f.follows_document_kind AND l.document_id = f.follows_document_id
            AND l.not_counted_reason IS DISTINCT FROM 'line_removed' END);
    SELECT sum(p.amount_ex) INTO total FROM public.job_cost_line_parts p WHERE p.line_id = ANY(ids);
    IF coalesce(bad,true) OR coalesce(total,0) = 0 OR f.amount_ex IS NULL THEN
      did_write := public.job_cost_lines_write_state(f.id, 'needs_person', '[]', 'source', NULL, 'follows_undecided');
    ELSE
      -- Keep source order and put the rounding remainder on the last part.
      WITH ordered AS (
        SELECT p.*, row_number() OVER (ORDER BY array_position(ids,p.line_id),p.part_no) AS n,
          count(*) OVER () AS cnt FROM public.job_cost_line_parts p WHERE p.line_id = ANY(ids)
      ), rounded AS (
        SELECT *, round(f.amount_ex * amount_ex / total,2) AS share FROM ordered
      ), apportioned AS (
        SELECT *, CASE WHEN n = cnt THEN f.amount_ex - coalesce(sum(share) OVER (
          ORDER BY n ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) ELSE share END AS amount
          FROM rounded
      ) SELECT count(*), jsonb_agg(jsonb_build_object('target',target,'job_id',job_id,
        'division',division,'lane',lane,'amount_ex',amount) ORDER BY n),
        CASE WHEN count(*) > 1 THEN 'split' WHEN min(target) = 'job' THEN 'on_job' ELSE min(target) END
        INTO count_parts, parts, state FROM apportioned;
      IF count_parts = 0 THEN
        did_write := public.job_cost_lines_write_state(f.id,'needs_person','[]','source',NULL,'follows_undecided');
      ELSE
        did_write := public.job_cost_lines_write_state(f.id,state,parts,'source',NULL,NULL);
      END IF;
    END IF;
    IF did_write THEN rewritten := rewritten + 1; END IF;
  END LOOP;
  RETURN rewritten;
END;
$$;

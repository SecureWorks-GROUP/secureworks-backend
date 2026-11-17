DROP TRIGGER IF EXISTS work_order_amount_change_profit ON public.work_order_amount_changes;
DROP FUNCTION IF EXISTS public.work_order_amount_change_profit();
-- P1-14.3. P0-09 expected-labour consolidation is not on this base.
-- The split writer uses the equivalent scalar-subquery spelling of the pot.
-- Expected inventory: release_state(uuid) one hit; write_split(uuid,boolean) one hit.
DO $patch$
DECLARE item record; def text; old_text text; new_text text; hits integer;
BEGIN
  FOR item IN SELECT p.oid::regprocedure AS signature
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prokind='f'
      AND (p.prosrc LIKE '%COALESCE(g.approved_budget_ex, wo.agreed_labour_ex)%'
        OR p.prosrc LIKE '%COALESCE((SELECT g.approved_budget_ex FROM public.group_work_orders g WHERE g.id=p_group_id),wo.agreed_labour_ex)%')
  LOOP
    IF item.signature::text NOT IN ('group_work_order_release_state(uuid)','group_work_order_write_split(uuid,boolean)') THEN
      RAISE EXCEPTION 'work_order_change_pot_unexpected_function: %',item.signature;
    END IF;
    RAISE NOTICE 'work order pot inventory: %, expected hits 1', item.signature;
  END LOOP;
  FOR item IN SELECT * FROM (VALUES
    ('public.group_work_order_release_state(uuid)', 'COALESCE(g.approved_budget_ex, wo.agreed_labour_ex + public.work_order_amount_change_total(wo.id))', 'COALESCE(g.approved_budget_ex, wo.agreed_labour_ex)'),
    ('public.group_work_order_write_split(uuid,boolean)', 'COALESCE((SELECT g.approved_budget_ex FROM public.group_work_orders g WHERE g.id=p_group_id),wo.agreed_labour_ex + public.work_order_amount_change_total(wo.id))', 'COALESCE((SELECT g.approved_budget_ex FROM public.group_work_orders g WHERE g.id=p_group_id),wo.agreed_labour_ex)')
  ) AS patches(signature,old_text,new_text)
  LOOP
    def:=pg_get_functiondef(item.signature::regprocedure);
    old_text:=item.old_text; new_text:=item.new_text;
    hits:=(length(def)-length(replace(def,old_text,'')))/length(old_text);
    IF hits=0 AND (length(def)-length(replace(def,new_text,'')))/length(new_text)=1 THEN CONTINUE; END IF;
    IF hits<>1 THEN RAISE EXCEPTION 'work_order_change_pot_hit_count: % got %',item.signature,hits; END IF;
    EXECUTE replace(def,old_text,new_text);
  END LOOP;
END $patch$;


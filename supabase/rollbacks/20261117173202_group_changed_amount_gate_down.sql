DO $patch$ DECLARE def text; old_text text:=$old$AND CASE WHEN EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name='work_order_amount_change_v1' AND enabled)
      THEN COALESCE((SELECT g.approved_budget_ex FROM public.group_work_orders g WHERE g.id=p_group_id),wo.agreed_labour_ex + public.work_order_amount_change_total(wo.id)) > 0
      ELSE wo.agreed_labour_ex > 0 END$old$; new_text text:=$new$AND wo.agreed_labour_ex > 0$new$; hits integer; BEGIN
  def:=pg_get_functiondef('public.group_work_order_write_split(uuid,boolean)'::regprocedure);
  hits:=(length(def)-length(replace(def,old_text,'')))/length(old_text);
  IF hits=0 AND strpos(def,new_text)>0 THEN RETURN; END IF;
  IF hits<>1 THEN RAISE EXCEPTION 'group_changed_amount_gate_hit_count: %',hits; END IF;
  EXECUTE replace(def,old_text,new_text);
END $patch$;

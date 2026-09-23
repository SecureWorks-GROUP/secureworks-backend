-- Ship the mode parser failing OPEN: the apply row alone turns the sweep on in
-- apply, with money_open_book_v1 missing. Everything else about the reading is
-- right, so the contract's "apply needs money_open_book_v1" check is the one
-- that must catch it.
CREATE OR REPLACE FUNCTION public.context_money_open_book_mode() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE base boolean; appl boolean;
BEGIN
 SELECT f.enabled INTO base FROM public.feature_flags f WHERE f.flag_name='money_open_book_v1';
 SELECT f.enabled INTO appl FROM public.feature_flags f WHERE f.flag_name='money_open_book_apply_v1';
 RETURN jsonb_build_object('mode',CASE WHEN coalesce(appl,false) THEN 'apply' WHEN coalesce(base,false) THEN 'observe' ELSE 'off' END,
  'state',CASE WHEN base IS NULL THEN 'missing' ELSE 'present' END,'since',NULL,'flags','{}'::jsonb);
END $$;

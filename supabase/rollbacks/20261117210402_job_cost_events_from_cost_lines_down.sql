-- Remove only this ticket's installed hooks. No switch is changed or deleted:
-- P2-01.1 owns the cost-lines flag, and the budget migration owns its flag.
SET LOCAL lock_timeout='5s';
SET LOCAL TimeZone='UTC';
SELECT public.remove_job_cost_events_from_cost_lines();

-- PostgreSQL cannot remove appended view columns with CREATE OR REPLACE.
-- Keep dependent ordinary views byte-for-byte, including owner, relation ACL,
-- options and comments. Drop without CASCADE: an unsupported dependent object
-- refuses the whole rollback rather than silently losing it.
DO $restore$
DECLARE v record; acl_entry record; c record; f record; legacy text;
/* block */ BEGIN
 legacy:=pg_get_viewdef('public.v_job_cost_events_legacy'::regclass,true);
 IF md5(legacy)<>'b48997c55913ce3c90e3a3c947533fd3'
 OR strpos(pg_get_viewdef('public.v_job_cost_events'::regclass,true),'v_job_cost_events_lines')=0 THEN
  RAISE EXCEPTION 'P2-01.7 rollback: cost events pre-image differs';
 END IF;
 CREATE TEMP TABLE cost_events_restore_views ON COMMIT DROP AS
 WITH RECURSIVE deps(oid,depth,path) AS (
  SELECT 'public.v_job_cost_events'::regclass::oid,0,ARRAY['public.v_job_cost_events'::regclass::oid]
  UNION ALL
  SELECT r.ev_class,d.depth+1,d.path||r.ev_class
  FROM deps d JOIN pg_depend p ON p.refclassid='pg_class'::regclass AND p.refobjid=d.oid AND p.classid='pg_rewrite'::regclass
  JOIN pg_rewrite r ON r.oid=p.objid JOIN pg_class k ON k.oid=r.ev_class
  WHERE k.relkind='v' AND NOT r.ev_class=ANY(d.path)
 )
 SELECT k.oid,max(d.depth) depth,n.nspname,k.relname,pg_get_viewdef(k.oid,true) def,
 pg_get_userbyid(k.relowner) owner,k.relacl,k.reloptions,obj_description(k.oid,'pg_class') comment
 FROM deps d JOIN pg_class k ON k.oid=d.oid JOIN pg_namespace n ON n.oid=k.relnamespace
 GROUP BY k.oid,n.nspname,k.relname,k.relowner,k.relacl,k.reloptions;
 CREATE TEMP TABLE cost_events_restore_columns ON COMMIT DROP AS
 SELECT t.oid,a.attname,col_description(t.oid,a.attnum) comment,a.attacl
 FROM cost_events_restore_views t JOIN pg_attribute a ON a.attrelid=t.oid
 WHERE a.attnum>0 AND NOT a.attisdropped
 AND NOT (t.depth=0 AND a.attname IN ('cost_line_id','cost_kind'));
 -- No unchecked column grant is lost by a view rebuild.
 IF EXISTS(SELECT 1 FROM cost_events_restore_columns WHERE attacl IS NOT NULL) THEN
  RAISE EXCEPTION 'P2-01.7 rollback: column grants require explicit preservation';
 END IF;
 -- A legacy RPC returns the profit view's composite type. Preserve that
 -- unchanged function too; otherwise PostgreSQL correctly refuses DROP VIEW.
 CREATE TEMP TABLE cost_events_restore_functions ON COMMIT DROP AS
 SELECT p.oid,n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args,oidvectortypes(p.proargtypes) reg_args,
 pg_get_functiondef(p.oid) def,pg_get_userbyid(p.proowner) owner,p.proacl,
 obj_description(p.oid,'pg_proc') comment
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE p.prorettype IN (SELECT k.reltype FROM pg_class k JOIN cost_events_restore_views t ON t.oid=k.oid);
 FOR f IN SELECT * FROM cost_events_restore_functions ORDER BY oid LOOP
  EXECUTE format('DROP FUNCTION %I.%I(%s)',f.nspname,f.proname,f.args);
 END LOOP;
 FOR v IN SELECT * FROM cost_events_restore_views ORDER BY depth DESC,oid LOOP
  EXECUTE format('DROP VIEW %I.%I',v.nspname,v.relname);
 END LOOP;
 FOR v IN SELECT * FROM cost_events_restore_views ORDER BY depth,oid LOOP
  EXECUTE format('CREATE VIEW %I.%I %s AS %s',v.nspname,v.relname,
   CASE WHEN v.reloptions IS NULL THEN '' ELSE 'WITH ('||array_to_string(v.reloptions,',')||')' END,
   CASE WHEN v.depth=0 THEN legacy ELSE v.def END);
  EXECUTE format('ALTER VIEW %I.%I OWNER TO %I',v.nspname,v.relname,v.owner);
  -- Revoke default privileges too, before reproducing the saved ACL.
  FOR acl_entry IN SELECT DISTINCT grantee FROM aclexplode(coalesce(
   (SELECT relacl FROM pg_class WHERE oid=to_regclass(format('%I.%I',v.nspname,v.relname))),
   acldefault('r',(SELECT oid FROM pg_roles WHERE rolname=v.owner)))) LOOP
   EXECUTE format('REVOKE ALL ON %I.%I FROM %s',v.nspname,v.relname,
    CASE WHEN acl_entry.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(acl_entry.grantee)) END);
  END LOOP;
  FOR acl_entry IN SELECT * FROM aclexplode(coalesce(v.relacl,acldefault('r',(SELECT oid FROM pg_roles WHERE rolname=v.owner)))) LOOP
   EXECUTE format('GRANT %s ON %I.%I TO %s%s',acl_entry.privilege_type,v.nspname,v.relname,
    CASE WHEN acl_entry.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(acl_entry.grantee)) END,
    CASE WHEN acl_entry.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
  EXECUTE format('COMMENT ON VIEW %I.%I IS %L',v.nspname,v.relname,v.comment);
  FOR c IN SELECT * FROM cost_events_restore_columns WHERE oid=v.oid AND comment IS NOT NULL LOOP
   EXECUTE format('COMMENT ON COLUMN %I.%I.%I IS %L',v.nspname,v.relname,c.attname,c.comment);
  END LOOP;
 END LOOP;
 FOR f IN SELECT * FROM cost_events_restore_functions ORDER BY oid LOOP
  EXECUTE f.def;
  EXECUTE format('ALTER FUNCTION %I.%I(%s) OWNER TO %I',f.nspname,f.proname,f.args,f.owner);
  FOR acl_entry IN SELECT DISTINCT grantee FROM aclexplode(coalesce(
   (SELECT proacl FROM pg_proc WHERE oid=to_regprocedure(format('%I.%I(%s)',f.nspname,f.proname,f.reg_args))),
   acldefault('f',(SELECT oid FROM pg_roles WHERE rolname=f.owner)))) LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM %s',f.nspname,f.proname,f.args,
    CASE WHEN acl_entry.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(acl_entry.grantee)) END);
  END LOOP;
  FOR acl_entry IN SELECT * FROM aclexplode(coalesce(f.proacl,acldefault('f',(SELECT oid FROM pg_roles WHERE rolname=f.owner)))) LOOP
   EXECUTE format('GRANT %s ON FUNCTION %I.%I(%s) TO %s%s',acl_entry.privilege_type,f.nspname,f.proname,f.args,
    CASE WHEN acl_entry.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(acl_entry.grantee)) END,
    CASE WHEN acl_entry.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
  EXECUTE format('COMMENT ON FUNCTION %I.%I(%s) IS %L',f.nspname,f.proname,f.args,f.comment);
 END LOOP;
END $restore$;
DROP VIEW public.v_job_cost_events_lines;
DROP VIEW public.v_job_cost_events_legacy;
DROP TABLE public.job_cost_events_cutover;
ALTER TABLE public.job_cost_events_stored DROP COLUMN cost_line_id,DROP COLUMN cost_kind;
DROP FUNCTION public.install_job_cost_events_from_cost_lines();
DROP FUNCTION public.remove_job_cost_events_from_cost_lines();
DROP FUNCTION public.job_cost_events_dirty_trg();
DROP FUNCTION public.job_cost_events_switch_dirty_trg();
DROP FUNCTION public.job_cost_events_mark_job(uuid);

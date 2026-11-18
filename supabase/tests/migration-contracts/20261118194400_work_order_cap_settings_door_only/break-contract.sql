-- Break: the service role gets UPDATE back through a role it belongs to, which the
-- migration's re-apply does not take away.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zz_break_cap_settings_writer') THEN
    CREATE ROLE zz_break_cap_settings_writer NOLOGIN;
  END IF;
END $$;
GRANT UPDATE ON TABLE public.work_order_cap_settings TO zz_break_cap_settings_writer;
GRANT zz_break_cap_settings_writer TO service_role;

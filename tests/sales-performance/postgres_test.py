"""Real SQL/RLS and row-lock proof in an EMPTY, disposable LOCAL database.

Requires existing psql and PostgreSQL roles anon/authenticated/service_role.
Never creates a database or server. Usage: python3 .../postgres_test.py sales_performance_test_<suffix>
Optional second argument is a local TCP port (postgres user, 127.0.0.1 only).
Without it, uses the local Unix socket. Drops nothing.
"""
import os
from pathlib import Path
import re
import subprocess
import sys
import time

if len(sys.argv) not in (2, 3) or not re.fullmatch(r"sales_performance_test_[a-z0-9_]+", sys.argv[1]):
    raise SystemExit("Pass an empty local database named sales_performance_test_<suffix>")
env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
env.update(PGDATABASE=sys.argv[1], PGCONNECT_TIMEOUT="3")
if len(sys.argv) == 3:
    if not sys.argv[2].isdigit() or not 1024 <= int(sys.argv[2]) <= 65535:
        raise SystemExit("Local TCP port must be between 1024 and 65535")
    env.update(PGHOST="127.0.0.1", PGPORT=sys.argv[2], PGUSER="postgres")
command = ["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1"]

def sql(source, ok=True):
    result = subprocess.run(command, input=source, text=True, capture_output=True, env=env)
    if (result.returncode == 0) != ok:
        raise AssertionError(result.stderr or result.stdout)
    return result.stdout.strip()

assert sql("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'") == "0", "Database must be empty"
assert sql("SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')") == "3", "Local Supabase roles required"
sql("""
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  'SELECT nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
  'SELECT nullif(current_setting(''request.jwt.claim.role'', true), '''')';
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
CREATE TABLE public.organisations(id uuid PRIMARY KEY);
CREATE TABLE public.users(id uuid PRIMARY KEY, org_id uuid, role text, name text);
GRANT SELECT ON public.users TO authenticated;
INSERT INTO public.organisations VALUES
 ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002');
INSERT INTO public.users VALUES
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','owner','Sample Captain'),
 ('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002','ops_manager','Other Captain'),
 ('10000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','installer','Sample Trade');
""")
root = Path(__file__).resolve().parents[2]
sql((root / "supabase/migrations/20260911000001_sales_performance_weeks.sql").read_text())

def auth(role, user=None):
    return f"SET ROLE {role}; SET request.jwt.claim.role='{role}'; SET request.jwt.claim.sub='{user or ''}';"

service = auth('service_role')
owner = auth('authenticated', '10000000-0000-0000-0000-000000000001')
other = auth('authenticated', '10000000-0000-0000-0000-000000000002')
trade = auth('authenticated', '10000000-0000-0000-0000-000000000003')

def write(run='run-1', org='00000000-0000-0000-0000-000000000001', week='2026-08-31', lane='fencing', coverage='{"gaps":[],"collection_complete":true}'):
    return f"SELECT public.sales_performance_write_v1('{org}','{week}','{lane}','{{\"enquiries\":null}}','{coverage}','{{}}','{run}','v1','2026-09-07T00:00:00Z');"

def note(text='Coaching'):
    return f"SELECT public.sales_performance_note_v1('2026-08-31','fencing','{text}');"

sql(service + write())
sql(service + write(org='00000000-0000-0000-0000-000000000002'))
assert sql(owner + 'SELECT count(*) FROM public.sales_performance_weeks;') == '1'
assert sql(other + 'SELECT count(*) FROM public.sales_performance_weeks;') == '1'
assert sql(trade + 'SELECT count(*) FROM public.sales_performance_weeks;') == '0'
for identity in [owner, other, trade, auth('anon')]:
    sql(identity + write(), ok=False)
for identity in [trade, service, auth('anon')]:
    sql(identity + note(), ok=False)
sql(owner + "UPDATE public.sales_performance_weeks SET metrics='{}';", ok=False)
sql(owner + "SELECT public.sales_performance_note_v1('2026-08-24','fencing','missing');", ok=False)
for kwargs in [dict(week='2026-09-01'), dict(lane='roofing'), dict(coverage='{}'), dict(coverage='{"gaps":[],"collection_complete":false}')]:
    sql(service + write(**kwargs), ok=False)
sql(owner + note())
sql(service + write(run='run-2'))
assert sql(owner + "SELECT notes->>'text' FROM public.sales_performance_weeks;") == 'Coaching'
assert sql(owner + "SELECT notes->>'author_name' FROM public.sales_performance_weeks;") == 'Sample Captain'
assert sql(other + "SELECT notes IS NULL FROM public.sales_performance_weeks;") == 't'

# Hold the first mutation's row lock, observe the second backend waiting on that
# lock, then commit. Repeat both directions; this is actual concurrent PostgreSQL.
for first, second in [(owner + note('race-note'), service + write('race-run')),
                      (service + write('race-run'), owner + note('race-note'))]:
    holder = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    waiter = None
    try:
        holder.stdin.write('BEGIN;\n' + first + '\n\\echo LOCK_HELD\n')
        holder.stdin.flush()
        while holder.stdout.readline().strip() != 'LOCK_HELD':
            if holder.poll() is not None:
                raise AssertionError(holder.stderr.read())
        waiter = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        waiter.stdin.write("SET application_name='sales_performance_lock_test';\n" + second)
        waiter.stdin.close()
        deadline = time.monotonic() + 5
        while sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='sales_performance_lock_test' AND wait_event_type='Lock'") != '1':
            if time.monotonic() > deadline:
                raise AssertionError('second mutation did not wait for the row lock')
            time.sleep(0.05)
        holder.stdin.write('COMMIT;\n\\q\n')
        holder.stdin.flush()
        assert holder.wait(timeout=5) == 0, holder.stderr.read()
        assert waiter.wait(timeout=5) == 0, waiter.stderr.read()
    finally:
        for process in [holder, waiter]:
            if process and process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
    assert sql(owner + "SELECT run_id || '/' || (notes->>'text') FROM public.sales_performance_weeks;") == 'race-run/race-note'
print('PASS: PostgreSQL constraints, role grants, tenant RLS, note attribution, rerun preservation, both real lock interleavings')

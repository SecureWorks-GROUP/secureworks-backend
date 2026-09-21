#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
import os, subprocess
url = os.environ['CONTRACT_DATABASE_URL']
# Two real transactions race for one person across independent request keys.
# Hold the winning transaction open so both requests must traverse the lock.
procs = []
for key in ['race-a', 'race-b']:
    query = f"""BEGIN; SET LOCAL ROLE service_role;
SELECT public.reserve_ghl_calendar_appointment('concurrency-fixture','{key}',repeat('a',64),'person',
  date_trunc('day',now())+interval '2 days',date_trunc('day',now())+interval '2 days 1 hour',gen_random_uuid())->>'decision';
SELECT pg_sleep(0.25); COMMIT;"""
    procs.append(subprocess.Popen(['psql',url,'-X','-qAt','-v','ON_ERROR_STOP=1','-c',query], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
results=[]
for proc in procs:
    out, err = proc.communicate(timeout=10)
    assert proc.returncode == 0, err
    results.extend(line for line in out.splitlines() if line)
assert sorted(results) == ['acquired','overlap'], results
subprocess.run(['psql',url,'-X','-v','ON_ERROR_STOP=1','-c',"DELETE FROM public.ghl_calendar_appointment_requests WHERE location_id='concurrency-fixture'"],check=True)
PY

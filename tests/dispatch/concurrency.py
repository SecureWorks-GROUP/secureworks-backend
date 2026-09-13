"""Run after fixture/persistence/workflow SQL against the isolated local DB only."""
import os
import subprocess
import time

psql = os.environ.get('DISPATCH_TEST_PSQL', '/opt/homebrew/opt/postgresql@17/bin/psql')
args = [psql, '-h', '127.0.0.1', '-p', '55581', '-d', 'dispatch_test3', '-v', 'ON_ERROR_STOP=1', '-At']
org = '00000000-0000-4000-8000-000000000001'
job1 = '10000000-0000-4000-8000-000000000002'
job2 = '10000000-0000-4000-8000-000000000004'
subprocess.run(args + ['-c', f"insert into jobs(id,org_id,status) values('{job2}','{org}','scheduled')"], check=True, capture_output=True)

def commit(job, request, reservation, expected):
    return f"select dispatch_commit('{org}','{job}',{expected},'{request}','{request}','fixture','allocation_upsert',dispatch_source_version('{org}','{job}'),'{{\"allocations\":[{{\"id\":\"{reservation}\",\"requirement_id\":\"40000000-0000-4000-8000-000000000001\",\"supply_id\":\"po:fixture:0\",\"quantity\":4,\"unit\":\"each\"}}]}}');"
first_sql = "begin; set role service_role; " + commit(job1,'20000000-0000-4000-8000-000000000020','30000000-0000-4000-8000-000000000020',1) + " select pg_sleep(1); commit;"
second_sql = "set role service_role; " + commit(job2,'20000000-0000-4000-8000-000000000021','30000000-0000-4000-8000-000000000021',0)
first = subprocess.Popen(args + ['-c', first_sql], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
time.sleep(.15)
second = subprocess.Popen(args + ['-c', second_sql], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
out1, err1 = first.communicate(timeout=15)
out2, err2 = second.communicate(timeout=15)
assert first.returncode == 0, err1
assert second.returncode != 0 and 'supply_overallocated' in err2, (out2, err2)
count = subprocess.run(args + ['-c', 'select sum(quantity) from dispatch_reservations'], check=True,capture_output=True,text=True).stdout.strip()
assert count == '10', count
print('PASS: concurrent jobs compete for final four units; one commit, one refusal, total exactly ten.')

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { addMyselfToJob, jobsNearMe, SelfAddError } from './trade_self_add.ts';
import { createAssignment, prepareClockEventAssignment, resolveTradeJobAccessTier, myHours, tradeCalendarEvents, searchAllJobs, myJobs } from './index.ts';

import { readMyGroupWorkOrders } from './group_work_order.ts';
import { _resetSwitchCacheForTest } from '../_shared/switch_cache.ts';

const actor = { id: 'trade-1', orgId: 'org-1' };
const today = '2026-11-18';
const job = { id: 'job-1', org_id: actor.orgId, job_number: 'ZZTEST-1612', type: 'miscellaneous', status: 'scheduled', site_suburb: 'ZZTEST', site_lat: 0.0027, site_lng: 0 };

function store() {
  const db: Record<string, any[]> = { jobs: [{ ...job }], feature_flags: [{ flag_name: 'trade_self_add_v1', enabled: true }], job_assignments: [], users: [], job_events: [] };
  const writes: any[] = [];
  const errors: Record<string, any> = {};
  const client: any = {
    db, writes, errors,
    rpc: () => Promise.resolve({ data: null, error: null }),
    from(table: string) {
      const filters: ((r: any) => boolean)[] = [];
      let action = 'read', payload: any, single = false, start = 0, end = Infinity;
      const q: any = {
        select() { return q; },
        eq(k: string, v: any) { filters.push(r => k.split('.').reduce((value, key) => value?.[key], r) === v); return q; },
        neq(k: string, v: any) { filters.push(r => r[k] != null && r[k] !== v); return q; },
        gte(k: string, v: any) { filters.push(r => r[k] != null && r[k] >= v); return q; },
        lte(k: string, v: any) { filters.push(r => r[k] != null && r[k] <= v); return q; },
        in(k: string, v: any[]) { filters.push(r => v.includes(r[k])); return q; },
        not(k: string, op: string, v: string) { if(op === 'in') filters.push(r => !v.slice(1,-1).split(',').includes(r[k])); return q; },
        or(expression: string) {
          filters.push(r => expression.split(',').some(term => {
            const [k, op, ...parts] = term.split('.'); const v = parts.join('.');
            return op === 'is' ? r[k] == null : op === 'neq' ? r[k] != null && String(r[k]) !== v : String(r[k]) === v;
          })); return q;
        },
        is(k: string, v: any) { filters.push(r => r[k] == v); return q; },
        order() { return q; }, range(a: number, b: number) { start = a; end = b; return q; }, limit(n: number) { end = n - 1; return q; },
        maybeSingle() { single = true; return q; }, single() { single = true; return q; },
        insert(value: any) { action = 'insert'; payload = value; return q; },
        update(value: any) { action = 'update'; payload = value; return q; },
        delete() { action = 'delete'; return q; },
        then(resolve: any, reject: any) {
          try {
            if (errors[table]) return Promise.resolve({ data: null, error: errors[table] }).then(resolve, reject);
            let rows = (db[table] || []).filter(r => filters.every(f => f(r))).slice(start, end + 1);
            if(action === 'insert') {
              const values = Array.isArray(payload) ? payload : [payload];
              rows = values.map(v => ({ id: `${table}-${(db[table] || []).length}`, is_ghost: false, is_lead: false, added_by: 'office', ...v }));
              db[table] ||= []; db[table].push(...rows); writes.push({ table, payload });
            } else if(action === 'update') { rows.forEach(r => Object.assign(r, payload)); writes.push({ table, payload }); }
            return Promise.resolve({ data: single ? rows[0] || null : rows, error: null }).then(resolve, reject);
          } catch(e) { return Promise.reject(e).then(resolve, reject); }
        },
      };
      return q;
    },
  };
  return client;
}
function deps(client: any, extra: any = {}) {
  return { today, createAssignment: (b: any) => createAssignment(client, b), isUserDateConflict: (e: any) => e?.code === '23505', enrollGroup: () => Promise.resolve(), ...extra };
}

Deno.test('unaccepted and refused self-bookings grant no job detail; acceptance and office booking do', async () => {
  const c = store();
  c.db.job_assignments.push({ id: 'assignment-1', job_id: job.id, user_id: actor.id, status: 'scheduled', is_ghost: false, added_by: 'self', self_added_status: 'added' });
  const access = () => resolveTradeJobAccessTier(c, job.id, actor.id, { access: { orgId: actor.orgId } });
  assertEquals((await access()).tier, 'none');
  c.db.job_assignments[0].self_added_status = 'not_accepted';
  assertEquals((await access()).tier, 'none');
  c.db.job_assignments[0].self_added_status = 'accepted';
  assertEquals((await access()).tier, 'allocated');
  c.db.job_assignments[0].added_by = 'office';
  c.db.job_assignments[0].self_added_status = null;
  assertEquals((await access()).tier, 'allocated');
  c.errors.job_assignments = { message: 'read failed' };
  await assertRejects(access);
});

Deno.test('nearby discovery is contact-free, nearest five, within 1km and same company only', async () => {
  const c = store();
  // These sentinel keys must not appear even if a reader accidentally widens its select.
  Object.assign(c.db.jobs[0], { client_name: 'PRIVATE', client_phone: 'PRIVATE', client_email: 'PRIVATE', site_address: 'PRIVATE', metadata: { contact: 'PRIVATE' } });
  c.db.jobs.push({ ...job, id: 'far', site_lat: 0.05 }, { ...job, id: 'foreign', org_id: 'org-2' }, { ...job, id: 'cancelled', status: 'cancelled' });
  for(let n=1;n<7;n++) c.db.jobs.push({ ...job, id: `near-${n}`, site_lat: 0.003 + n / 10000 });
  const result = await jobsNearMe(c, new URLSearchParams({ lat: '0', lng: '0' }), actor);
  assertEquals(result.jobs.length, 5);
  assertEquals(result.jobs[0].id, job.id);
  assertEquals(result.jobs[0].distance_m, 300);
  assertEquals(Object.keys(result.jobs[0]).sort(), ['distance_m', 'id', 'job_number', 'site_suburb', 'type']);
  assert(!JSON.stringify(result).includes('PRIVATE'));
  assertEquals(c.writes.length, 0);
  for(const params of ['', 'lat=x&lng=0', 'lat=0&lng=', 'lat=91&lng=0']) {
    const e = await assertRejects(() => jobsNearMe(c, new URLSearchParams(params), actor), SelfAddError);
    assertEquals(e.code, 'position_required');
  }
});

Deno.test('switch off or unreadable refuses both new actions before a write', async () => {
  const c = store(); c.db.feature_flags[0].enabled = false;
  for(const fault of [false, true]) {
    if(fault) { c.errors.feature_flags = { message: 'failed' }; _resetSwitchCacheForTest(); }
    for(const run of [() => jobsNearMe(c, new URLSearchParams('lat=0&lng=0'), actor), () => addMyselfToJob(c, { job_id: job.id }, actor, deps(c))]) {
      const e = await assertRejects(run, SelfAddError); assertEquals(e.code, 'self_add_switch_off');
    }
  }
  assertEquals(c.writes.length, 0);
});

Deno.test('self-add uses the real office writer, remains non-lead, clockable, and sends no text or CRM fields', async () => {
  const c = store(); c.db.jobs[0].ghl_opportunity_id = 'opportunity-1';
  const requests: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: any) => { requests.push(String(input)); return Promise.resolve(new Response('{}')); }) as typeof fetch;
  try {
    const response = await addMyselfToJob(c, { job_id: job.id, userId: 'other', role: 'lead_installer', self_added: false }, actor, deps(c));
    assertEquals(response.already_on, false);
    const booking = c.db.job_assignments[0];
    assertEquals([booking.user_id, booking.added_by, booking.self_added_status, booking.role, booking.is_lead], [actor.id, 'self', 'added', 'installer', false]);
    assertEquals(c.db.jobs[0].status, 'scheduled');
    assertEquals(c.db.job_events[0].detail_json.self_added, true);
    assertEquals(requests.filter(x => /ghl-proxy|send.sms/.test(x)), []);
    // Real clock gate checks ownership; self-added does not grant contact access.
    const clock = await prepareClockEventAssignment(c, response.assignment_id, actor.id, undefined, 'clock_on');
    assertEquals(clock.assignment.id, booking.id);
    const writes = c.writes.length;
    const again = await addMyselfToJob(c, { job_id: job.id }, actor, deps(c));
    assertEquals(again.already_on, true);
    assertEquals(c.db.job_assignments.length, 1);
    assertEquals(c.writes.length, writes);
    // Without the self-added marker the old office request still pushes its schedule.
    const office = store(); office.db.jobs[0].ghl_opportunity_id = 'opportunity-1';
    await createAssignment(office, { jobId: job.id, userId: actor.id, scheduledDate: today, suppress_notifications: true });
    assertEquals(office.db.job_assignments[0].added_by, 'office');
    assertEquals(office.db.job_assignments[0].role, 'lead_installer');
    assert(requests.some(x => x.includes('update_custom_fields')));
  } finally { globalThis.fetch = original; }
});

Deno.test('invalid day, foreign or closed job and failed read create no booking; retry after refusal works', async () => {
  const c = store();
  for(const day of ['2026-11-19', '2026-11-15', 'invalid', '2026-11-00']) {
    const e = await assertRejects(() => addMyselfToJob(c, { job_id: job.id, day }, actor, deps(c)), SelfAddError);
    assertEquals(e.code, 'self_add_day_invalid');
  }
  for(const state of ['cancelled', 'lost', 'draft', 'quoted']) {
    c.db.jobs[0].status = state;
    const e = await assertRejects(() => addMyselfToJob(c, { job_id: job.id }, actor, deps(c)), SelfAddError);
    assertEquals(e.code, 'self_add_job_not_live');
  }
  c.db.jobs[0].status = 'scheduled'; c.db.jobs[0].org_id = 'org-2';
  await assertRejects(() => addMyselfToJob(c, { job_id: job.id }, actor, deps(c)), SelfAddError);
  c.db.jobs[0].org_id = actor.orgId; c.errors.jobs = { message: 'failed' };
  await assertRejects(() => addMyselfToJob(c, { job_id: job.id }, actor, deps(c)));
  delete c.errors.jobs;
  assertEquals(c.writes.length, 0);
  const answer = await addMyselfToJob(c, { job_id: job.id, day: '2026-11-16' }, actor, deps(c, {
    createAssignment: (b: any) => { c.db.job_assignments.push({ id: 'won', user_id: b.userId, job_id: b.jobId, scheduled_date: b.scheduledDate, status: 'scheduled', is_ghost: false }); return Promise.resolve({ assignment: { id: 'won' } }); },
  }));
  assertEquals(answer.assignment_id, 'won');
});

Deno.test('concurrent insert returns winning row and group enrollment failure does not undo booking', async () => {
  const c = store();
  const answer = await addMyselfToJob(c, { job_id: job.id }, actor, deps(c, {
    createAssignment: (b: any) => {
      c.db.job_assignments.push({ id: 'winner', job_id: job.id, user_id: actor.id, scheduled_date: b.scheduledDate, status: null, is_ghost: false });
      return Promise.reject({ code: '23505' });
    }, enrollGroup: () => Promise.reject(new Error('unavailable')),
  }));
  assertEquals(answer.assignment_id, 'winner'); assertEquals(answer.already_on, true);
  assertEquals(c.db.job_assignments.length, 1);
  let enrolled = 0;
  const fresh = store();
  const dependencies = deps(fresh, {
    createAssignment: (b: any) => {
      const row = { id: 'created', job_id: job.id, user_id: actor.id, scheduled_date: b.scheduledDate, status: 'scheduled' };
      fresh.db.job_assignments.push(row);
      return Promise.resolve({ assignment: row });
    },
    enrollGroup: () => { enrolled++; return Promise.reject(new Error('unavailable')); },
  });
  assertEquals((await addMyselfToJob(fresh, { job_id: job.id }, actor, dependencies)).already_on, false);
  assertEquals(fresh.db.job_assignments.length, 1);
  assertEquals((await addMyselfToJob(fresh, { job_id: job.id }, actor, dependencies)).already_on, true);
  assertEquals(enrolled, 1, 'a duplicate press does not write group membership');
});

Deno.test('make-safe self-add and office allocation use the same current attendance cycle', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response('{}'))) as typeof fetch;
  try {
    for(const self of [true, false]) {
      const c = store(); c.db.jobs[0].type = 'makesafe';
      c.db.makesafe_job_details = [{ job_id: job.id, cycle_number: 2 }];
      c.db.makesafe_attendance_cycles = [{ id: 'cycle-2', job_id: job.id, cycle_number: 2 }];
      if(self) await addMyselfToJob(c, { job_id: job.id }, actor, deps(c));
      else await createAssignment(c, { jobId: job.id, userId: actor.id, scheduledDate: today, suppress_notifications: true });
      assertEquals(c.db.job_assignments.length, 1);
      assertEquals(c.db.job_assignments[0].attendance_cycle_id, 'cycle-2');
      assertEquals(c.db.job_assignments[0].cycle_attribution, 'bound');
    }
  } finally { globalThis.fetch = original; }
});

Deno.test('pending weekly card stays clockable and contact-free; calendar and search wait for acceptance', async () => {
  const c = store();
  c.db.users.push({ id: actor.id, org_id: actor.orgId, invoice_type: 'hourly', trade_details: {} });
  const booking = { id: 'assignment-1', job_id: job.id, user_id: actor.id, status: 'scheduled', is_ghost: false, added_by: 'self', self_added_status: 'added', scheduled_date: today, jobs: { ...job, client_name: 'PRIVATE', site_address: 'PRIVATE' } };
  c.db.job_assignments.push(booking);
  c.db.calendar_events = [{ assignment_id: booking.id, user_id: actor.id, org_id: actor.orgId, job_id: job.id, job_type: job.type, job_number: job.job_number, scheduled_date: today, assignment_status: 'scheduled', client_name: 'PRIVATE', site_address: 'PRIVATE' }];
  const viewer: any = { ...actor, role: 'installer', managedVerticals: [] };
  const week: any = await myHours(c, actor.id, new URLSearchParams('week_ending=2026-11-22'));
  assertEquals(week.self_add, true);
  assertEquals(week.assignments.length, 1);
  assertEquals(week.assignments[0].added_by_self, true);
  assertEquals(week.assignments[0].self_added_status, 'added');
  assert(!JSON.stringify(week).includes('PRIVATE'));
  const params = new URLSearchParams(`from=${today}&to=${today}`);
  assertEquals((await tradeCalendarEvents(c, params, viewer)).events, []);
  assertEquals((await searchAllJobs(c, new URLSearchParams(), viewer)).jobs, []);
  booking.self_added_status = 'accepted';
  assertEquals((await tradeCalendarEvents(c, params, viewer)).events.length, 1);
  booking.self_added_status = 'not_accepted';
  assertEquals((await tradeCalendarEvents(c, params, viewer)).events, []);
  c.errors.job_assignments = { message: 'failed' };
  await assertRejects(() => tradeCalendarEvents(c, params, viewer));
});

Deno.test('group discovery hides contact on a self-booked job until an office booking or acceptance permits it', async () => {
  const c = store();
  c.db.feature_flags.push({ flag_name: 'group_work_order_v1', enabled: true });
  c.db.jobs[0].client_name = 'PRIVATE';
  c.db.job_assignments.push({ id: 'assignment-1', job_id: job.id, user_id: actor.id, status: 'scheduled', is_ghost: false, added_by: 'self', self_added_status: 'added' });
  c.db.group_work_orders = [{ id: 'group-1', org_id: actor.orgId, job_id: job.id, status: 'active' }];
  const caller = { userId: actor.id, orgId: actor.orgId, isStaff: false };
  const before = await readMyGroupWorkOrders(c, caller);
  assertEquals(before.groups.length, 1);
  assert(!JSON.stringify(before).includes('PRIVATE'));
  c.db.job_assignments[0].self_added_status = 'accepted';
  const after = await readMyGroupWorkOrders(c, caller);
  assertEquals(after.groups[0].client_name, 'PRIVATE');
});

Deno.test('personal job cards hide pending or refused self-bookings and preserve accepted cards', async () => {
  const c = store();
  c.db.job_assignments.push({ id: 'assignment-1', job_id: job.id, user_id: actor.id, status: 'scheduled', is_ghost: false, added_by: 'self', self_added_status: 'added', scheduled_date: today, jobs: { ...job, client_name: 'PRIVATE' } });
  const list = () => myJobs(c, actor.id, false, false, false, [], [], actor.orgId);
  assert(!JSON.stringify(await list()).includes('PRIVATE'));
  c.db.job_assignments[0].self_added_status = 'not_accepted';
  assert(!JSON.stringify(await list()).includes('PRIVATE'));
  c.db.job_assignments[0].self_added_status = 'accepted';
  assert(JSON.stringify(await list()).includes('PRIVATE'));
});

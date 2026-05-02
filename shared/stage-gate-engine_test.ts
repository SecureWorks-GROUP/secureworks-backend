/* ════════════════════════════════════════════════════════════════
   stage-gate-engine_test.ts — Deno tests for the Cap 1C TS port

   Runs the same fixture set as the Cap 1B browser harness against
   the TS engine. Establishes parity between the JS browser engine
   (`securedash/modules/ops-stage-gate-engine.js`) and the Deno
   TS engine (`stage-gate-engine.ts`). Cap 1D will land an
   automated cross-runtime parity test; for Cap 1C we manually
   verify identical verdicts.

   Run:
     deno test --no-check --allow-env shared/stage-gate-engine_test.ts
   ════════════════════════════════════════════════════════════════ */

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { evaluateStageGates, canTransition, VERSION } from './stage-gate-engine.ts';

const NOW_ISO = '2026-05-02T00:00:00.000Z';

function inDays(days: number): string {
  const d = new Date(NOW_ISO);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function makePacket(parts: Record<string, unknown>): Record<string, unknown> {
  return {
    revision: parts.revision ?? null,
    document: parts.document ?? null,
    purchase_orders: parts.purchase_orders ?? [],
    work_order: parts.work_order ?? null,
    media: parts.media ?? [],
    events: parts.events ?? [],
    customer: parts.customer ?? { name: 'Customer A', email: 'a@example.com', mobile: '+61400000001', ghl_contact_id: 'ghl-A' },
    site: parts.site ?? { address: '12 Test St', suburb: 'Bayswater', lat: -31.92, lng: 115.92 },
    job: parts.job,
    staged: parts.staged ?? false,
  };
}

Deno.test('VERSION present', () => {
  assert(typeof VERSION === 'string' && VERSION.length > 0);
});

Deno.test('Fixture: patio_draft → current_stage=draft, frontend_bucket=quote', () => {
  const r = evaluateStageGates(
    { id: '20001', type: 'patio' },
    makePacket({
      revision: null,
      document: null,
      job: { id: '20001', job_number: 'SWP-20001', type: 'patio', status: 'draft', accepted_at: null, completed_at: null, quoted_at: null },
    }),
    { assignments: [], job_context: [], deposit: { deposit_paid: false } },
    { now: NOW_ISO },
  );
  assertEquals(r.current_stage, 'draft');
  assertEquals(r.frontend_bucket, 'quote');
  assertEquals(r.owner, 'sales');
});

Deno.test('Fixture: patio_quoted_awaiting_client → current_stage=quoted', () => {
  const r = evaluateStageGates(
    { id: '20002', type: 'patio' },
    makePacket({
      revision: { id: 'rev-20002', sent_at: inDays(-3), scope_snapshot: { council_required: false } },
      document: { accepted_at: null, declined_at: null },
      job: { id: '20002', job_number: 'SWP-20002', type: 'patio', status: 'quoted' },
    }),
    { assignments: [], job_context: [], deposit: { deposit_paid: false } },
    { now: NOW_ISO },
  );
  assertEquals(r.current_stage, 'quoted');
  assertEquals(r.frontend_bucket, 'waiting_client');
});

Deno.test('Fixture: fencing_partially_accepted_pending → blocker partial_acceptance_complete', () => {
  const r = evaluateStageGates(
    { id: '20003', type: 'fencing' },
    makePacket({
      revision: {
        id: 'rev-20003',
        sent_at: inDays(-5),
        scope_snapshot: {
          parties: [
            { id: 'p1', accepted_at: inDays(-2), declined_at: null },
            { id: 'p2', accepted_at: null, declined_at: null },
            { id: 'p3', accepted_at: null, declined_at: null },
          ],
        },
      },
      document: { accepted_at: null },
      job: { id: '20003', job_number: 'SWF-20003', type: 'fencing', status: 'partially_accepted' },
    }),
    { assignments: [], job_context: [], deposit: { deposit_paid: false } },
    { now: NOW_ISO },
  );
  assertEquals(r.current_stage, 'partially_accepted');
  const blockerIds = r.blockers.map((b) => b.gate_id);
  assert(blockerIds.includes('partial_acceptance_complete'));
});

Deno.test('Fixture: patio_awaiting_deposit → blocker deposit_paid', () => {
  const r = evaluateStageGates(
    { id: '20006', type: 'patio' },
    makePacket({
      revision: { id: 'rev-20006', sent_at: inDays(-9), scope_snapshot: { council_required: false } },
      document: { accepted_at: inDays(-4) },
      job: { id: '20006', type: 'patio', status: 'awaiting_deposit', accepted_at: inDays(-4) },
    }),
    { assignments: [], job_context: [], deposit: { deposit_paid: false } },
    { now: NOW_ISO },
  );
  const blockerIds = r.blockers.map((b) => b.gate_id);
  assert(blockerIds.includes('deposit_paid'));
});

Deno.test('Governance: deposit override (Marnin/Shaun bank-confirmed) flips fail→overridden', () => {
  const r = evaluateStageGates(
    { id: '20007', type: 'patio' },
    makePacket({
      revision: { id: 'rev-20007', sent_at: inDays(-9), scope_snapshot: { council_required: false } },
      document: { accepted_at: inDays(-4) },
      job: { id: '20007', type: 'patio', status: 'awaiting_deposit', accepted_at: inDays(-4) },
    }),
    {
      assignments: [],
      job_context: [
        { id: 'jc-7', kind: 'gate_override', value: { gate_id: 'deposit_paid', reason: 'Bank deposit confirmed via screenshot', by: 'marnin', by_role: 'marnin', reason_category: 'bank_confirmed' } },
      ],
      deposit: { deposit_paid: false },
    },
    { now: NOW_ISO },
  );
  const overrideIds = r.overrides.map((o) => o.gate_id);
  assert(overrideIds.includes('deposit_paid'), 'deposit_paid should appear in overrides[]');
});

Deno.test('Governance: patio approvals not_applicable when council_required=false', () => {
  const r = evaluateStageGates(
    { id: '20009', type: 'patio' },
    makePacket({
      revision: { id: 'rev-20009', sent_at: inDays(-12), scope_snapshot: { council_required: false, council_status: 'not_required' } },
      document: { accepted_at: inDays(-7) },
      job: { id: '20009', type: 'patio', status: 'awaiting_deposit', accepted_at: inDays(-7) },
    }),
    { assignments: [], job_context: [], deposit: { deposit_paid: true } },
    { now: NOW_ISO },
  );
  const councilGate = r.gates.find((g) => g.gate_id === 'council_approval_received');
  assert(councilGate, 'council_approval_received must be in gates[]');
  assertEquals(councilGate.status, 'not_applicable');
});

Deno.test('Governance: unknown future status routes to status_mapping_gap with confidence=low', () => {
  const r = evaluateStageGates(
    { id: '20021', type: 'patio' },
    makePacket({
      revision: { id: 'rev-20021', sent_at: inDays(-5), scope_snapshot: { council_required: false } },
      document: { accepted_at: inDays(-2) },
      job: { id: '20021', type: 'patio', status: 'waiting_on_some_new_stage', accepted_at: inDays(-2) },
    }),
    { assignments: [], job_context: [], deposit: { deposit_paid: false } },
    { now: NOW_ISO },
  );
  assertEquals(r.frontend_bucket, 'status_mapping_gap');
  assertEquals(r.confidence, 'low');
  const blockerIds = r.blockers.map((b) => b.gate_id);
  assert(blockerIds.includes('status_mapped_for_pipeline'));
});

Deno.test('canTransition: complete → draft is hard-blocked', () => {
  const ct = canTransition({ type: 'patio' }, 'complete', 'draft');
  assertEquals(ct.allowed, false);
  assertEquals(ct.hard_blocked, true);
});

Deno.test('canTransition: scheduled → order_confirmed is legal backward', () => {
  const ct = canTransition({ type: 'patio' }, 'scheduled', 'order_confirmed');
  assertEquals(ct.allowed, true);
  assertEquals(ct.direction, 'backward');
});

Deno.test('canTransition: cancelled → quoted requires Marnin/Shaun override + reason ≥12 chars', () => {
  const ctNoOverride = canTransition({ type: 'patio' }, 'cancelled', 'quoted');
  assertEquals(ctNoOverride.allowed, false);
  assertEquals(ctNoOverride.requires_override, true);

  const ctShortReason = canTransition({ type: 'patio' }, 'cancelled', 'quoted', { role: 'marnin', reason: 'too short' });
  assertEquals(ctShortReason.allowed, false);

  const ctValid = canTransition({ type: 'patio' }, 'cancelled', 'quoted', { role: 'marnin', reason: 'Client got new neighbour signed up - lets re-quote' });
  assertEquals(ctValid.allowed, true);
});

Deno.test('canTransition: fencing → approvals is type-illegal', () => {
  const ct = canTransition({ type: 'fencing' }, 'awaiting_deposit', 'approvals');
  assertEquals(ct.type_legal, false);
  assertEquals(ct.allowed, false);
  assertEquals(ct.hard_blocked, true);
});

Deno.test('canTransition: patio → partially_accepted is type-illegal', () => {
  const ct = canTransition({ type: 'patio' }, 'quoted', 'partially_accepted');
  assertEquals(ct.type_legal, false);
});

Deno.test('canTransition: any non-terminal → cancelled is always allowed', () => {
  const stages = ['quoted', 'accepted', 'awaiting_deposit', 'order_materials', 'scheduled', 'in_progress'];
  for (const from of stages) {
    const ct = canTransition({ type: 'patio' }, from, 'cancelled');
    assertEquals(ct.allowed, true, `${from} → cancelled should be allowed`);
  }
});

Deno.test('canTransition: archived is one-way (cannot transition out)', () => {
  const ct = canTransition({ type: 'patio' }, 'archived', 'quoted');
  assertEquals(ct.allowed, false);
  assertEquals(ct.hard_blocked, true);
});

Deno.test('Read-only purity: engine has no fetch / write surface', async () => {
  const src = await Deno.readTextFile(new URL('./stage-gate-engine.ts', import.meta.url));
  // Allow `evaluate(`, `fetch...` in comments only via word boundary check.
  const codeOnly = src
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
    .join('\n');
  assert(!/\bfetch\s*\(/.test(codeOnly), 'engine must not contain fetch(');
  assert(!/XMLHttpRequest/.test(codeOnly), 'engine must not reference XMLHttpRequest');
  assert(!/\.update\s*\(/.test(codeOnly), 'engine must not call .update(');
  assert(!/\.insert\s*\(/.test(codeOnly), 'engine must not call .insert(');
  assert(!/\.delete\s*\(/.test(codeOnly), 'engine must not call .delete(');
});

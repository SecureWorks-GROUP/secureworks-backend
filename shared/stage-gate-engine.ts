/* ════════════════════════════════════════════════════════════════
   stage-gate-engine.ts — Cap 1C Deno port of Cap 1B stage-gate engine

   TypeScript ESM port of `securedash/modules/ops-stage-gate-engine.js`
   for Deno consumers (ops-api, daily-digest, send-quote, ghl-*,
   xero-sync, reporting-api). Mirrors the JS engine 1:1 — same 19
   gates, same per-type transition graph, same applicability
   predicates, same governance encoding.

   Drift contract: this file is the canonical TS source. The JS
   browser version at `securedash/modules/ops-stage-gate-engine.js`
   must mirror this file's behaviour. Cap 1D will land an
   automated parity test running the same fixtures against both
   versions and asserting identical StageGateResult shape.

   Pure: no fetch, no DOM, no globals, no I/O. Returns a verdict
   object — never mutates state. Any consumer (e.g. shadow-mode
   wrapper) must wrap calls in try/catch and treat throws as
   "shadow eval failed; observation logged but transition
   continues".

   Authority:
   - secureworks-docs/operations/cap-1-stage-gate-contract.md
   - secureworks-docs/cio/evidence/cap1b-stage-gate-engine-2026-05-02/
   ════════════════════════════════════════════════════════════════ */

import {
  STATUS_MAP,
  isLegalForType,
  getStagesForType,
  mapStatus,
  type CanonicalStatus,
  type JobType,
  type StageOwner,
  type JarvisPosture,
} from './job-state-machine.ts';

// ══════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════

export type GateStatus =
  | 'pass'
  | 'fail'
  | 'unknown'
  | 'not_applicable'
  | 'overridden'
  | 'deferred';

export type GateSeverity = 'blocker' | 'warning' | 'informational' | 'deferred';

export type GateFamily =
  | 'system'
  | 'cap0_release'
  | 'acceptance'
  | 'packet'
  | 'compliance'
  | 'finance'
  | 'materials'
  | 'logistics'
  | 'crew'
  | 'install'
  | 'client';

export type StageFamilyName =
  | 'quote'
  | 'acceptance'
  | 'pre_install_finance'
  | 'pre_install_compliance'
  | 'materials'
  | 'install'
  | 'closeout'
  | 'terminal';

export interface GateEvidence {
  source: string | null;
  ref: string | null;
  // deno-lint-ignore no-explicit-any
  value: any;
}

export interface GateResult {
  gate_id: string;
  status: GateStatus;
  severity: GateSeverity;
  family: GateFamily;
  owner: StageOwner;
  evidence: GateEvidence;
  reason: string;
  next_action: string | null;
  override_available: boolean;
  // deno-lint-ignore no-explicit-any
  override: any;
}

export interface JobLike {
  id?: string | null;
  job_number?: string | null;
  type?: JobType | string | null;
  status?: string | null;
}

// Release-packet shape per T1 contract (loose typing — engine reads
// optional fields and tolerates missing).
// deno-lint-ignore no-explicit-any
export type ReleasePacket = any;

export interface SupplementalBlob {
  // deno-lint-ignore no-explicit-any
  assignments?: any[];
  // deno-lint-ignore no-explicit-any
  job_context?: any[];
  deposit?: { deposit_paid?: boolean } | null;
  // deno-lint-ignore no-explicit-any
  business_events?: any[];
}

export interface EvaluateOptions {
  now?: string;
  install_window_business_days?: number;
}

export interface NextAction {
  id: string;
  label: string;
  owner: StageOwner;
  severity: GateSeverity;
}

export interface StageGateResult {
  job: { id: string | null; job_number: string | null; type: string | null; status: string | null };
  source_status: string | null;
  normalized_status: CanonicalStatus | null;
  frontend_bucket: string;
  status_mapped_for_pipeline: boolean;
  current_stage: CanonicalStatus | null;
  family: StageFamilyName | null;
  owner: StageOwner;
  jarvis_posture: JarvisPosture;
  gates: GateResult[];
  blockers: GateResult[];
  warnings: GateResult[];
  overrides: GateResult[];
  next_actions: NextAction[];
  legal_forward: string[];
  legal_backward: string[];
  illegal_jumps: string[];
  install_window_days: number | null;
  install_in_window: boolean;
  confidence: 'high' | 'medium' | 'low';
  evidence_refs: Record<string, GateEvidence>;
  computed_at: string;
}

export interface CanTransitionOverride {
  role?: 'marnin' | 'shaun' | 'marnin_shaun' | string;
  reason?: string;
  // deno-lint-ignore no-explicit-any
  [key: string]: any;
}

export interface CanTransitionResult {
  allowed: boolean;
  direction: 'forward' | 'backward' | 'illegal';
  type_legal: boolean;
  from_type_legal: boolean;
  gates_passed: string[];
  gates_failed: string[];
  hard_blocked: boolean;
  requires_override: boolean;
  override_role_required: string | null;
  reasons: string[];
}

export interface ProposeNextStageResult {
  suggestion: string | null;
  reason: string;
  blockers: GateResult[];
  owner: StageOwner;
  jarvis_posture: JarvisPosture;
  evidence_refs: Record<string, GateEvidence>;
}

// ══════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════

// deno-lint-ignore no-explicit-any
function isPresent(v: any): boolean {
  return v !== null && v !== undefined && v !== '';
}

// deno-lint-ignore no-explicit-any
function safe(obj: any, path: string, dflt: any): any {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length; i++) {
    if (cur == null) return dflt;
    cur = cur[parts[i]];
  }
  return cur == null ? dflt : cur;
}

// deno-lint-ignore no-explicit-any
function asArray(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  return [v];
}

function businessDaysBetween(fromIso: string, toIso: string): number | null {
  if (!fromIso || !toIso) return null;
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) return null;
  const ms = to.getTime() - from.getTime();
  const sign = ms < 0 ? -1 : 1;
  const msAbs = Math.abs(ms);
  const dayMs = 24 * 60 * 60 * 1000;
  const totalDays = Math.floor(msAbs / dayMs);
  let days = 0;
  let d = new Date(from);
  for (let i = 0; i < totalDays; i++) {
    d = new Date(d.getTime() + sign * dayMs);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) days += 1;
  }
  return sign * days;
}

// deno-lint-ignore no-explicit-any
function findOverride(jobContext: any[] | null | undefined, gateId: string): any {
  const rows = asArray(jobContext);
  return rows.find((c) => {
    if (!c || (c.kind !== 'gate_override' && c.kind !== 'force_proceed_reason' && c.kind !== 'readiness_override')) {
      return false;
    }
    const v = c.value || {};
    return v.gate_id === gateId || v.signal === gateId ||
      (v.from_stage && v.gate_id === gateId);
  }) || null;
}

// deno-lint-ignore no-explicit-any
function findFact(jobContext: any[] | null | undefined, kind: string): any {
  const rows = asArray(jobContext);
  return rows.filter((c) => c && c.kind === kind)[0] || null;
}

// ══════════════════════════════════════════════════════════════
// Stage families and ownership
// ══════════════════════════════════════════════════════════════

export const STAGE_FAMILY: Record<string, StageFamilyName> = {
  draft: 'quote',
  quoted: 'quote',
  partially_accepted: 'acceptance',
  accepted: 'acceptance',
  awaiting_deposit: 'pre_install_finance',
  deposit: 'pre_install_finance',
  approvals: 'pre_install_compliance',
  order_materials: 'materials',
  processing: 'materials',
  awaiting_supplier: 'materials',
  order_confirmed: 'materials',
  schedule_install: 'install',
  scheduled: 'install',
  in_progress: 'install',
  rectification: 'install',
  complete: 'closeout',
  final_payment: 'closeout',
  invoiced: 'closeout',
  get_review: 'closeout',
  cancelled: 'terminal',
  lost: 'terminal',
  archived: 'terminal',
};

// ══════════════════════════════════════════════════════════════
// Per-type transition graph
// ══════════════════════════════════════════════════════════════

interface TransitionEntry {
  forward: string[];
  backward: string[];
}
type TransitionGraph = Record<string, TransitionEntry>;

export const FENCING_TRANSITIONS: TransitionGraph = {
  draft: { forward: ['quoted'], backward: [] },
  quoted: { forward: ['partially_accepted', 'accepted'], backward: [] },
  partially_accepted: { forward: ['accepted'], backward: ['quoted'] },
  accepted: { forward: ['awaiting_deposit'], backward: ['quoted', 'partially_accepted'] },
  awaiting_deposit: { forward: ['order_materials'], backward: ['accepted'] },
  order_materials: { forward: ['awaiting_supplier'], backward: ['awaiting_deposit'] },
  awaiting_supplier: { forward: ['order_confirmed'], backward: ['order_materials'] },
  order_confirmed: { forward: ['scheduled'], backward: ['awaiting_supplier'] },
  scheduled: { forward: ['in_progress'], backward: ['order_confirmed'] },
  in_progress: { forward: ['complete'], backward: ['scheduled'] },
  complete: { forward: ['invoiced', 'archived'], backward: [] },
  invoiced: { forward: ['archived'], backward: [] },
  cancelled: { forward: ['archived'], backward: [] },
  archived: { forward: [], backward: [] },
};

export const PATIO_TRANSITIONS: TransitionGraph = {
  draft: { forward: ['quoted'], backward: [] },
  quoted: { forward: ['accepted'], backward: [] },
  accepted: { forward: ['awaiting_deposit'], backward: ['quoted'] },
  awaiting_deposit: { forward: ['approvals', 'order_materials'], backward: ['accepted'] },
  approvals: { forward: ['order_materials'], backward: ['awaiting_deposit'] },
  order_materials: { forward: ['awaiting_supplier'], backward: ['awaiting_deposit', 'approvals'] },
  awaiting_supplier: { forward: ['order_confirmed'], backward: ['order_materials'] },
  order_confirmed: { forward: ['scheduled'], backward: ['awaiting_supplier'] },
  scheduled: { forward: ['in_progress'], backward: ['order_confirmed'] },
  in_progress: { forward: ['complete'], backward: ['scheduled'] },
  complete: { forward: ['invoiced', 'archived'], backward: [] },
  invoiced: { forward: ['archived'], backward: [] },
  cancelled: { forward: ['archived'], backward: [] },
  archived: { forward: [], backward: [] },
};

export const QUICK_QUOTE_TRANSITIONS: TransitionGraph = {
  draft: { forward: ['quoted'], backward: [] },
  quoted: { forward: ['accepted'], backward: [] },
  accepted: { forward: ['archived'], backward: ['quoted'] },
  cancelled: { forward: ['archived'], backward: [] },
  archived: { forward: [], backward: [] },
};

export function transitionsFor(type: string | null | undefined): TransitionGraph {
  switch (type) {
    case 'fencing':
      return FENCING_TRANSITIONS;
    case 'patio':
      return PATIO_TRANSITIONS;
    case 'decking':
      return PATIO_TRANSITIONS;
    case 'quick_quote':
      return QUICK_QUOTE_TRANSITIONS;
    default:
      return PATIO_TRANSITIONS;
  }
}

function isStageAtOrAfter(currentStage: string | null, threshold: string, type: string | null | undefined): boolean {
  if (!currentStage) return false;
  const arr = getStagesForType(type as JobType | null | undefined);
  const ci = arr.indexOf(currentStage as CanonicalStatus);
  const ti = arr.indexOf(threshold as CanonicalStatus);
  if (ci === -1 || ti === -1) return false;
  return ci >= ti;
}

// ══════════════════════════════════════════════════════════════
// Gate evaluators
// ══════════════════════════════════════════════════════════════

interface GateContext {
  job: JobLike;
  type: string | null;
  currentStage: CanonicalStatus | null;
  packet: ReleasePacket;
  supplemental: SupplementalBlob;
  install_in_window: boolean;
  install_window_days: number | null;
  now: Date;
}

function gateResult(
  id: string,
  status: GateStatus,
  severity: GateSeverity,
  family: GateFamily,
  owner: StageOwner,
  evidence?: GateEvidence | null,
  reason?: string,
  next_action?: string | null,
  override_available?: boolean,
  // deno-lint-ignore no-explicit-any
  override?: any,
): GateResult {
  return {
    gate_id: id,
    status,
    severity,
    family,
    owner: owner || 'system',
    evidence: evidence || { source: null, ref: null, value: null },
    reason: reason || '',
    next_action: next_action || null,
    override_available: !!override_available,
    override: override || null,
  };
}

function gate_status_mapped_for_pipeline(ctx: GateContext): GateResult {
  const rawStatus = safe(ctx.packet, 'job.status', null);
  const m = mapStatus(rawStatus);
  if (m.status_mapped_for_pipeline) {
    return gateResult('status_mapped_for_pipeline', 'pass', 'blocker', 'system', 'system',
      { source: 'packet.job.status', ref: null, value: rawStatus },
      `Status "${rawStatus}" maps to bucket "${m.frontend_bucket}"`);
  }
  return gateResult('status_mapped_for_pipeline', 'fail', 'blocker', 'system', 'system',
    { source: 'packet.job.status', ref: null, value: rawStatus },
    `Status "${rawStatus || 'null'}" is not in canonical map — falling back to status_mapping_gap bucket so job stays visible`,
    `Update backend/frontend status map: add "${rawStatus}" → bucket`);
}

function gate_revision_present(ctx: GateContext): GateResult {
  const applies = ctx.currentStage !== 'draft' && ctx.currentStage !== null;
  if (!applies) return gateResult('revision_present', 'not_applicable', 'blocker', 'cap0_release', 'sales');
  const rev = safe(ctx.packet, 'revision', null);
  if (rev && isPresent(rev.id)) {
    return gateResult('revision_present', 'pass', 'blocker', 'cap0_release', 'sales',
      { source: 'packet.revision.id', ref: rev.id, value: rev.revision_number },
      `Quote revision #${rev.revision_number || '?'} present`);
  }
  return gateResult('revision_present', 'fail', 'blocker', 'cap0_release', 'sales',
    { source: 'packet.revision', ref: null, value: null },
    'No quote_revisions row for this job — Cap 0 release truth absent',
    'Send quote via Patio/Fence/Quick Quote tool');
}

function gate_revision_released(ctx: GateContext): GateResult {
  const applies = ctx.currentStage && ctx.currentStage !== 'draft' && ctx.currentStage !== 'quoted';
  if (!applies) return gateResult('revision_released', 'not_applicable', 'blocker', 'cap0_release', 'sales');
  const sentAt = safe(ctx.packet, 'revision.sent_at', null);
  if (isPresent(sentAt)) {
    return gateResult('revision_released', 'pass', 'blocker', 'cap0_release', 'sales',
      { source: 'packet.revision.sent_at', ref: null, value: sentAt },
      `Sent ${sentAt}`);
  }
  return gateResult('revision_released', 'fail', 'blocker', 'cap0_release', 'sales',
    { source: 'packet.revision.sent_at', ref: null, value: null },
    'Revision is staged but not yet sent (sent_at IS NULL)',
    'Trigger send-quote on staged revision');
}

function gate_accepted_at(ctx: GateContext): GateResult {
  const applies = ctx.currentStage && isStageAtOrAfter(ctx.currentStage, 'accepted', ctx.type) &&
    ctx.currentStage !== 'cancelled' && ctx.currentStage !== 'archived' && ctx.currentStage !== 'lost';
  if (!applies) return gateResult('accepted_at', 'not_applicable', 'blocker', 'acceptance', 'sales');
  const declinedAt = safe(ctx.packet, 'document.declined_at', null);
  if (isPresent(declinedAt)) {
    return gateResult('accepted_at', 'fail', 'blocker', 'acceptance', 'sales',
      { source: 'packet.document.declined_at', ref: null, value: declinedAt },
      `Client declined ${declinedAt} — operational stages cannot be entered`,
      'Move job to cancelled or open variation conversation');
  }
  const acceptedAt = safe(ctx.packet, 'document.accepted_at', null);
  if (isPresent(acceptedAt)) {
    return gateResult('accepted_at', 'pass', 'blocker', 'acceptance', 'sales',
      { source: 'packet.document.accepted_at', ref: null, value: acceptedAt },
      `Accepted ${acceptedAt}`);
  }
  return gateResult('accepted_at', 'fail', 'blocker', 'acceptance', 'sales',
    { source: 'packet.document.accepted_at', ref: null, value: null },
    'No client acceptance recorded',
    'Confirm client acceptance via share link or manual document update');
}

function gate_partial_acceptance_complete(ctx: GateContext): GateResult {
  if (ctx.type !== 'fencing') {
    return gateResult('partial_acceptance_complete', 'not_applicable', 'blocker', 'acceptance', 'sales',
      { source: null, ref: null, value: null },
      'Multi-neighbour rule applies to fencing only');
  }
  const applies = ctx.currentStage && isStageAtOrAfter(ctx.currentStage, 'partially_accepted', 'fencing');
  if (!applies) return gateResult('partial_acceptance_complete', 'not_applicable', 'blocker', 'acceptance', 'sales');

  const parties = asArray(safe(ctx.packet, 'revision.scope_snapshot.parties', []));
  if (parties.length === 0) {
    return gateResult('partial_acceptance_complete', 'pass', 'blocker', 'acceptance', 'sales',
      { source: 'packet.revision.scope_snapshot.parties', ref: null, value: 0 },
      'Single-party fence — multi-neighbour rule not engaged');
  }
  const declined = parties.filter((p) => isPresent(p.declined_at));
  if (declined.length > 0) {
    return gateResult('partial_acceptance_complete', 'fail', 'blocker', 'acceptance', 'sales',
      { source: 'packet.revision.scope_snapshot.parties', ref: null, value: { declined_count: declined.length } },
      `${declined.length} party/parties declined — job must revert to quoted with revised scope`,
      'Re-quote with adjusted neighbour set OR move to cancelled');
  }
  const pending = parties.filter((p) => !isPresent(p.accepted_at));
  if (pending.length > 0) {
    return gateResult('partial_acceptance_complete', 'fail', 'blocker', 'acceptance', 'sales',
      { source: 'packet.revision.scope_snapshot.parties', ref: null, value: { pending_count: pending.length, total: parties.length } },
      `${pending.length} of ${parties.length} parties still pending — operational stages cannot start (all-or-nothing)`,
      'Continue sales follow-up with pending parties');
  }
  return gateResult('partial_acceptance_complete', 'pass', 'blocker', 'acceptance', 'sales',
    { source: 'packet.revision.scope_snapshot.parties', ref: null, value: { accepted: parties.length } },
    `All ${parties.length} parties accepted`);
}

function gate_customer_mobile_present(ctx: GateContext): GateResult {
  const applies = ctx.currentStage && isStageAtOrAfter(ctx.currentStage, 'accepted', ctx.type) &&
    ctx.currentStage !== 'cancelled' && ctx.currentStage !== 'archived';
  if (!applies) return gateResult('customer_mobile_present', 'not_applicable', 'blocker', 'packet', 'office');
  const mobile = safe(ctx.packet, 'customer.mobile', null);
  if (isPresent(mobile)) {
    return gateResult('customer_mobile_present', 'pass', 'blocker', 'packet', 'office',
      { source: 'packet.customer.mobile', ref: null, value: mobile }, 'Mobile present');
  }
  return gateResult('customer_mobile_present', 'fail', 'blocker', 'packet', 'office',
    { source: 'packet.customer.mobile', ref: null, value: null },
    'Customer mobile missing — install reminders and payment links cannot send',
    'Capture mobile via sw_update_contact');
}

function gate_site_address_present(ctx: GateContext): GateResult {
  const applies = ctx.currentStage && isStageAtOrAfter(ctx.currentStage, 'accepted', ctx.type) &&
    ctx.currentStage !== 'cancelled' && ctx.currentStage !== 'archived';
  if (!applies) return gateResult('site_address_present', 'not_applicable', 'blocker', 'packet', 'office');
  const addr = safe(ctx.packet, 'site.address', null);
  const suburb = safe(ctx.packet, 'site.suburb', null);
  if (isPresent(addr) && isPresent(suburb)) {
    return gateResult('site_address_present', 'pass', 'blocker', 'packet', 'office',
      { source: 'packet.site', ref: null, value: { address: addr, suburb } }, 'Address + suburb present');
  }
  return gateResult('site_address_present', 'fail', 'blocker', 'packet', 'office',
    { source: 'packet.site', ref: null, value: { address: addr, suburb } },
    'Site address or suburb missing', 'Confirm site address with client and update job');
}

function gate_site_geocoded(ctx: GateContext): GateResult {
  const applies = ctx.currentStage && isStageAtOrAfter(ctx.currentStage, 'awaiting_deposit', ctx.type) &&
    ctx.currentStage !== 'cancelled' && ctx.currentStage !== 'archived';
  if (!applies) return gateResult('site_geocoded', 'not_applicable', 'warning', 'packet', 'office');
  const lat = safe(ctx.packet, 'site.lat', null);
  const lng = safe(ctx.packet, 'site.lng', null);
  if (typeof lat === 'number' && typeof lng === 'number') {
    return gateResult('site_geocoded', 'pass', 'warning', 'packet', 'office',
      { source: 'packet.site', ref: null, value: { lat, lng } }, 'Site geocoded');
  }
  return gateResult('site_geocoded', 'fail', 'warning', 'packet', 'office',
    { source: 'packet.site', ref: null, value: { lat, lng } },
    'Site lat/lng missing — calendar routing + weather lookups will be approximate',
    'Geocode the site address', true);
}

function gate_access_note_present(ctx: GateContext): GateResult {
  const applies = ctx.currentStage && isStageAtOrAfter(ctx.currentStage, 'accepted', ctx.type) &&
    ctx.currentStage !== 'cancelled' && ctx.currentStage !== 'archived';
  if (!applies) return gateResult('access_note_present', 'not_applicable', 'warning', 'packet', 'office');
  const snapshotAccess = safe(ctx.packet, 'revision.scope_snapshot.access_notes', null);
  const noSpecial = safe(ctx.packet, 'revision.scope_snapshot.no_special_access', null);
  const contextNote = findFact(ctx.supplemental.job_context, 'access_note');
  if (isPresent(snapshotAccess) || noSpecial === true || contextNote) {
    return gateResult('access_note_present', 'pass', 'warning', 'packet', 'office',
      {
        source: contextNote ? 'job_context.access_note' : 'packet.revision.scope_snapshot',
        ref: null,
        value: snapshotAccess || (contextNote && contextNote.value) || 'no_special_access',
      },
      'Access notes captured');
  }
  return gateResult('access_note_present', 'fail', 'warning', 'packet', 'office',
    { source: 'packet.revision.scope_snapshot.access_notes', ref: null, value: null },
    'No access notes and no explicit "no special access" — install crew may hit surprises',
    'Capture access notes (gate code / dog / parking / power)', true);
}

function gate_council_approval_received(ctx: GateContext): GateResult {
  if (ctx.type !== 'patio' && ctx.type !== 'decking') {
    return gateResult('council_approval_received', 'not_applicable', 'blocker', 'compliance', 'office',
      { source: null, ref: null, value: null },
      'Council approvals apply to patio/decking only');
  }
  const applies = ctx.currentStage && isStageAtOrAfter(ctx.currentStage, 'awaiting_deposit', ctx.type);
  if (!applies) return gateResult('council_approval_received', 'not_applicable', 'blocker', 'compliance', 'office');
  const councilRequired = safe(ctx.packet, 'revision.scope_snapshot.council_required', null);
  const councilStatus = safe(ctx.packet, 'revision.scope_snapshot.council_status', null);
  if (councilRequired === false || councilStatus === 'not_required') {
    return gateResult('council_approval_received', 'not_applicable', 'blocker', 'compliance', 'office',
      { source: 'packet.revision.scope_snapshot.council_required', ref: null, value: false },
      'No council approval required for this patio (per scope snapshot)');
  }
  if (councilStatus === 'complete' || councilStatus === 'approved') {
    return gateResult('council_approval_received', 'pass', 'blocker', 'compliance', 'office',
      { source: 'packet.revision.scope_snapshot.council_status', ref: null, value: councilStatus },
      `Council approval ${councilStatus}`);
  }
  const override = findOverride(ctx.supplemental.job_context, 'council_approval_received');
  if (override) {
    return gateResult('council_approval_received', 'overridden', 'blocker', 'compliance', 'office',
      { source: 'job_context.gate_override', ref: override.id || null, value: override.value },
      `Council requirement overridden (${override.value && override.value.reason || 'no reason'})`,
      null, false, override);
  }
  return gateResult('council_approval_received', 'fail', 'blocker', 'compliance', 'office',
    { source: 'packet.revision.scope_snapshot.council_status', ref: null, value: councilStatus || 'pending' },
    'Council approval pending — operational stages cannot start',
    'Track council submission via sw_update_council_status', true);
}

function gate_deposit_paid(ctx: GateContext): GateResult {
  const applies = ctx.currentStage && isStageAtOrAfter(ctx.currentStage, 'awaiting_deposit', ctx.type) &&
    ctx.currentStage !== 'cancelled' && ctx.currentStage !== 'archived';
  if (!applies) return gateResult('deposit_paid', 'not_applicable', 'blocker', 'finance', 'sales');
  const depositTruth = safe(ctx.supplemental, 'deposit', null);
  if (depositTruth && depositTruth.deposit_paid === true) {
    return gateResult('deposit_paid', 'pass', 'blocker', 'finance', 'sales',
      { source: 'supplemental.deposit', ref: null, value: depositTruth }, 'Deposit recorded in Xero');
  }
  const paymentAgreement = findFact(ctx.supplemental.job_context, 'payment_agreement');
  if (paymentAgreement) {
    return gateResult('deposit_paid', 'overridden', 'blocker', 'finance', 'sales',
      { source: 'job_context.payment_agreement', ref: paymentAgreement.id || null, value: paymentAgreement.value },
      `Deposit handled via payment agreement (${paymentAgreement.value && paymentAgreement.value.type || 'documented'})`,
      null, false, paymentAgreement);
  }
  const override = findOverride(ctx.supplemental.job_context, 'deposit_paid');
  if (override) {
    return gateResult('deposit_paid', 'overridden', 'blocker', 'finance', 'sales',
      { source: 'job_context.gate_override', ref: override.id || null, value: override.value },
      `Deposit override active (${override.value && override.value.reason || 'bank-confirmed outside Xero'})`,
      null, false, override);
  }
  return gateResult('deposit_paid', 'fail', 'blocker', 'finance', 'sales',
    { source: 'supplemental.deposit', ref: null, value: depositTruth || null },
    'Deposit not recorded — materials cannot be ordered (Marnin/Shaun override required if bank-confirmed)',
    'Confirm deposit via Xero OR capture payment_agreement/gate_override', true);
}

function gate_materials_ordered(ctx: GateContext): GateResult {
  const applies = ctx.currentStage && isStageAtOrAfter(ctx.currentStage, 'order_materials', ctx.type) &&
    ctx.currentStage !== 'cancelled' && ctx.currentStage !== 'archived';
  if (!applies) return gateResult('materials_ordered', 'not_applicable', 'blocker', 'materials', 'office');
  const pos = asArray(safe(ctx.packet, 'purchase_orders', []));
  if (pos.length === 0) {
    return gateResult('materials_ordered', 'fail', 'blocker', 'materials', 'office',
      { source: 'packet.purchase_orders', ref: null, value: { count: 0 } },
      'No purchase orders linked to this job',
      'Create + send material PO via sw_create_po + sw_send_po_email');
  }
  const sentMaterial = pos.filter((p) => {
    const typed = (p.po_type === 'material');
    const sent = (p.status === 'submitted' || p.status === 'authorised' || p.status === 'sent' || p.status === 'acked');
    return typed && sent;
  });
  if (sentMaterial.length > 0) {
    return gateResult('materials_ordered', 'pass', 'blocker', 'materials', 'office',
      { source: 'packet.purchase_orders', ref: null, value: { sent_material_count: sentMaterial.length, total: pos.length } },
      `${sentMaterial.length} material PO(s) sent`);
  }
  const anySent = pos.filter((p) => p.status === 'submitted' || p.status === 'authorised' || p.status === 'sent' || p.status === 'acked');
  if (anySent.length > 0) {
    return gateResult('materials_ordered', 'pass', 'blocker', 'materials', 'office',
      { source: 'packet.purchase_orders', ref: null, value: { any_sent: anySent.length, total: pos.length, fallback: 'po_type_not_bound' } },
      `${anySent.length} PO(s) sent (po_type unbound — Cap 0.5 fallback)`);
  }
  return gateResult('materials_ordered', 'fail', 'blocker', 'materials', 'office',
    { source: 'packet.purchase_orders', ref: null, value: { total: pos.length, sent: 0 } },
    `${pos.length} PO(s) on file but none sent yet`,
    'Send the draft PO to the supplier via sw_send_po_email');
}

function gate_supplier_logistics_confirmed(ctx: GateContext): GateResult {
  const applies = ctx.currentStage && isStageAtOrAfter(ctx.currentStage, 'awaiting_supplier', ctx.type) &&
    ctx.currentStage !== 'cancelled' && ctx.currentStage !== 'archived' &&
    ctx.currentStage !== 'complete' && ctx.currentStage !== 'invoiced';
  if (!applies) return gateResult('supplier_logistics_confirmed', 'not_applicable', 'blocker', 'logistics', 'office');
  const pos = asArray(safe(ctx.packet, 'purchase_orders', [])).filter((p) => p.po_type === 'material' || p.po_type == null);
  if (pos.length === 0) {
    return gateResult('supplier_logistics_confirmed', 'unknown', 'blocker', 'logistics', 'office',
      { source: 'packet.purchase_orders', ref: null, value: null },
      'No material POs on file to confirm logistics for', null, true);
  }
  const allConfirmed = pos.every((p) => isPresent(p.confirmed_delivery_date) || p.po_type === 'subcontract');
  if (allConfirmed) {
    return gateResult('supplier_logistics_confirmed', 'pass', 'blocker', 'logistics', 'office',
      { source: 'packet.purchase_orders.confirmed_delivery_date', ref: null, value: pos.length },
      `All ${pos.length} material PO(s) have confirmed delivery date`);
  }
  let override = findOverride(ctx.supplemental.job_context, 'supplier_logistics');
  if (!override) override = findOverride(ctx.supplemental.job_context, 'supplier_logistics_confirmed');
  if (override) {
    return gateResult('supplier_logistics_confirmed', 'overridden', 'blocker', 'logistics', 'office',
      { source: 'job_context.gate_override', ref: override.id || null, value: override.value },
      `Logistics override active (${override.value && override.value.reason || 'verbal confirmation'})`,
      null, false, override);
  }
  const inWindow = !!ctx.install_in_window;
  const severity: GateSeverity = inWindow ? 'blocker' : 'warning';
  return gateResult('supplier_logistics_confirmed', 'fail', severity, 'logistics', 'office',
    { source: 'packet.purchase_orders.confirmed_delivery_date', ref: null, value: { confirmed: 0, total: pos.length } },
    `Awaiting supplier confirmation for ${pos.length} PO(s)${inWindow ? ' — install in window' : ''}`,
    'Chase supplier OR apply Logistics override (Marnin/Shaun, verbal confirmation)', true);
}

function gate_work_order_present(ctx: GateContext): GateResult {
  const applies = ctx.currentStage && isStageAtOrAfter(ctx.currentStage, 'order_confirmed', ctx.type) &&
    ctx.currentStage !== 'cancelled' && ctx.currentStage !== 'archived';
  if (!applies) return gateResult('work_order_present', 'not_applicable', 'warning', 'materials', 'office');
  const inWindow = !!ctx.install_in_window;
  const severity: GateSeverity = inWindow ? 'blocker' : 'warning';
  const wo = safe(ctx.packet, 'work_order', null);
  if (!wo) {
    return gateResult('work_order_present', 'fail', severity, 'materials', 'office',
      { source: 'packet.work_order', ref: null, value: null },
      `No work order created${inWindow ? ' (install in window)' : ''}`,
      'Create + send work order via sw_create_work_order + sw_send_work_order', !inWindow);
  }
  if (wo.status === 'sent' || wo.status === 'accepted' || wo.status === 'in_progress' || wo.status === 'complete') {
    return gateResult('work_order_present', 'pass', severity, 'materials', 'office',
      { source: 'packet.work_order.status', ref: wo.id || null, value: wo.status },
      `Work order ${wo.wo_number || wo.id || '?'} is ${wo.status}`);
  }
  if (wo.status === 'draft') {
    return gateResult('work_order_present', 'fail', severity, 'materials', 'office',
      { source: 'packet.work_order.status', ref: wo.id || null, value: 'draft' },
      'Work order still in draft', 'Send work order to crew', !inWindow);
  }
  return gateResult('work_order_present', 'fail', severity, 'materials', 'office',
    { source: 'packet.work_order.status', ref: wo.id || null, value: wo.status || null },
    `Work order in unexpected status: ${wo.status || 'null'}`,
    'Review work order state', true);
}

function gate_crew_assigned(ctx: GateContext): GateResult {
  const applies = ctx.currentStage && isStageAtOrAfter(ctx.currentStage, 'scheduled', ctx.type) &&
    ctx.currentStage !== 'cancelled' && ctx.currentStage !== 'archived' &&
    ctx.currentStage !== 'complete' && ctx.currentStage !== 'invoiced';
  if (!applies) return gateResult('crew_assigned', 'not_applicable', 'blocker', 'crew', 'shaun');
  const assignments = asArray(safe(ctx.supplemental, 'assignments', []));
  if (assignments.length === 0) {
    return gateResult('crew_assigned', 'fail', 'blocker', 'crew', 'shaun',
      { source: 'supplemental.assignments', ref: null, value: { count: 0 } },
      'No crew assigned to install', 'Assign crew via sw_create_assignment');
  }
  return gateResult('crew_assigned', 'pass', 'blocker', 'crew', 'shaun',
    { source: 'supplemental.assignments', ref: null, value: { count: assignments.length } },
    `${assignments.length} crew member(s) assigned`);
}

function gate_crew_confirmed_attendance(ctx: GateContext): GateResult {
  const applies = ctx.currentStage === 'scheduled' || ctx.currentStage === 'in_progress';
  if (!applies) return gateResult('crew_confirmed_attendance', 'not_applicable', 'blocker', 'crew', 'shaun');
  const assignments = asArray(safe(ctx.supplemental, 'assignments', []));
  if (assignments.length === 0) {
    return gateResult('crew_confirmed_attendance', 'fail', 'blocker', 'crew', 'shaun',
      { source: 'supplemental.assignments', ref: null, value: { count: 0 } },
      'No assignments yet — cannot confirm attendance', 'Assign crew first');
  }
  const confirmed = assignments.filter((a) => a.confirmation_status === 'confirmed');
  const inWindow = !!ctx.install_in_window;
  if (confirmed.length === 0) {
    const override = findOverride(ctx.supplemental.job_context, 'crew_confirmed_attendance');
    if (override) {
      return gateResult('crew_confirmed_attendance', 'overridden', 'blocker', 'crew', 'shaun',
        { source: 'job_context.gate_override', ref: override.id || null, value: override.value },
        `Crew attendance override (${override.value && override.value.reason || 'operator-confirmed verbally'})`,
        null, false, override);
    }
    const severity: GateSeverity = inWindow ? 'blocker' : 'warning';
    return gateResult('crew_confirmed_attendance', 'fail', severity, 'crew', 'shaun',
      { source: 'supplemental.assignments.confirmation_status', ref: null, value: 'tentative_or_placeholder' },
      'No assignments confirmed (operator-flipped flag; real crew-reply parsing post-Cap-1)',
      'Confirm crew via Secure Ops or sw_update_assignment', true);
  }
  return gateResult('crew_confirmed_attendance', 'pass', 'blocker', 'crew', 'shaun',
    { source: 'supplemental.assignments.confirmation_status', ref: null, value: 'confirmed' },
    `${confirmed.length} confirmed (ops-flipped — real reply parsing is Cap 1+ AI edge)`);
}

function gate_client_confirmed_install(ctx: GateContext): GateResult {
  const applies = ctx.currentStage === 'scheduled' || ctx.currentStage === 'in_progress';
  if (!applies) return gateResult('client_confirmed_install', 'not_applicable', 'warning', 'client', 'office');
  const clientConf = findFact(ctx.supplemental.job_context, 'client_confirmation');
  const accessNote = findFact(ctx.supplemental.job_context, 'access_note');
  const requiresStrict = findFact(ctx.supplemental.job_context, 'requires_strict_access');
  const inWindow = !!ctx.install_in_window;
  const severity: GateSeverity = requiresStrict ? 'blocker' : (inWindow ? 'warning' : 'informational');
  if (clientConf && accessNote) {
    return gateResult('client_confirmed_install', 'pass', severity, 'client', 'office',
      { source: 'supplemental.job_context', ref: null, value: { client_confirmation: true, access_note: true } },
      'Client confirmed + access captured');
  }
  if (clientConf && !accessNote) {
    return gateResult('client_confirmed_install', 'fail', severity, 'client', 'office',
      { source: 'supplemental.job_context', ref: null, value: { client_confirmation: true, access_note: false } },
      'Client confirmed but access note missing',
      'Capture access details (gate / dog / parking)', true);
  }
  return gateResult('client_confirmed_install', 'fail', severity, 'client', 'office',
    { source: 'supplemental.job_context', ref: null, value: null },
    `No client_confirmation row — install date not yet confirmed with client${requiresStrict ? ' (strict-access job — blocker)' : ' (warning)'}`,
    'Use ops "Client confirmed" toggle (writes client_confirmation + access_note)', true);
}

function gate_install_started(ctx: GateContext): GateResult {
  const applies = ctx.currentStage === 'in_progress' || ctx.currentStage === 'complete';
  if (!applies) return gateResult('install_started', 'not_applicable', 'blocker', 'install', 'crew');
  const events = asArray(safe(ctx.packet, 'events', []));
  const started = events.find((e) => e.event_type === 'install.started');
  if (started) {
    return gateResult('install_started', 'pass', 'blocker', 'install', 'crew',
      { source: 'packet.events.install.started', ref: started.id || null, value: started.occurred_at },
      `Install started ${started.occurred_at}`);
  }
  return gateResult('install_started', 'fail', 'blocker', 'install', 'crew',
    { source: 'packet.events', ref: null, value: null },
    'No install.started event — crew should tap "Start" in trade app',
    'Crew taps install start');
}

function gate_install_completed(ctx: GateContext): GateResult {
  const applies = ctx.currentStage === 'complete' || ctx.currentStage === 'invoiced';
  if (!applies) return gateResult('install_completed', 'not_applicable', 'blocker', 'install', 'crew');
  const events = asArray(safe(ctx.packet, 'events', []));
  const completed = events.find((e) => e.event_type === 'install.completed');
  if (completed) {
    return gateResult('install_completed', 'pass', 'blocker', 'install', 'crew',
      { source: 'packet.events.install.completed', ref: completed.id || null, value: completed.occurred_at },
      `Install completed ${completed.occurred_at}`);
  }
  return gateResult('install_completed', 'fail', 'blocker', 'install', 'crew',
    { source: 'packet.events', ref: null, value: null },
    'No install.completed event — crew should tap "Complete" in trade app',
    'Crew taps install complete + client sign-off');
}

const GATES = [
  gate_status_mapped_for_pipeline,
  gate_revision_present,
  gate_revision_released,
  gate_accepted_at,
  gate_partial_acceptance_complete,
  gate_customer_mobile_present,
  gate_site_address_present,
  gate_site_geocoded,
  gate_access_note_present,
  gate_council_approval_received,
  gate_deposit_paid,
  gate_materials_ordered,
  gate_supplier_logistics_confirmed,
  gate_work_order_present,
  gate_crew_assigned,
  gate_crew_confirmed_attendance,
  gate_client_confirmed_install,
  gate_install_started,
  gate_install_completed,
];

// ══════════════════════════════════════════════════════════════
// evaluateStageGates
// ══════════════════════════════════════════════════════════════

export function evaluateStageGates(
  job: JobLike | null,
  packet: ReleasePacket,
  supplemental: SupplementalBlob | null,
  options?: EvaluateOptions,
): StageGateResult {
  const opts = options || {};
  const supp = supplemental || {};
  const now = opts.now ? new Date(opts.now) : new Date();
  const windowDays = typeof opts.install_window_business_days === 'number' ? opts.install_window_business_days : 5;

  const rawStatus = safe(packet, 'job.status', null);
  const statusMapping = mapStatus(rawStatus);
  const currentStage = statusMapping.normalized_status as CanonicalStatus | null;
  const jobType = safe(packet, 'job.type', null) || (job && job.type) || null;

  const scheduledDate = safe(packet, 'work_order.scheduled_date', null) ||
    (asArray(safe(supp, 'assignments', []))
      .map((a) => a && a.scheduled_date)
      .filter(isPresent)[0] || null);
  const installWindowDays = scheduledDate ? businessDaysBetween(now.toISOString(), scheduledDate) : null;
  const installInWindow = (typeof installWindowDays === 'number' && installWindowDays >= 0 && installWindowDays <= windowDays);

  const ctx: GateContext = {
    job: job || safe(packet, 'job', {}),
    type: jobType,
    currentStage,
    packet,
    supplemental: supp,
    install_in_window: installInWindow,
    install_window_days: installWindowDays,
    now,
  };

  const gates = GATES.map((fn) => fn(ctx));

  const blockers = gates.filter((g) => g.severity === 'blocker' && g.status === 'fail');
  const warnings = gates.filter((g) => g.severity === 'warning' && g.status === 'fail');
  const overrides = gates.filter((g) => g.status === 'overridden');

  const stageOwner = (currentStage && STATUS_MAP[currentStage] && STATUS_MAP[currentStage].owner) || 'system';
  const stagePosture = (currentStage && STATUS_MAP[currentStage] && STATUS_MAP[currentStage].jarvis_posture) || 'read_only';

  const sevRank: Record<string, number> = { blocker: 0, warning: 1, informational: 2, deferred: 3 };
  const seen: Record<string, boolean> = {};
  const candidateActions: Array<NextAction & { order: number }> = [];
  gates.forEach((g, idx) => {
    if (g.next_action && !seen[g.gate_id]) {
      seen[g.gate_id] = true;
      candidateActions.push({
        id: g.gate_id,
        label: g.next_action,
        owner: g.owner,
        severity: g.severity,
        order: idx,
      });
    }
  });
  candidateActions.sort((a, b) => {
    const ao = a.owner === stageOwner ? 0 : 1;
    const bo = b.owner === stageOwner ? 0 : 1;
    if (ao !== bo) return ao - bo;
    const as = sevRank[a.severity] ?? 9;
    const bs = sevRank[b.severity] ?? 9;
    if (as !== bs) return as - bs;
    return a.order - b.order;
  });
  const nextActions: NextAction[] = candidateActions.slice(0, 3).map((c) => ({
    id: c.id,
    label: c.label,
    owner: c.owner,
    severity: c.severity,
  }));

  let confidence: 'high' | 'medium' | 'low' = 'high';
  if (!statusMapping.status_mapped_for_pipeline) confidence = 'low';
  else if (gates.filter((g) => g.status === 'unknown').length >= 2) confidence = 'low';
  else if (warnings.length >= 3) confidence = 'medium';
  else if (blockers.length >= 4) confidence = 'medium';

  const transitions = transitionsFor(jobType);
  const stageEntry = (currentStage && transitions[currentStage]) || { forward: [], backward: [] };
  const legalForward = stageEntry.forward.slice();
  const legalBackward = stageEntry.backward.slice();
  if (currentStage && currentStage !== 'cancelled' && currentStage !== 'archived' && currentStage !== 'lost' &&
      legalForward.indexOf('cancelled') === -1) {
    legalForward.push('cancelled');
  }

  const evidenceRefs: Record<string, GateEvidence> = {};
  gates.forEach((g) => { evidenceRefs[g.gate_id] = g.evidence; });

  return {
    job: {
      id: ctx.job.id || null,
      job_number: ctx.job.job_number || null,
      type: jobType,
      status: rawStatus,
    },
    source_status: statusMapping.source_status,
    normalized_status: currentStage,
    frontend_bucket: statusMapping.frontend_bucket,
    status_mapped_for_pipeline: statusMapping.status_mapped_for_pipeline,
    current_stage: currentStage,
    family: (currentStage ? STAGE_FAMILY[currentStage] : null) || null,
    owner: stageOwner,
    jarvis_posture: stagePosture,
    gates,
    blockers,
    warnings,
    overrides,
    next_actions: nextActions,
    legal_forward: legalForward,
    legal_backward: legalBackward,
    illegal_jumps: [],
    install_window_days: installWindowDays,
    install_in_window: installInWindow,
    confidence,
    evidence_refs: evidenceRefs,
    computed_at: now.toISOString(),
  };
}

// ══════════════════════════════════════════════════════════════
// canTransition
// ══════════════════════════════════════════════════════════════

export function canTransition(
  job: JobLike | null,
  from: string | null,
  to: string,
  override?: CanTransitionOverride,
): CanTransitionResult {
  const jobType = (job && job.type) || 'patio';
  const toMap = mapStatus(to);
  const transitions = transitionsFor(jobType as string);
  const reasons: string[] = [];
  let hardBlocked = false;

  const universalCancelAllowed = (to === 'cancelled' && from !== 'cancelled' && from !== 'archived' && from !== 'lost');

  const typeLegal = isLegalForType(to, jobType as JobType);
  const fromTypeLegal = from == null || from === 'draft' || isLegalForType(from, jobType as JobType);
  if (!typeLegal && !universalCancelAllowed && to !== 'archived') {
    reasons.push(`Status "${to}" is not legal for type "${jobType}" (per-type validity from canonical map).`);
    hardBlocked = true;
  }
  if (!fromTypeLegal && from !== null && from !== 'draft') {
    reasons.push(`Status "${from}" is not legal for type "${jobType}" — cannot transition from an invalid stage.`);
    hardBlocked = true;
  }

  if (!toMap.status_mapped_for_pipeline) {
    reasons.push(`Target status "${to}" is not in canonical map.`);
    hardBlocked = true;
  }

  const entry = (from && transitions[from]) || { forward: [], backward: [] };
  let direction: 'forward' | 'backward' | 'illegal' = 'illegal';
  if (entry.forward.indexOf(to) !== -1 || universalCancelAllowed) direction = 'forward';
  else if (entry.backward.indexOf(to) !== -1) direction = 'backward';
  else if (from === 'cancelled' && to === 'quoted') direction = 'forward';
  else if ((from === 'complete' || from === 'cancelled') && to === 'archived') direction = 'forward';

  let allowed = direction !== 'illegal' && !hardBlocked;
  let requiresOverride = false;

  if (from === 'cancelled' && to === 'quoted') {
    requiresOverride = true;
    if (!override || (override.role !== 'marnin' && override.role !== 'shaun' && override.role !== 'marnin_shaun')) {
      allowed = false;
      reasons.push('cancelled → quoted (re-open) requires Marnin/Shaun override with reason.');
    } else if (!override.reason || override.reason.length < 12) {
      allowed = false;
      reasons.push('Re-open override requires a free-text reason ≥ 12 chars.');
    }
  }

  if (from === 'archived') {
    hardBlocked = true;
    allowed = false;
    reasons.push('archived is a hard terminal — cannot transition out.');
  }

  if (from === 'complete' && (to === 'draft' || to === 'quoted' || to === 'accepted')) {
    hardBlocked = true;
    allowed = false;
    reasons.push(`complete → ${to} is forbidden (would corrupt finance reporting).`);
  }
  if (from === 'invoiced' && to !== 'archived' && to !== 'cancelled') {
    hardBlocked = true;
    allowed = false;
    reasons.push('invoiced is a financial pseudo-terminal — reverse via Xero void, not status flip.');
  }

  const arr = getStagesForType(jobType as JobType | string | null | undefined);
  const fi = from ? arr.indexOf(from as CanonicalStatus) : -1;
  const ti = arr.indexOf(to as CanonicalStatus);
  if (fi !== -1 && ti !== -1 && direction === 'forward' && (ti - fi) > 2 && to !== 'cancelled' && to !== 'archived') {
    requiresOverride = true;
    if (!override) {
      allowed = false;
      reasons.push(`Skip of ${ti - fi} stages requires explicit override (Marnin/Shaun, reason category + free-text).`);
    }
  }

  return {
    allowed,
    direction,
    type_legal: typeLegal,
    from_type_legal: fromTypeLegal,
    gates_passed: [],
    gates_failed: [],
    hard_blocked: hardBlocked,
    requires_override: requiresOverride,
    override_role_required: requiresOverride ? 'marnin_shaun' : null,
    reasons,
  };
}

// ══════════════════════════════════════════════════════════════
// proposeNextStage
// ══════════════════════════════════════════════════════════════

export function proposeNextStage(
  job: JobLike | null,
  packet: ReleasePacket,
  supplemental: SupplementalBlob | null,
): ProposeNextStageResult {
  const result = evaluateStageGates(job, packet, supplemental);
  const current = result.current_stage;
  const jobType = result.job.type;
  const transitions = transitionsFor(jobType);
  const entry = (current && transitions[current]) || { forward: [], backward: [] };

  if (entry.forward.length === 0) {
    return {
      suggestion: null,
      reason: `No forward transitions available from "${current || 'unknown'}"`,
      blockers: [],
      owner: result.owner,
      jarvis_posture: result.jarvis_posture,
      evidence_refs: {},
    };
  }

  let candidates = entry.forward.filter((s) => s !== 'cancelled');
  if (candidates.length === 0) candidates = entry.forward;

  const blockers = result.blockers.slice();
  let firstAllowed: string | null = null;
  const firstBlocked = candidates[0];
  for (let i = 0; i < candidates.length; i++) {
    const ct = canTransition({ type: jobType }, current, candidates[i]);
    if (ct.allowed && blockers.length === 0) {
      firstAllowed = candidates[i];
      break;
    }
  }

  const suggestion = firstAllowed || firstBlocked;
  let reason: string;
  if (firstAllowed) {
    reason = `All gates pass; ready to advance to "${firstAllowed}"`;
  } else if (blockers.length > 0) {
    reason = `Blocked from "${suggestion}" by ${blockers.length} gate(s): ${blockers.map((b) => b.gate_id).join(', ')}`;
  } else {
    reason = `Next forward stage is "${suggestion}"`;
  }

  return {
    suggestion,
    reason,
    blockers,
    owner: result.owner,
    jarvis_posture: result.jarvis_posture,
    evidence_refs: result.evidence_refs,
  };
}

export const VERSION = 'cap1c-stage-gate-engine-deno-2026-05-02';

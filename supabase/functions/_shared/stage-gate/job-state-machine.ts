/* ════════════════════════════════════════════════════════════════
   job-state-machine.ts — Cap 1 canonical state machine source

   Single source of truth for SecureWorks job stage vocabulary.
   Imported by Deno edge functions (ops-api, daily-digest,
   send-quote, ghl-webhook, ghl-proxy, xero-sync, reporting-api).
   The browser wrapper lives at
   securedash/modules/sw-state-machine.js — its data MUST mirror
   this file. A drift test will land in Cap 1B.

   Cap 1A scope:
   - Vocabulary lock (all 22 statuses currently in live prod CHECK)
   - Per-type stage arrays (fencing, patio, quick_quote, decking)
   - Backend-status to frontend-bucket map (Pipeline Visibility Guard)
   - Per-stage labels, colors, owners, JARVIS posture
   - Helper functions: mapStatus, getStatusesForType, isLegalForType

   NOT in Cap 1A scope (lands in Cap 1B+):
   - Gate evaluator (evaluateStageGates)
   - Transition graph + canTransition
   - Override engine

   Authority: secureworks-docs/operations/cap-1-stage-gate-contract.md
   Inherits: secureworks-docs/operations/phase-c-jobs-status-spec.md
   ════════════════════════════════════════════════════════════════ */

export type JobType = 'fencing' | 'patio' | 'quick_quote' | 'decking' | 'makesafe';

/** Every value the live prod CHECK admits. Order is canonical board order. */
export type CanonicalStatus =
  | 'draft'
  | 'quoted'
  | 'partially_accepted'
  | 'accepted'
  | 'awaiting_deposit'
  | 'deposit'                // legacy — Phase D rename target → awaiting_deposit
  | 'approvals'
  | 'order_materials'
  | 'processing'             // legacy — Phase D will deprecate (umbrella substage)
  | 'awaiting_supplier'
  | 'order_confirmed'
  | 'schedule_install'       // UI filter only per Phase C, but still in CHECK
  | 'scheduled'
  | 'in_progress'
  | 'rectification'          // legacy — Phase D will migrate to job_context flag
  | 'complete'
  | 'final_payment'          // UI view per Phase C, but still in CHECK
  | 'invoiced'
  | 'get_review'             // UI view per Phase C, but still in CHECK
  | 'cancelled'
  | 'lost'                   // legacy — Phase D will retire
  | 'archived';

export type FrontendBucket =
  | 'quote'
  | 'waiting_client'
  | 'packet_prep'
  | 'materials'
  | 'ready'
  | 'in_progress'
  | 'done'
  | 'terminal'
  | 'status_mapping_gap';

export type StageOwner = 'sales' | 'office' | 'shaun' | 'system' | 'crew';

export type JarvisPosture = 'read_only' | 'suggest' | 'require_approval' | 'automate';

export interface StatusEntry {
  bucket: FrontendBucket;
  stage_order: number;
  human: string;
  color: string;
  owner: StageOwner;
  jarvis_posture: JarvisPosture;
  legacy?: boolean;             // value still in CHECK but Phase D will migrate
  derived_view?: boolean;       // value rendered as UI filter, not a stored stage
}

/** ALL 22 statuses currently in live prod CHECK. Anything not in this map
    falls into status_mapping_gap with confidence='low'. Legacy values stay
    in the map so existing rows keep bucketing — they just get the legacy:true
    flag for the migration plan. */
export const STATUS_MAP: Record<string, StatusEntry> = {
  draft:               { bucket: 'quote',          stage_order: 1,  human: 'Draft',                 color: '#8FA4B2', owner: 'sales',  jarvis_posture: 'read_only' },
  quoted:              { bucket: 'waiting_client', stage_order: 2,  human: 'Quoted',                color: '#9B59B6', owner: 'sales',  jarvis_posture: 'suggest' },
  partially_accepted:  { bucket: 'waiting_client', stage_order: 3,  human: 'Partially Accepted',    color: '#9B59B6', owner: 'sales',  jarvis_posture: 'suggest' },
  accepted:            { bucket: 'packet_prep',    stage_order: 4,  human: 'Accepted',              color: '#3498DB', owner: 'sales',  jarvis_posture: 'suggest' },
  awaiting_deposit:    { bucket: 'packet_prep',    stage_order: 5,  human: 'Awaiting Deposit',      color: '#F39C12', owner: 'sales',  jarvis_posture: 'suggest' },
  deposit:             { bucket: 'packet_prep',    stage_order: 5,  human: 'Deposit',               color: '#F39C12', owner: 'sales',  jarvis_posture: 'suggest', legacy: true },
  approvals:           { bucket: 'packet_prep',    stage_order: 6,  human: 'Approvals',             color: '#1ABC9C', owner: 'office', jarvis_posture: 'suggest' },
  order_materials:     { bucket: 'materials',      stage_order: 7,  human: 'Order Materials',       color: '#E67E22', owner: 'office', jarvis_posture: 'suggest' },
  processing:          { bucket: 'materials',      stage_order: 7,  human: 'Processing',            color: '#E74C3C', owner: 'office', jarvis_posture: 'suggest', legacy: true },
  awaiting_supplier:   { bucket: 'materials',      stage_order: 8,  human: 'Awaiting Supplier',     color: '#95A5A6', owner: 'office', jarvis_posture: 'suggest' },
  order_confirmed:     { bucket: 'materials',      stage_order: 9,  human: 'Order Confirmed',       color: '#1ABC9C', owner: 'office', jarvis_posture: 'suggest' },
  schedule_install:    { bucket: 'ready',          stage_order: 10, human: 'Schedule Install',      color: '#3498DB', owner: 'shaun',  jarvis_posture: 'suggest', derived_view: true },
  scheduled:           { bucket: 'ready',          stage_order: 11, human: 'Scheduled',             color: '#E67E22', owner: 'shaun',  jarvis_posture: 'suggest' },
  in_progress:         { bucket: 'in_progress',    stage_order: 12, human: 'In Progress',           color: '#F15A29', owner: 'crew',   jarvis_posture: 'read_only' },
  rectification:       { bucket: 'in_progress',    stage_order: 13, human: 'Rectification',        color: '#E74C3C', owner: 'shaun',  jarvis_posture: 'read_only', legacy: true },
  complete:            { bucket: 'done',           stage_order: 14, human: 'Complete',              color: '#27AE60', owner: 'system', jarvis_posture: 'suggest' },
  final_payment:       { bucket: 'done',           stage_order: 15, human: 'Final Payment',         color: '#F39C12', owner: 'office', jarvis_posture: 'suggest', derived_view: true },
  invoiced:            { bucket: 'done',           stage_order: 16, human: 'Invoiced',              color: '#7F8C8D', owner: 'system', jarvis_posture: 'read_only' },
  get_review:          { bucket: 'done',           stage_order: 17, human: 'Get Review',            color: '#9B59B6', owner: 'sales',  jarvis_posture: 'suggest', derived_view: true },
  cancelled:           { bucket: 'terminal',       stage_order: 98, human: 'Cancelled',             color: '#E74C3C', owner: 'sales',  jarvis_posture: 'read_only' },
  lost:                { bucket: 'terminal',       stage_order: 99, human: 'Lost',                  color: '#95A5A6', owner: 'sales',  jarvis_posture: 'read_only', legacy: true },
  archived:            { bucket: 'terminal',       stage_order: 99, human: 'Archived',              color: '#7F8C8D', owner: 'system', jarvis_posture: 'read_only' }
};

/** Convenience exports derived from STATUS_MAP for legacy callers. */
export const STATUS_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(STATUS_MAP).map(([k, v]) => [k, v.human])
);
export const STATUS_COLORS: Record<string, string> = Object.fromEntries(
  Object.entries(STATUS_MAP).map(([k, v]) => [k, v.color])
);

/** Per-type stage order (Phase C lock 2026-04-25). These are the active
    stages a job of this type may legitimately occupy. Legacy values are
    NOT in these arrays — they exist in STATUS_MAP for visibility, but
    Phase D will migrate rows out of them. */
export const FENCING_STAGES: CanonicalStatus[] = [
  'draft', 'quoted', 'partially_accepted', 'accepted', 'awaiting_deposit',
  'order_materials', 'awaiting_supplier', 'order_confirmed',
  'scheduled', 'in_progress', 'complete', 'invoiced',
  'cancelled', 'archived'
];

export const PATIO_STAGES: CanonicalStatus[] = [
  'draft', 'quoted', 'accepted', 'awaiting_deposit', 'approvals',
  'order_materials', 'awaiting_supplier', 'order_confirmed',
  'scheduled', 'in_progress', 'complete', 'invoiced',
  'cancelled', 'archived'
];

export const DECKING_STAGES: CanonicalStatus[] = PATIO_STAGES;

export const QUICK_QUOTE_STAGES: CanonicalStatus[] = [
  'draft', 'quoted', 'accepted', 'cancelled', 'archived'
];

/** Make-safe jobs are work-order driven, not quote/deposit/material driven.
    Substage detail such as "company contact required", "waiting on trade
    report", and "admin to send report" lives in the make-safe overlay table;
    the core jobs.status remains the simple high-level pipeline stage. */
export const MAKESAFE_STAGES: CanonicalStatus[] = [
  'accepted', 'scheduled', 'in_progress', 'complete', 'invoiced',
  'cancelled', 'archived'
];

/** Type-stage validity — true if the status is allowed for the given type. */
export function isLegalForType(status: string, type: JobType | string | null | undefined): boolean {
  const arr = getStagesForType(type);
  return arr.includes(status as CanonicalStatus);
}

export function getStagesForType(type: JobType | string | null | undefined): CanonicalStatus[] {
  switch (type) {
    case 'fencing':     return FENCING_STAGES;
    case 'patio':       return PATIO_STAGES;
    case 'decking':     return DECKING_STAGES;
    case 'quick_quote': return QUICK_QUOTE_STAGES;
    case 'makesafe':    return MAKESAFE_STAGES;
    default:            return PATIO_STAGES; // safest default
  }
}

/** All statuses that appear on the kanban for a given type, in order. Used
    by ops.html and by daily-digest filter expansion. Includes legacy values
    so jobs in `processing` / `deposit` etc. still render until migrated. */
export function getKanbanStagesForType(type: JobType | string | null | undefined): CanonicalStatus[] {
  return getStagesForType(type);
}

/** All canonical statuses (the universe of values a job may legitimately
    have today). Used by ops-api pipeline filter, daily-digest substage
    expansion, MCP enum, and any place that needs "every status that exists
    in production". */
export const ALL_CANONICAL_STATUSES: CanonicalStatus[] = Object.keys(STATUS_MAP) as CanonicalStatus[];

/** Active (non-terminal) statuses across all types. Used by the pipeline
    handler to pull "live" jobs (excludes cancelled/archived/lost). */
export const ACTIVE_STATUSES: CanonicalStatus[] = ALL_CANONICAL_STATUSES.filter(
  s => STATUS_MAP[s].bucket !== 'terminal'
);

/** Pipeline Visibility Guard — the contract every consumer enforces.
    Returns a structured mapping result so unknown statuses NEVER disappear
    from a UI. They land in `status_mapping_gap` with a low-confidence
    flag. Marnin's recurring rule: jobs must never be silently filtered. */
export interface StatusMappingResult {
  source_status: string | null;
  normalized_status: CanonicalStatus | null;
  frontend_bucket: FrontendBucket;
  status_mapped_for_pipeline: boolean;
  legacy: boolean;
  derived_view: boolean;
  reason: 'mapped' | 'missing' | 'unknown';
  human: string | null;
  color: string | null;
  owner: StageOwner | null;
  jarvis_posture: JarvisPosture | null;
}

export function mapStatus(status: string | null | undefined): StatusMappingResult {
  if (status == null || status === '') {
    return {
      source_status: status ?? null,
      normalized_status: null,
      frontend_bucket: 'status_mapping_gap',
      status_mapped_for_pipeline: false,
      legacy: false,
      derived_view: false,
      reason: 'missing',
      human: null,
      color: null,
      owner: null,
      jarvis_posture: null
    };
  }
  const key = String(status).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(STATUS_MAP, key)) {
    const e = STATUS_MAP[key];
    return {
      source_status: status,
      normalized_status: key as CanonicalStatus,
      frontend_bucket: e.bucket,
      status_mapped_for_pipeline: true,
      legacy: !!e.legacy,
      derived_view: !!e.derived_view,
      reason: 'mapped',
      human: e.human,
      color: e.color,
      owner: e.owner,
      jarvis_posture: e.jarvis_posture
    };
  }
  return {
    source_status: status,
    normalized_status: null,
    frontend_bucket: 'status_mapping_gap',
    status_mapped_for_pipeline: false,
    legacy: false,
    derived_view: false,
    reason: 'unknown',
    human: null,
    color: null,
    owner: null,
    jarvis_posture: null
  };
}

/** A short human-readable status mapping description for prompts/docs. */
export const STATUS_ENUM_DESCRIPTION =
  'New status. Allowed values: ' + ALL_CANONICAL_STATUSES.join('|') +
  '. Per-type validity is enforced server-side. ' +
  'Legacy values (deposit/processing/lost/rectification/final_payment/get_review/schedule_install) ' +
  'still exist in production but are migration targets — prefer canonical names.';

export const VERSION = 'cap1a-state-machine-2026-05-01';

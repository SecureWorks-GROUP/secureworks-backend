// Which GoHighLevel opportunity an office status move may change.
//
// Every office status maps to a stage in the trade's EXECUTION pipeline
// (OPS_TO_GHL_STAGES in index.ts). A job's ghl_opportunity_id is usually its
// SALES opportunity: when the Sales opportunity reaches the accepted stage
// (fencing "Job Accepted Chase Deposit", patio "Job Won / Move to Execution")
// GoHighLevel's own workflow creates a NEW Execution opportunity for the same
// contact, and the Sales opportunity stays in the Sales pipeline. GoHighLevel
// refuses an Execution stage on a Sales opportunity (400
// OPPORTUNITY_STAGE_ID_INVALID), so the move must go to the Execution
// opportunity, or nowhere.
//
// This module decides only. It reads, never writes, and never changes which
// opportunity the job points at.

export type GhlOpportunityLike = {
  id?: unknown
  pipelineId?: unknown
  pipeline_id?: unknown
  pipelineStageId?: unknown
  contactId?: unknown
  contact?: { id?: unknown } | null
  status?: unknown
  createdAt?: unknown
  lastStageChangeAt?: unknown
}

export type StageMoveNotMovedReason =
  | 'opportunity_unreadable'
  | 'opportunity_in_other_pipeline'
  | 'opportunity_not_live'
  | 'sales_acceptance_unproven'
  | 'execution_candidate_unreadable'
  | 'execution_opportunity_not_created'
  | 'execution_opportunity_ambiguous'
  | 'execution_search_incomplete'

export type StageMoveTarget =
  | {
    kind: 'move'
    opportunityId: string
    // The job's own opportunity when the move goes to its Execution twin; null
    // when the job's own opportunity already sits in the Execution pipeline.
    salesOpportunityId: string | null
  }
  | { kind: 'not_moved'; reason: StageMoveNotMovedReason; message: string }

// The Sales stage whose arrival makes GoHighLevel create the Execution
// opportunity. Mirrors send-quote's quoteAcceptedStageId (PR #1397).
export const SALES_ACCEPTED_STAGE_BY_TYPE: Record<string, string> = {
  fencing: '338b7dd7-7220-4abc-bc0b-b8d9ea44f40e', // Job Accepted Chase Deposit
  patio: 'a0f3002f-db71-4b69-842a-12930bdd7591', // Job Won / Move to Execution
}

// GoHighLevel's opportunity statuses are open, won, lost and abandoned. Only
// open and won are live work; lost, abandoned, a missing or an unknown status
// is never moved.
const LIVE_OPPORTUNITY_STATUSES = new Set(['open', 'won'])
const DEAD_OPPORTUNITY_STATUSES = new Set(['lost', 'abandoned'])

function statusOf(opp: GhlOpportunityLike | null | undefined): string {
  return text(opp?.status).toLowerCase()
}

export function opportunityIsLive(opp: GhlOpportunityLike | null | undefined): boolean {
  return LIVE_OPPORTUNITY_STATUSES.has(statusOf(opp))
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function ms(value: unknown): number | null {
  const s = text(value)
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

export function opportunityPipelineId(opp: GhlOpportunityLike | null | undefined): string {
  return text(opp?.pipelineId) || text(opp?.pipeline_id)
}

export function opportunityContactId(opp: GhlOpportunityLike | null | undefined): string {
  return text(opp?.contactId) || text(opp?.contact?.id)
}

/**
 * The earliest instant an Execution opportunity made for THIS Sales
 * opportunity can carry: when it arrived at its accepted stage (GoHighLevel's
 * workflow makes the Execution opportunity on that arrival). Proved only while
 * the Sales opportunity still sits at that stage with a readable arrival time.
 * Anything else is null: the Sales creation time is NOT a substitute, because
 * a same-contact Execution opportunity created between that creation and an
 * unknown acceptance can belong to an earlier job.
 */
export function executionCreatedNotBefore(
  sales: GhlOpportunityLike,
  jobType: string,
): number | null {
  const acceptedStage = SALES_ACCEPTED_STAGE_BY_TYPE[jobType]
  if (!acceptedStage || text(sales.pipelineStageId) !== acceptedStage) return null
  const arrived = ms(sales.lastStageChangeAt)
  if (arrived === null) return null
  const created = ms(sales.createdAt)
  if (created !== null && arrived < created) return null
  return arrived
}

/**
 * Decide where an Execution-pipeline stage may be sent.
 *
 * - The job's opportunity is already in the Execution pipeline: move it while
 *   it is live (open or won).
 * - It is in the trade's Sales pipeline and its acceptance time is proved
 *   (executionCreatedNotBefore): move the ONE live Execution opportunity for
 *   the same contact created at or after that acceptance. A candidate counts
 *   only when its pipeline equals the Execution pipeline and its status is
 *   readable; an in-window candidate missing either moves nothing. No proved
 *   acceptance, none yet, several, or a search that did not reach its end: do
 *   not move anything.
 * - Any other pipeline: do not move anything.
 */
export function chooseStageMoveTarget(input: {
  opportunity: GhlOpportunityLike | null
  jobType: string
  executionPipelineId: string
  salesPipelineId: string
  // Execution-pipeline search rows for the opportunity's contact. Only read
  // when the opportunity is in the Sales pipeline.
  executionCandidates?: GhlOpportunityLike[]
  executionSearchComplete?: boolean
}): StageMoveTarget {
  const opp = input.opportunity
  const ownId = text(opp?.id)
  const pipelineId = opportunityPipelineId(opp)
  if (!opp || !ownId || !pipelineId) {
    return {
      kind: 'not_moved',
      reason: 'opportunity_unreadable',
      message: 'GoHighLevel did not return the opportunity and its pipeline, so no stage was sent',
    }
  }
  if (pipelineId === input.executionPipelineId) {
    if (!opportunityIsLive(opp)) {
      return {
        kind: 'not_moved',
        reason: 'opportunity_not_live',
        message: `The job's Execution opportunity is ${statusOf(opp) || 'of unknown status'}, not open or won, so no stage was sent`,
      }
    }
    return { kind: 'move', opportunityId: ownId, salesOpportunityId: null }
  }
  if (pipelineId !== input.salesPipelineId) {
    return {
      kind: 'not_moved',
      reason: 'opportunity_in_other_pipeline',
      message: `The job's opportunity is not in the ${input.jobType} Sales or Execution pipeline, so no stage was sent`,
    }
  }

  const contactId = opportunityContactId(opp)
  const notBefore = executionCreatedNotBefore(opp, input.jobType)
  if (notBefore === null) {
    return {
      kind: 'not_moved',
      reason: 'sales_acceptance_unproven',
      message:
        "The job's Sales opportunity is not at its accepted stage with a readable arrival time, so its Execution opportunity cannot be told apart from an earlier job's and no stage was sent",
    }
  }
  // Same contact (GoHighLevel may ignore the contact filter, so it must be
  // proven) and created at or after this acceptance.
  const inWindow = (input.executionCandidates || []).filter((row) => {
    const id = text(row.id)
    if (!id || id === ownId) return false
    if (!contactId || opportunityContactId(row) !== contactId) return false
    const created = ms(row.createdAt)
    return created !== null && created >= notBefore
  })
  // An in-window row whose pipeline or status cannot be read could be a Sales
  // opportunity or a dead one: send nothing rather than guess.
  const unverified = inWindow.filter((row) => {
    const status = statusOf(row)
    return !opportunityPipelineId(row) || !(LIVE_OPPORTUNITY_STATUSES.has(status) || DEAD_OPPORTUNITY_STATUSES.has(status))
  })
  if (unverified.length > 0) {
    return {
      kind: 'not_moved',
      reason: 'execution_candidate_unreadable',
      message: 'GoHighLevel did not say which pipeline or status a matching opportunity is in, so no stage was sent',
    }
  }
  const matches = inWindow.filter((row) => opportunityPipelineId(row) === input.executionPipelineId && opportunityIsLive(row))
  const ids = [...new Set(matches.map((row) => text(row.id)))]

  if (ids.length > 1) {
    return {
      kind: 'not_moved',
      reason: 'execution_opportunity_ambiguous',
      message: `${ids.length} Execution opportunities match this job's contact, so no stage was sent`,
    }
  }
  if (!input.executionSearchComplete) {
    return {
      kind: 'not_moved',
      reason: 'execution_search_incomplete',
      message: 'The Execution pipeline search did not finish, so no stage was sent',
    }
  }
  if (ids.length === 0) {
    return {
      kind: 'not_moved',
      reason: 'execution_opportunity_not_created',
      message:
        "The job's opportunity is still in the Sales pipeline and GoHighLevel has not made its Execution opportunity yet, so no stage was sent",
    }
  }
  return { kind: 'move', opportunityId: ids[0], salesOpportunityId: ownId }
}

// At most this many search rows are re-read for a pipeline or status the
// search left out; any still unreadable after that moves nothing.
const MAX_CANDIDATE_REREADS = 5

function candidateNeedsReread(row: GhlOpportunityLike): boolean {
  const status = statusOf(row)
  return !opportunityPipelineId(row) || !(LIVE_OPPORTUNITY_STATUSES.has(status) || DEAD_OPPORTUNITY_STATUSES.has(status))
}

/**
 * Reads GoHighLevel and decides. `readOpportunity` is index.ts's ghl() (GET
 * only). A search row without a pipeline or a known status is re-read by id
 * before it can count.
 */
export async function resolveStageMoveTarget(args: {
  opportunityId: string
  jobType: string
  executionPipelineId: string
  salesPipelineId: string
  // deno-lint-ignore no-explicit-any
  readOpportunity: (id: string) => Promise<any>
  searchExecution: (args: { pipelineId: string; contactId: string }) => Promise<{
    opportunities: GhlOpportunityLike[]
    exhausted: boolean
  }>
}): Promise<StageMoveTarget> {
  const data = await args.readOpportunity(args.opportunityId)
  const opportunity: GhlOpportunityLike | null = data?.opportunity ?? null
  const pipelineId = opportunityPipelineId(opportunity)
  const contactId = opportunityContactId(opportunity)
  const needsSearch = pipelineId === args.salesPipelineId && !!contactId
  const search = needsSearch
    ? await args.searchExecution({ pipelineId: args.executionPipelineId, contactId })
    : { opportunities: [], exhausted: true }
  let rereads = 0
  const candidates: GhlOpportunityLike[] = []
  for (const row of search.opportunities || []) {
    const id = text(row?.id)
    if (!id || id === text(opportunity?.id) || !candidateNeedsReread(row) || rereads >= MAX_CANDIDATE_REREADS) {
      candidates.push(row)
      continue
    }
    rereads++
    const fresh: GhlOpportunityLike | null = (await args.readOpportunity(id))?.opportunity ?? null
    // Only the opportunity asked for replaces the row; anything else leaves the
    // row unreadable, so it moves nothing.
    candidates.push(fresh && text(fresh.id) === id ? fresh : row)
  }
  return chooseStageMoveTarget({
    opportunity,
    jobType: args.jobType,
    executionPipelineId: args.executionPipelineId,
    salesPipelineId: args.salesPipelineId,
    executionCandidates: candidates,
    executionSearchComplete: search.exhausted,
  })
}

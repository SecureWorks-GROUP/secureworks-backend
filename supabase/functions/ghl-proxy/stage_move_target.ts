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

// Execution opportunities that are no longer live work are never a target.
const DEAD_OPPORTUNITY_STATUSES = new Set(['lost', 'abandoned'])

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
 * opportunity can carry. While the Sales opportunity sits at its accepted
 * stage, that is when it arrived there (the workflow fires on arrival).
 * Otherwise it is the Sales opportunity's creation: an Execution opportunity
 * created before that belongs to an earlier job for the same contact.
 */
export function executionCreatedNotBefore(
  sales: GhlOpportunityLike,
  jobType: string,
): number | null {
  const created = ms(sales.createdAt)
  const acceptedStage = SALES_ACCEPTED_STAGE_BY_TYPE[jobType]
  const atAccepted = !!acceptedStage && text(sales.pipelineStageId) === acceptedStage
  const arrived = atAccepted ? ms(sales.lastStageChangeAt) : null
  if (arrived !== null && (created === null || arrived >= created)) return arrived
  return created
}

/**
 * Decide where an Execution-pipeline stage may be sent.
 *
 * - The job's opportunity is already in the Execution pipeline: move it.
 * - It is in the trade's Sales pipeline: move the ONE live Execution
 *   opportunity for the same contact created at or after the Sales accept
 *   (see executionCreatedNotBefore). None yet, several, or a search that did
 *   not reach its end: do not move anything.
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
  const matches = (input.executionCandidates || []).filter((row) => {
    const id = text(row.id)
    if (!id || id === ownId) return false
    const rowPipeline = opportunityPipelineId(row)
    if (rowPipeline && rowPipeline !== input.executionPipelineId) return false
    // GoHighLevel may ignore the contact filter: the contact must be proven.
    if (!contactId || opportunityContactId(row) !== contactId) return false
    if (DEAD_OPPORTUNITY_STATUSES.has(text(row.status).toLowerCase())) return false
    const created = ms(row.createdAt)
    if (created === null || notBefore === null) return false
    return created >= notBefore
  })
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

/** Reads GoHighLevel and decides. `read` is index.ts's ghl() (GET only). */
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
  return chooseStageMoveTarget({
    opportunity,
    jobType: args.jobType,
    executionPipelineId: args.executionPipelineId,
    salesPipelineId: args.salesPipelineId,
    executionCandidates: search.opportunities,
    executionSearchComplete: search.exhausted,
  })
}

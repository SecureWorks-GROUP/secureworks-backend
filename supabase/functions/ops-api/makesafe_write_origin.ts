// Typed write origins for the make-safe substatus writer.
//
// The origin is policy input, not free-form text. Keep the caller class in the
// discriminant and the human/useful detail separate so policy never has to
// parse a prefix such as `internal:intake_`.

export type MakesafeWriteOrigin =
  | { class: 'agent'; detail: string }
  | { class: 'ops_ui'; detail: string }
  | { class: 'internal_evidence_event'; detail: string }
  | { class: 'intake'; detail: string }
  | { class: 'unidentified'; detail: string }

export type MakesafeCallerSignal =
  | { class: 'agent'; detail?: string }
  | { class: 'ops_ui'; detail?: string }

const MAKESAFE_OPAQUE_CALLER_DETAILS = new Set([
  'automation',
  'integration',
  'mcp',
  'ops_dashboard',
])

/** One-line later flip. Shipped loose by firstmate ruled captain decision. */
export const MAKESAFE_AGENT_MONEY_STAGE_FENCE_STRICT = false

export const MAKESAFE_MONEY_STAGE_SUBSTATUSES = [
  'ready_to_invoice',
  'complete',
] as const

export type MakesafeMoneyStageSubstatus = typeof MAKESAFE_MONEY_STAGE_SUBSTATUSES[number]

export interface MakesafeMoneyStageFenceObservation {
  marker: 'makesafe_agent_money_stage_fence'
  fence: 'agent_money_stage'
  caller_class: MakesafeWriteOrigin['class']
  caller_detail: string
  auth_mode: string | null
  next_substatus: string
  strict_enabled: boolean
  strict_would_refuse: boolean
  enforcement: 'observe' | 'refuse'
}

export interface MakesafeMoneyStageFenceDecision {
  is_money_stage: boolean
  strict_would_refuse: boolean
  refusal: { status: 403; message: string } | null
}

export function internalEvidenceOrigin(detail: string): MakesafeWriteOrigin {
  return { class: 'internal_evidence_event', detail }
}

export function intakeOrigin(detail: string): MakesafeWriteOrigin {
  return { class: 'intake', detail }
}

export function unidentifiedOrigin(detail: string): MakesafeWriteOrigin {
  return { class: 'unidentified', detail }
}

/** Legacy text form for messages only; policy never parses this value. */
export function describeMakesafeWriteOrigin(
  origin: MakesafeWriteOrigin,
): string {
  if (origin.class === 'intake') return `internal:intake_${origin.detail}`
  if (origin.class === 'internal_evidence_event') {
    return `internal:${origin.detail}`
  }
  return origin.detail
}

/**
 * Convert the explicit per-request caller signal into policy data.
 *
 * Missing, malformed, or unsupported signals are deliberately unidentified.
 * That is the captain's loose ruling: existing callers keep their current
 * behaviour while the log records that the signal was absent/invalid.
 */
export function makesafeExternalWriteOrigin(
  body: unknown,
  detail: string,
): MakesafeWriteOrigin {
  const raw = (body as { caller?: unknown } | null)?.caller
  if (!raw || typeof raw !== 'object') return unidentifiedOrigin(detail)

  const signal = raw as { class?: unknown; detail?: unknown }
  if (signal.class !== 'agent' && signal.class !== 'ops_ui') {
    return unidentifiedOrigin(`${detail}:invalid_signal`)
  }

  const signalDetail = normaliseMakesafeCallerDetail(signal.detail)
  return { class: signal.class, detail: signalDetail }
}

function normaliseMakesafeCallerDetail(value: unknown): string {
  if (typeof value !== 'string') return 'unspecified'
  const detail = value.trim().toLowerCase()
  return MAKESAFE_OPAQUE_CALLER_DETAILS.has(detail) ? detail : 'unspecified'
}

export function evaluateMakesafeMoneyStageFence(
  nextSubstatus: string,
  origin: MakesafeWriteOrigin,
  strictEnabled = MAKESAFE_AGENT_MONEY_STAGE_FENCE_STRICT,
): MakesafeMoneyStageFenceDecision {
  const isMoneyStage = (MAKESAFE_MONEY_STAGE_SUBSTATUSES as readonly string[])
    .includes(nextSubstatus)
  const strictWouldRefuse = isMoneyStage && origin.class === 'agent'
  return {
    is_money_stage: isMoneyStage,
    strict_would_refuse: strictWouldRefuse,
    refusal: strictEnabled && strictWouldRefuse
      ? {
        status: 403,
        message: `agent money-stage fence refused substatus='${nextSubstatus}' (caller=${origin.detail})`,
      }
      : null,
  }
}

export function observeMakesafeMoneyStageFence(
  nextSubstatus: string,
  origin: MakesafeWriteOrigin,
  authMode: string | undefined,
): MakesafeMoneyStageFenceObservation | null {
  const decision = evaluateMakesafeMoneyStageFence(nextSubstatus, origin)
  if (!decision.is_money_stage) return null
  return {
    marker: 'makesafe_agent_money_stage_fence',
    fence: 'agent_money_stage',
    caller_class: origin.class,
    caller_detail: origin.detail,
    auth_mode: authMode || null,
    next_substatus: nextSubstatus,
    strict_enabled: MAKESAFE_AGENT_MONEY_STAGE_FENCE_STRICT,
    strict_would_refuse: decision.strict_would_refuse,
    enforcement: decision.refusal ? 'refuse' : 'observe',
  }
}

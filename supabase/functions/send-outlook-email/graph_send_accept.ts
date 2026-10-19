// Graph's final /send answers 202 with an empty body. A 2xx is accepted only
// when its body is empty or readable JSON with no error in it; a 2xx carrying
// an error, or one whose body cannot be read, is an unknown outcome (the send
// may have landed), never "sent" and never a definite failure.

export class GraphSendNotConfirmed extends Error {
  readonly outcomeUnknown = true
  readonly context = { retry_safe: false }
  constructor(readonly status: number, readonly reason: 'error_body' | 'unreadable_body') {
    super(`Graph send not confirmed (${status}, ${reason})`)
    this.name = 'GraphSendNotConfirmed'
  }
}

/** Throws GraphSendNotConfirmed unless response is a clean Graph send acceptance. */
export async function assertGraphSendAccepted(response: Response | null | undefined): Promise<void> {
  if (!response || typeof (response as Response).status !== 'number') {
    throw new GraphSendNotConfirmed(0, 'unreadable_body')
  }
  const status = response.status
  if (status < 200 || status >= 300) throw new GraphSendNotConfirmed(status, 'error_body')
  let text: string
  try {
    text = await response.clone().text()
  } catch {
    throw new GraphSendNotConfirmed(status, 'unreadable_body')
  }
  const trimmed = text.trim()
  if (!trimmed) return
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new GraphSendNotConfirmed(status, 'unreadable_body')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GraphSendNotConfirmed(status, 'unreadable_body')
  }
  const body = parsed as Record<string, unknown>
  if (body.error != null || body.success === false || body.outcomeUnknown === true || body.outcome_unknown === true) {
    throw new GraphSendNotConfirmed(status, 'error_body')
  }
}

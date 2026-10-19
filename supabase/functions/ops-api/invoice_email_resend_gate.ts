// The resend gate for invoice emails.
//
// An invoice email whose outcome is unknown (send-outlook-email said
// `outcome_unknown` / `retry_safe: false`, a bare 408/429/5xx, or the call
// itself threw) may already have reached the client. Recording it as unknown
// is not enough on its own: the next press must not send again until someone
// has checked the Sent Items folder of the sending mailbox and said so.
//
// The record is kept in two places, because each can be missing:
//   - business_events (entity_type 'xero_invoice', entity_id = the Xero id),
//     written through logBusinessEvent, which the capture lane can switch off;
//   - job_events (detail_json.xero_invoice_id), always written when the
//     invoice is linked to a job (job_events.job_id is NOT NULL).
// The gate reads both and takes the newest of the three event types. Either
// read failing refuses the send: "I could not tell" is never "nothing pending".

export const INVOICE_EMAIL_EMAILED_EVENT = 'invoice.emailed'
export const INVOICE_EMAIL_OUTCOME_UNKNOWN_EVENT = 'invoice.email_outcome_unknown'
export const INVOICE_EMAIL_OUTCOME_RECONCILED_EVENT = 'invoice.email_outcome_reconciled'

const GATE_EVENT_TYPES = [
  INVOICE_EMAIL_EMAILED_EVENT,
  INVOICE_EMAIL_OUTCOME_UNKNOWN_EVENT,
  INVOICE_EMAIL_OUTCOME_RECONCILED_EVENT,
]

export type InvoiceEmailGateState =
  | { state: 'clear' }
  | { state: 'unreconciled'; unknown_since: string }
  | { state: 'unreadable'; reason: string }

type GateRow = { event_type: string; at: string }

function newest(rows: GateRow[]): GateRow | null {
  let best: GateRow | null = null
  for (const row of rows) {
    if (!row || typeof row.at !== 'string' || !GATE_EVENT_TYPES.includes(row.event_type)) continue
    if (!best || Date.parse(row.at) > Date.parse(best.at)) best = row
  }
  return best
}

/** Pure: the gate's answer from the rows both stores returned. */
export function invoiceEmailGateFromRows(rows: GateRow[]): InvoiceEmailGateState {
  const latest = newest(rows)
  if (latest && latest.event_type === INVOICE_EMAIL_OUTCOME_UNKNOWN_EVENT) {
    return { state: 'unreconciled', unknown_since: latest.at }
  }
  return { state: 'clear' }
}

export async function readInvoiceEmailGate(client: any, xeroInvoiceId: string): Promise<InvoiceEmailGateState> {
  try {
    const [be, je] = await Promise.all([
      client.from('business_events')
        .select('event_type, occurred_at')
        .eq('entity_type', 'xero_invoice')
        .eq('entity_id', xeroInvoiceId)
        .in('event_type', GATE_EVENT_TYPES)
        .order('occurred_at', { ascending: false })
        .limit(1),
      client.from('job_events')
        .select('event_type, created_at')
        .eq('detail_json->>xero_invoice_id', xeroInvoiceId)
        .in('event_type', GATE_EVENT_TYPES)
        .order('created_at', { ascending: false })
        .limit(1),
    ])
    if (be?.error) return { state: 'unreadable', reason: `business_events: ${be.error.message || 'read failed'}` }
    if (je?.error) return { state: 'unreadable', reason: `job_events: ${je.error.message || 'read failed'}` }
    const rows: GateRow[] = [
      ...((be?.data || []) as any[]).map((r) => ({ event_type: r.event_type, at: r.occurred_at })),
      ...((je?.data || []) as any[]).map((r) => ({ event_type: r.event_type, at: r.created_at })),
    ]
    return invoiceEmailGateFromRows(rows)
  } catch (e) {
    return { state: 'unreadable', reason: (e as Error)?.message || 'read threw' }
  }
}

/** The refusal body for a send the gate holds. Never names a raw downstream error. */
export function invoiceEmailGateRefusal(xeroInvoiceId: string, gate: InvoiceEmailGateState) {
  if (gate.state === 'unreadable') {
    return {
      error: 'Could not read whether an earlier email of this invoice is still unconfirmed, so nothing was sent. Try again shortly.',
      code: 'invoice_email_gate_unreadable',
      xero_invoice_id: xeroInvoiceId,
      retry_safe: true,
    }
  }
  return {
    error: 'An earlier email of this invoice may already have reached the client. Check the Sent Items folder of the sending mailbox (or, for an invoice Xero emailed itself, the invoice History in Xero) before sending again. If it is not there, resend with sent_items_checked set to true.',
    code: 'invoice_email_outcome_unreconciled',
    xero_invoice_id: xeroInvoiceId,
    unknown_since: gate.state === 'unreconciled' ? gate.unknown_since : null,
    retry_safe: false,
  }
}

/** Writes a gate event to job_events when the invoice is linked to a job. Never throws. */
export async function writeInvoiceEmailGateJobEvent(
  client: any,
  jobId: string | null,
  eventType: string,
  detail: Record<string, unknown>,
): Promise<boolean> {
  if (!jobId) return false
  try {
    const { error } = await client.from('job_events').insert({ job_id: jobId, event_type: eventType, detail_json: detail })
    if (error) {
      console.error(JSON.stringify({ event: 'invoice_email_gate_job_event_failed', event_type: eventType, error: error.message }))
      return false
    }
    return true
  } catch (e) {
    console.error(JSON.stringify({ event: 'invoice_email_gate_job_event_failed', event_type: eventType, error: (e as Error)?.message }))
    return false
  }
}

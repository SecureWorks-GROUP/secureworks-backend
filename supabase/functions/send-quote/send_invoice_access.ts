/**
 * Tenant-first /send-invoice authorization (TRD6-REV13-002).
 *
 * After the invoice lookup, tenancy is enforced immediately. Binding and
 * sealed-job inspection run only for a caller who already passed that
 * check. JWT callers who cannot see the invoice get a generic 404 with
 * no foreign job id, sealed fact, or binding detail.
 */

import {
  sealedSesFenceCheckFailedRefusal,
  sealedSesMoneyRefusal,
  SealedSesMoneyFenceLookupError,
  type SealedSesJobInspection,
} from '../_shared/sealed_ses_money_fence.ts'
import { validateBrandedInvoiceDeliveryBinding } from './invoice_delivery_fence.ts'
import { quoteSendTenantAccess } from './quote_send_auth.ts'

export type SendInvoiceAccessStep =
  | 'invoice_lookup'
  | 'job_lookup'
  | 'tenant'
  | 'binding'
  | 'sealed'

export type SendInvoiceMirrorRow = {
  invoice_type?: string | null
  job_id?: string | null
  invoice_obligation_revision_id?: string | null
  ses_external_token?: string | null
  invoice_number?: string | null
  total?: unknown
  due_date?: string | null
}

export type SendInvoiceJobRow = {
  job_number?: string | null
  type?: string | null
  ghl_contact_id?: string | null
  org_id?: string | null
  client_email?: string | null
  client_name?: string | null
  site_address?: string | null
  site_suburb?: string | null
}

export type SendInvoiceAccessOk = {
  ok: true
  invoice: SendInvoiceMirrorRow
  job: SendInvoiceJobRow | null
  steps: SendInvoiceAccessStep[]
}

export type SendInvoiceAccessDenied = {
  ok: false
  status: number
  body: Record<string, unknown>
  steps: SendInvoiceAccessStep[]
}

export type SendInvoiceAccessResult = SendInvoiceAccessOk | SendInvoiceAccessDenied

export const SEND_INVOICE_GENERIC_NOT_FOUND = {
  error: 'Invoice not found',
  code: 'invoice_not_found',
} as const

export function sendInvoiceGenericNotFound(): typeof SEND_INVOICE_GENERIC_NOT_FOUND {
  return { ...SEND_INVOICE_GENERIC_NOT_FOUND }
}

export type SendInvoiceAccessDeps = {
  loadInvoice: () => Promise<{
    data: SendInvoiceMirrorRow | null
    error: { message?: string } | null
  }>
  loadJob: (jobId: string) => Promise<{
    data: SendInvoiceJobRow | null
    error: { message?: string } | null
  }>
  inspectSealedJob: (
    jobId: string,
  ) => Promise<SealedSesJobInspection>
}

function deny(
  steps: SendInvoiceAccessStep[],
  status: number,
  body: Record<string, unknown>,
): SendInvoiceAccessDenied {
  return { ok: false, status, body, steps }
}

export async function authorizeSendInvoiceAccess(input: {
  authMode: 'api_key' | 'jwt'
  callerOrgId: string | null | undefined
  bodyJobId: string
  xeroInvoiceId: string
  deps: SendInvoiceAccessDeps
}): Promise<SendInvoiceAccessResult> {
  const steps: SendInvoiceAccessStep[] = []
  const jwt = input.authMode === 'jwt'

  steps.push('invoice_lookup')
  const invoiceRead = await input.deps.loadInvoice()
  if (invoiceRead.error) {
    if (jwt) return deny(steps, 404, sendInvoiceGenericNotFound())
    const refusal = sealedSesFenceCheckFailedRefusal(
      'send-quote/send-invoice',
      invoiceRead.error.message || 'The invoice is missing from the local Xero mirror.',
      { xero_invoice_id: input.xeroInvoiceId },
    )
    return deny(steps, 503, { success: false, refusal, error: refusal.fact })
  }
  if (!invoiceRead.data) {
    if (jwt) return deny(steps, 404, sendInvoiceGenericNotFound())
    const refusal = sealedSesFenceCheckFailedRefusal(
      'send-quote/send-invoice',
      'The invoice is missing from the local Xero mirror.',
      { xero_invoice_id: input.xeroInvoiceId },
    )
    return deny(steps, 503, { success: false, refusal, error: refusal.fact })
  }
  const invoice = invoiceRead.data
  const linkedJobId = typeof invoice.job_id === 'string' ? invoice.job_id.trim() : ''

  steps.push('job_lookup')
  let job: SendInvoiceJobRow | null = null
  if (linkedJobId) {
    const jobRead = await input.deps.loadJob(linkedJobId)
    if (jobRead.error) {
      if (jwt) return deny(steps, 404, sendInvoiceGenericNotFound())
      return deny(steps, 503, { error: 'Invoice job could not be read' })
    }
    job = jobRead.data
  }

  steps.push('tenant')
  const tenant = quoteSendTenantAccess(input.authMode, input.callerOrgId, job?.org_id)
  if (!tenant.ok) {
    return deny(steps, 404, sendInvoiceGenericNotFound())
  }

  steps.push('binding')
  const binding = validateBrandedInvoiceDeliveryBinding(
    invoice,
    input.bodyJobId,
    input.xeroInvoiceId,
  )
  if (!binding.allowed) {
    return deny(steps, binding.status, {
      success: false,
      refusal: binding.refusal,
      error: binding.refusal.fact,
    })
  }

  steps.push('sealed')
  let linkedJobInspection: SealedSesJobInspection
  try {
    linkedJobInspection = await input.deps.inspectSealedJob(linkedJobId)
  } catch (error) {
    if (!(error instanceof SealedSesMoneyFenceLookupError)) throw error
    const refusal = sealedSesFenceCheckFailedRefusal(
      'send-quote/send-invoice',
      error.message,
      { xero_invoice_id: input.xeroInvoiceId, job_id: linkedJobId },
    )
    return deny(steps, 503, { success: false, refusal, error: refusal.fact })
  }
  if (linkedJobInspection.sealed) {
    const refusal = sealedSesMoneyRefusal('send-quote/send-invoice', {
      linked_job_id: linkedJobId,
      linked_job_matched_by: linkedJobInspection.matched_by,
    })
    return deny(steps, 409, { success: false, refusal, error: refusal.fact })
  }

  return { ok: true, invoice, job, steps }
}

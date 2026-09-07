// Office/admin send gate for send-quote /send, /send-runs, and /send-invoice
// (TRD6-R6-001, TRD6-R12-004).
//
// Role names match OPS_API_STAFF_OPERATOR_ROLES in ops-api/index.ts
// (admin / owner / ops_manager). Do not import that file here — it boots
// serve(). Trade, estimator, lead_installer, allocated, and makesafe_open
// are not send authority. API-key / service-role stays office.

export const SEND_QUOTE_STAFF_OPERATOR_ROLES = new Set([
  'admin',
  'owner',
  'ops_manager',
])

export const QUOTE_SEND_OFFICE_PATHS = new Set(['send', 'send-invoice', 'send-runs'])

export const QUOTE_SEND_AUTH_PATHS = new Set([
  'send',
  'send-invoice',
  'send-runs',
])

export function isSendQuoteStaffOperatorRole(role: unknown): boolean {
  return SEND_QUOTE_STAFF_OPERATOR_ROLES.has(String(role || '').toLowerCase())
}

export function quoteSendJwtNeedsOfficeRole(path: string | undefined): boolean {
  return QUOTE_SEND_OFFICE_PATHS.has(String(path || ''))
}

export type SendQuoteAuthUser = {
  id: string
  email: string
  role: string
  orgId: string | null
}

export type SendQuoteAuthAllow = {
  kind: 'allow'
  mode: 'api_key' | 'jwt'
  user: SendQuoteAuthUser | null
}

export type SendQuoteAuthReject = {
  kind: 'reject'
  response: Response
}

export type SendQuoteAuthDecision = SendQuoteAuthAllow | SendQuoteAuthReject

export type QuoteSendTenantAccess =
  | { ok: true }
  | { ok: false; status: 403; error: string; code: 'operator_access_required' }

export const QUOTE_SEND_GENERIC_NOT_FOUND = {
  error: 'Not found',
  code: 'not_found',
} as const

export function quoteSendJwtResourceNotFound(): typeof QUOTE_SEND_GENERIC_NOT_FOUND {
  return { ...QUOTE_SEND_GENERIC_NOT_FOUND }
}

/**
 * JWT callers must not distinguish a missing quote/job from a foreign
 * tenant. API-key office automation may keep the specific 404 / 403.
 */
export function quoteSendMissingOrForeignRefusal(
  authMode: 'api_key' | 'jwt',
  missing: boolean,
  tenant: QuoteSendTenantAccess,
  apiKeyMissingMessage: string,
): { status: number; body: Record<string, unknown> } | null {
  if (missing) {
    if (authMode === 'jwt') {
      return { status: 404, body: quoteSendJwtResourceNotFound() }
    }
    return { status: 404, body: { error: apiKeyMissingMessage } }
  }
  if (!tenant.ok) {
    if (authMode === 'jwt') {
      return { status: 404, body: quoteSendJwtResourceNotFound() }
    }
    return { status: tenant.status, body: { error: tenant.error, code: tenant.code } }
  }
  return null
}

function rejectJson(
  corsHeaders: Record<string, string>,
  status: number,
  body: Record<string, unknown>,
): SendQuoteAuthReject {
  return {
    kind: 'reject',
    response: new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }),
  }
}

function logSendAuth(input: {
  path: string | undefined
  authMode: 'api_key' | 'jwt'
  user: SendQuoteAuthUser | null
  refused?: boolean
  code?: string
}): void {
  console.log('[send-quote] auth', JSON.stringify({
    path: input.path,
    authMode: input.authMode,
    userId: input.user?.id ?? null,
    userEmail: input.user?.email ?? null,
    userRole: input.user?.role ?? null,
    userOrgId: input.user?.orgId ?? null,
    refused: input.refused === true,
    code: input.code ?? null,
  }))
}

export function quoteSendTenantAccess(
  authMode: 'api_key' | 'jwt',
  callerOrgId: string | null | undefined,
  jobOrgId: unknown,
): QuoteSendTenantAccess {
  if (authMode === 'api_key') return { ok: true }
  const caller = String(callerOrgId || '').trim()
  const job = String(jobOrgId || '').trim()
  if (!caller || !job || caller !== job) {
    return {
      ok: false,
      status: 403,
      error: 'Quote send is restricted to office operators for this organisation',
      code: 'operator_access_required',
    }
  }
  return { ok: true }
}

function asTrimmedString(value: unknown): string {
  return String(value ?? '').trim()
}

function asDepositAmount(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export type SendInvoiceDeliverySource = {
  client_email?: unknown
  client_name?: unknown
  type?: unknown
  site_address?: unknown
  site_suburb?: unknown
}

export type SendInvoiceMirrorSource = {
  invoice_number?: unknown
  total?: unknown
  due_date?: unknown
}

export type SendInvoiceDelivery = {
  client_email: string
  client_name: string
  job_type: string
  address: string
  invoice_number: string
  deposit_amount: number
  payment_url: string
  share_token: string
  due_date: string
}

/**
 * JWT callers never supply the recipient or payment fields — those come
 * from the authorized invoice/job after tenancy. API-key (ops-api) may
 * pass already-derived office fields.
 */
export function resolveSendInvoiceDelivery(input: {
  authMode: 'api_key' | 'jwt'
  body: Record<string, unknown> | null | undefined
  job: SendInvoiceDeliverySource | null | undefined
  invoice: SendInvoiceMirrorSource | null | undefined
}): SendInvoiceDelivery {
  const body = input.body && typeof input.body === 'object' && !Array.isArray(input.body)
    ? input.body
    : {}
  const jobEmail = asTrimmedString(input.job?.client_email)
  const jobName = asTrimmedString(input.job?.client_name)
  const jobType = asTrimmedString(input.job?.type)
  const jobAddress = [input.job?.site_address, input.job?.site_suburb]
    .map((part) => asTrimmedString(part))
    .filter(Boolean)
    .join(', ')
  const invoiceNumber = asTrimmedString(input.invoice?.invoice_number)
  const invoiceTotal = asDepositAmount(input.invoice?.total)
  const invoiceDue = asTrimmedString(input.invoice?.due_date)

  if (input.authMode === 'jwt') {
    return {
      client_email: jobEmail,
      client_name: jobName,
      job_type: jobType,
      address: jobAddress,
      invoice_number: invoiceNumber,
      deposit_amount: invoiceTotal,
      payment_url: '',
      share_token: '',
      due_date: invoiceDue,
    }
  }

  return {
    client_email: asTrimmedString(body.client_email) || jobEmail,
    client_name: asTrimmedString(body.client_name) || jobName,
    job_type: asTrimmedString(body.job_type) || jobType,
    address: asTrimmedString(body.address) || jobAddress,
    invoice_number: asTrimmedString(body.invoice_number) || invoiceNumber,
    deposit_amount: asDepositAmount(body.deposit_amount) || invoiceTotal,
    payment_url: asTrimmedString(body.payment_url),
    share_token: asTrimmedString(body.share_token),
    due_date: asTrimmedString(body.due_date) || invoiceDue,
  }
}

export function jobOrgIdFromQuoteSendDocument(doc: {
  jobs?: { org_id?: unknown } | Array<{ org_id?: unknown }> | null
} | null | undefined): unknown {
  const jobs = doc?.jobs
  if (Array.isArray(jobs)) return jobs[0]?.org_id
  return jobs?.org_id
}

export async function decideSendQuoteAuth(input: {
  req: Request
  sb: any
  path: string | undefined
  corsHeaders: Record<string, string>
  swApiKey: string | null | undefined
  serviceRoleKey: string | null | undefined
}): Promise<SendQuoteAuthDecision> {
  const { req, sb, path, corsHeaders, swApiKey, serviceRoleKey } = input
  if (!QUOTE_SEND_AUTH_PATHS.has(String(path || ''))) {
    return { kind: 'allow', mode: 'api_key', user: null }
  }

  const xApiKey = req.headers.get('x-api-key')
  const authHeader = req.headers.get('authorization')
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null

  if (xApiKey && (xApiKey === swApiKey || xApiKey === serviceRoleKey)) {
    logSendAuth({ path, authMode: 'api_key', user: null })
    return { kind: 'allow', mode: 'api_key', user: null }
  }
  if (bearerToken && (bearerToken === swApiKey || bearerToken === serviceRoleKey)) {
    logSendAuth({ path, authMode: 'api_key', user: null })
    return { kind: 'allow', mode: 'api_key', user: null }
  }
  if (!bearerToken) {
    return rejectJson(corsHeaders, 401, { error: 'Unauthorized' })
  }

  try {
    const { data: { user }, error } = await sb.auth.getUser(bearerToken)
    if (error || !user) {
      return rejectJson(corsHeaders, 401, {
        error: 'Session expired — please log in again',
      })
    }

    const { data: profile, error: profileError } = await sb.from('users')
      .select('role, org_id')
      .eq('id', user.id)
      .maybeSingle()
    if (profileError) {
      return rejectJson(corsHeaders, 503, {
        error: 'Operator profile lookup failed — please try again',
        code: 'operator_profile_unreadable',
      })
    }

    const userRecord: SendQuoteAuthUser = {
      id: user.id,
      email: user.email || '',
      role: String(profile?.role || 'unknown'),
      orgId: profile?.org_id != null && String(profile.org_id).trim()
        ? String(profile.org_id)
        : null,
    }

    if (quoteSendJwtNeedsOfficeRole(path) && !isSendQuoteStaffOperatorRole(userRecord.role)) {
      logSendAuth({
        path,
        authMode: 'jwt',
        user: userRecord,
        refused: true,
        code: 'operator_access_required',
      })
      return rejectJson(corsHeaders, 403, {
        error: 'Quote send requires an office operator session',
        code: 'operator_access_required',
      })
    }

    logSendAuth({ path, authMode: 'jwt', user: userRecord })
    return { kind: 'allow', mode: 'jwt', user: userRecord }
  } catch (_e) {
    return rejectJson(corsHeaders, 401, { error: 'Authentication failed' })
  }
}

// Staff gate for reporting-api job_context / job_intelligence.
//
// Role names match OPS_API_STAFF_OPERATOR_ROLES in ops-api/index.ts
// (admin / owner / ops_manager). Do not import that file here — it boots
// serve(). Trade, sales, crew, installer, lead_installer and other non-staff
// JWTs are 403. Service-role and OPS_AGENT_SERVER_KEY stay allowed. The
// public SW_API_KEY is not a server secret (same rule as ops-api).
//
// Callers: ops.html Jarvis panel (staff JWT); ops-ai and ops-api fire-and-forget
// via service role. trade.html / sale.html / ceo.html / index.html do not call
// these two actions. Merge to main auto-deploys reporting-api via
// .github/workflows/deploy-edge-functions.yml (paths include supabase/functions/**).
// Post-deploy: trade login 403 on both actions; staff login still 200.
//
// Tell Jarvis (ops.html submitJarvisContext) POSTs ops-api add_job_context with
// value.source = ops_dashboard. That action has no handler in ops-api or
// reporting-api; ops-api default returns 400 Unknown action (index.ts default
// branch). Production has zero job_context rows with value.source =
// ops_dashboard (all time). The UI shows Failed to save (opsPost throws on
// 400); it does not swallow the error. Do not implement add_job_context here.
// Repair belongs to the dashboard: wire the box onto existing add_note later.

export const REPORTING_API_STAFF_OPERATOR_ROLES = new Set([
  'admin',
  'owner',
  'ops_manager',
])

export const REPORTING_API_STAFF_ACTIONS = new Set([
  'job_context',
  'job_intelligence',
])

export const REPORTING_STAFF_JWT_REQUIRED = {
  status: 401 as const,
  code: 'user_jwt_required',
  error: 'A signed-in Supabase user session is required.',
}

export const REPORTING_STAFF_OPERATOR_REQUIRED = {
  status: 403 as const,
  code: 'operator_access_required',
  error: 'An authorised operator session is required.',
}

export function reportingApiStaffOperatorRole(role: unknown): boolean {
  return REPORTING_API_STAFF_OPERATOR_ROLES.has(String(role || '').toLowerCase())
}

export function reportingApiActionNeedsStaffRole(action: string): boolean {
  return REPORTING_API_STAFF_ACTIONS.has(action)
}

export function reportingApiServerSecretPresented(input: {
  xApiKey: string | null
  bearerToken: string | null
  sharedKey?: string | null
  serviceKey?: string | null
  agentServerKey?: string | null
}): boolean {
  const { xApiKey, bearerToken, sharedKey, serviceKey, agentServerKey } = input
  const matches = (secret?: string | null) =>
    !!secret &&
    secret !== sharedKey &&
    (xApiKey === secret || bearerToken === secret)
  if (matches(serviceKey)) return true
  if (matches(agentServerKey) && agentServerKey !== serviceKey) return true
  return false
}

export type ReportingStaffGateAllow = { ok: true }
export type ReportingStaffGateReject = {
  ok: false
  status: 401 | 403
  code: string
  error: string
}
export type ReportingStaffGateDecision =
  | ReportingStaffGateAllow
  | ReportingStaffGateReject

export function authorizeReportingApiStaffAction(input: {
  action: string
  serverSecretPresented: boolean
  jwtUser: { role?: unknown } | null
}): ReportingStaffGateDecision {
  if (!reportingApiActionNeedsStaffRole(input.action)) return { ok: true }
  if (input.serverSecretPresented) return { ok: true }
  if (!input.jwtUser) {
    return { ok: false, ...REPORTING_STAFF_JWT_REQUIRED }
  }
  if (!reportingApiStaffOperatorRole(input.jwtUser.role)) {
    return { ok: false, ...REPORTING_STAFF_OPERATOR_REQUIRED }
  }
  return { ok: true }
}

export async function decideReportingStaffAuth(input: {
  action: string
  xApiKey: string | null
  bearerToken: string | null
  sharedKey?: string | null
  serviceKey?: string | null
  agentServerKey?: string | null
  sb: any
}): Promise<ReportingStaffGateDecision> {
  if (!reportingApiActionNeedsStaffRole(input.action)) return { ok: true }

  const serverSecretPresented = reportingApiServerSecretPresented({
    xApiKey: input.xApiKey,
    bearerToken: input.bearerToken,
    sharedKey: input.sharedKey,
    serviceKey: input.serviceKey,
    agentServerKey: input.agentServerKey,
  })
  if (serverSecretPresented) return { ok: true }

  const bearer = input.bearerToken
  if (
    !bearer ||
    bearer === input.sharedKey ||
    bearer === input.serviceKey ||
    (input.agentServerKey && bearer === input.agentServerKey)
  ) {
    return { ok: false, ...REPORTING_STAFF_JWT_REQUIRED }
  }

  try {
    const { data: { user }, error } = await input.sb.auth.getUser(bearer)
    if (error || !user) {
      return { ok: false, ...REPORTING_STAFF_JWT_REQUIRED }
    }
    const { data: profile } = await input.sb
      .from('users')
      .select('role')
      .eq('id', user.id)
      .maybeSingle()
    return authorizeReportingApiStaffAction({
      action: input.action,
      serverSecretPresented: false,
      jwtUser: { role: profile?.role || 'unknown' },
    })
  } catch (_e) {
    return { ok: false, ...REPORTING_STAFF_JWT_REQUIRED }
  }
}

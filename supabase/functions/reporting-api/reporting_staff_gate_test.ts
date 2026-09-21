// deno-lint-ignore-file no-import-prefix

import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  authorizeReportingApiStaffAction,
  decideReportingStaffAuth,
  REPORTING_API_STAFF_ACTIONS,
  REPORTING_API_STAFF_OPERATOR_ROLES,
  REPORTING_STAFF_JWT_REQUIRED,
  REPORTING_STAFF_OPERATOR_REQUIRED,
  reportingApiActionNeedsStaffRole,
  reportingApiServerSecretPresented,
  reportingApiStaffOperatorRole,
} from "./reporting_staff_gate.ts";

const ENV = {
  sharedKey: "master-sw-key-123",
  serviceKey: "service-role-key-456",
  agentServerKey: "ops-agent-server-key-789",
}

const VALID_JWT = "valid.user.jwt"
const INVALID_JWT = "invalid.user.jwt"
const THROW_JWT = "throw.user.jwt"

const OTHER_REPORTING_ACTIONS = [
  "dashboard_summary",
  "job_profitability",
  "marketing_summary",
  "trends",
  "sales_breakdown",
  "insights",
  "match_invoices",
  "debt_followup",
  "ceo_report",
  "sales_summary",
  "sales_pipeline",
  "sales_performance",
  "sales_leads",
  "team_activity",
  "sales_alerts",
  "sales_snooze",
  "sales_quick_action",
  "rep_queue",
  "commission_summary",
  "reconcile_transaction",
  "cash_waterfall",
  "cash_leak_detection",
  "performance_benchmarks",
  "portfolio_summary",
  "chat_logs",
] as const

const NON_STAFF_ROLES = [
  "crew",
  "installer",
  "lead_installer",
  "sales",
  "estimator",
  "trade",
  "unknown",
  "",
] as const

function gateStatus(
  decision: { ok: true } | { ok: false; status: number },
): number {
  return decision.ok ? 200 : decision.status
}

function makeAuthSb(opts?: {
  role?: string | null
  getUserCalls?: string[]
  profileCalls?: string[]
}) {
  const role = opts && "role" in opts ? opts.role : "admin"
  const getUserCalls = opts?.getUserCalls
  const profileCalls = opts?.profileCalls
  return {
    auth: {
      getUser: (token: string) => {
        getUserCalls?.push(token)
        if (token === THROW_JWT) {
          return Promise.reject(new Error("network unreachable (simulated)"))
        }
        if (token === VALID_JWT) {
          return Promise.resolve({
            data: { user: { id: "user-uuid-777" } },
            error: null,
          })
        }
        return Promise.resolve({
          data: { user: null },
          error: { message: "invalid JWT" },
        })
      },
    },
    from: (table: string) => ({
      select: (_columns: string) => ({
        eq: (_column: string, value: string) => ({
          maybeSingle: () => {
            profileCalls?.push(`${table}:${value}`)
            if (role == null) {
              return Promise.resolve({ data: null, error: null })
            }
            return Promise.resolve({ data: { role }, error: null })
          },
        }),
      }),
    }),
  }
}

function decide(input: {
  action: string
  xApiKey?: string | null
  bearerToken?: string | null
  role?: string | null
  sb?: ReturnType<typeof makeAuthSb>
}) {
  return decideReportingStaffAuth({
    action: input.action,
    xApiKey: input.xApiKey ?? null,
    bearerToken: input.bearerToken ?? null,
    sharedKey: ENV.sharedKey,
    serviceKey: ENV.serviceKey,
    agentServerKey: ENV.agentServerKey,
    sb: input.sb ?? makeAuthSb({ role: input.role ?? "admin" }),
  })
}

Deno.test("staff operator roles match the ops-api office set", () => {
  assertEquals(
    [...REPORTING_API_STAFF_OPERATOR_ROLES].sort(),
    ["admin", "ops_manager", "owner"],
  )
  assertEquals(
    [...REPORTING_API_STAFF_ACTIONS].sort(),
    ["job_context", "job_intelligence"],
  )
  for (const role of ["admin", "owner", "ops_manager", "ADMIN", "Owner"]) {
    assertEquals(reportingApiStaffOperatorRole(role), true, role)
  }
  for (const role of NON_STAFF_ROLES) {
    assertEquals(reportingApiStaffOperatorRole(role), false, String(role))
  }
})

Deno.test("only job_context and job_intelligence need the staff role", () => {
  assertEquals(reportingApiActionNeedsStaffRole("job_context"), true)
  assertEquals(reportingApiActionNeedsStaffRole("job_intelligence"), true)
  for (const action of OTHER_REPORTING_ACTIONS) {
    assertEquals(reportingApiActionNeedsStaffRole(action), false, action)
  }
  assertEquals(reportingApiActionNeedsStaffRole("unknown_action"), false)
})

Deno.test("server secret is service-role or agent key, never SW_API_KEY", () => {
  assertEquals(
    reportingApiServerSecretPresented({
      xApiKey: ENV.serviceKey,
      bearerToken: null,
      sharedKey: ENV.sharedKey,
      serviceKey: ENV.serviceKey,
      agentServerKey: ENV.agentServerKey,
    }),
    true,
  )
  assertEquals(
    reportingApiServerSecretPresented({
      xApiKey: null,
      bearerToken: ENV.agentServerKey,
      sharedKey: ENV.sharedKey,
      serviceKey: ENV.serviceKey,
      agentServerKey: ENV.agentServerKey,
    }),
    true,
  )
  assertEquals(
    reportingApiServerSecretPresented({
      xApiKey: ENV.sharedKey,
      bearerToken: null,
      sharedKey: ENV.sharedKey,
      serviceKey: ENV.serviceKey,
      agentServerKey: ENV.agentServerKey,
    }),
    false,
  )
  assertEquals(
    reportingApiServerSecretPresented({
      xApiKey: null,
      bearerToken: ENV.sharedKey,
      sharedKey: ENV.sharedKey,
      serviceKey: ENV.serviceKey,
      agentServerKey: ENV.agentServerKey,
    }),
    false,
  )
})

Deno.test("non-staff JWT is 403 on both Jarvis reads", async () => {
  for (const action of ["job_context", "job_intelligence"] as const) {
    for (const role of NON_STAFF_ROLES) {
      const decision = await decide({
        action,
        bearerToken: VALID_JWT,
        role,
      })
      assertEquals(gateStatus(decision), 403, `${action} ${role}`)
      assertEquals(decision.ok, false)
      if (!decision.ok) {
        assertEquals(decision.code, REPORTING_STAFF_OPERATOR_REQUIRED.code)
        assertEquals(decision.error, REPORTING_STAFF_OPERATOR_REQUIRED.error)
      }
    }
  }
})

Deno.test("staff JWT is 200 on both Jarvis reads", async () => {
  for (const action of ["job_context", "job_intelligence"] as const) {
    for (const role of ["admin", "owner", "ops_manager"] as const) {
      const decision = await decide({
        action,
        bearerToken: VALID_JWT,
        role,
      })
      assertEquals(gateStatus(decision), 200, `${action} ${role}`)
      assertEquals(decision.ok, true)
    }
  }
})

Deno.test("service-role and agent server credentials are 200 on both Jarvis reads", async () => {
  const getUserCalls: string[] = []
  const sb = makeAuthSb({ getUserCalls })
  for (const action of ["job_context", "job_intelligence"] as const) {
    for (const cred of [
      { xApiKey: ENV.serviceKey, bearerToken: null },
      { xApiKey: null, bearerToken: ENV.serviceKey },
      { xApiKey: ENV.agentServerKey, bearerToken: null },
      { xApiKey: null, bearerToken: ENV.agentServerKey },
    ]) {
      const decision = await decide({ action, sb, ...cred })
      assertEquals(gateStatus(decision), 200, `${action} ${JSON.stringify(cred)}`)
      assertEquals(decision.ok, true)
    }
  }
  assertEquals(getUserCalls, [])
})

Deno.test("shared SW_API_KEY is not enough for the Jarvis reads", async () => {
  for (const action of ["job_context", "job_intelligence"] as const) {
    const viaHeader = await decide({ action, xApiKey: ENV.sharedKey })
    assertEquals(gateStatus(viaHeader), 401, action)
    const viaBearer = await decide({ action, bearerToken: ENV.sharedKey })
    assertEquals(gateStatus(viaBearer), 401, action)
    if (!viaHeader.ok) {
      assertEquals(viaHeader.code, REPORTING_STAFF_JWT_REQUIRED.code)
    }
  }
})

Deno.test("every other reporting-api action stays ungated for trade JWT and shared key", async () => {
  const getUserCalls: string[] = []
  const profileCalls: string[] = []
  const sb = makeAuthSb({ role: "lead_installer", getUserCalls, profileCalls })
  for (const action of OTHER_REPORTING_ACTIONS) {
    const tradeJwt = await decide({
      action,
      bearerToken: VALID_JWT,
      sb,
    })
    assertEquals(gateStatus(tradeJwt), 200, `${action} trade jwt`)
    const sharedKey = await decide({
      action,
      xApiKey: ENV.sharedKey,
      sb,
    })
    assertEquals(gateStatus(sharedKey), 200, `${action} shared key`)
    const noCaller = await decide({ action, sb })
    assertEquals(gateStatus(noCaller), 200, `${action} no extra creds`)
  }
  assertEquals(getUserCalls, [])
  assertEquals(profileCalls, [])
})

Deno.test("pure gate: missing JWT on a staff action is 401, staff role is 200", () => {
  assertEquals(
    gateStatus(authorizeReportingApiStaffAction({
      action: "job_context",
      serverSecretPresented: false,
      jwtUser: null,
    })),
    401,
  )
  assertEquals(
    gateStatus(authorizeReportingApiStaffAction({
      action: "job_intelligence",
      serverSecretPresented: true,
      jwtUser: null,
    })),
    200,
  )
  assertEquals(
    gateStatus(authorizeReportingApiStaffAction({
      action: "dashboard_summary",
      serverSecretPresented: false,
      jwtUser: { role: "lead_installer" },
    })),
    200,
  )
})

Deno.test("invalid or throwing JWT on a staff action is 401, not 403", async () => {
  const invalid = await decide({
    action: "job_context",
    bearerToken: INVALID_JWT,
  })
  assertEquals(gateStatus(invalid), 401)
  const thrown = await decide({
    action: "job_intelligence",
    bearerToken: THROW_JWT,
  })
  assertEquals(gateStatus(thrown), 401)
})

Deno.test("missing users.role fails closed as 403, not staff", async () => {
  const decision = await decide({
    action: "job_context",
    bearerToken: VALID_JWT,
    sb: makeAuthSb({ role: null }),
  })
  assertEquals(gateStatus(decision), 403)
})

// The bearer ops-api presents to the Railway agent
// (`approve_booking_proposal` -> /api/booking-approvals/approve).
//
// Only AGENT_BEARER_TOKEN, then SW_API_KEY, may be sent. The Supabase
// service-role key is never a fallback: with both unset the call refuses with
// the named code below instead of handing the database master key to another
// service.

export const AGENT_BEARER_UNCONFIGURED = "agent_bearer_unconfigured" as const;

export type AgentBearerEnvGet = (name: string) => string | undefined;

export type AgentBearerResolution =
  | { ok: true; bearer: string; source: "AGENT_BEARER_TOKEN" | "SW_API_KEY" }
  | { ok: false; code: typeof AGENT_BEARER_UNCONFIGURED; error: string };

export function resolveSecureworksAgentBearer(
  envGet: AgentBearerEnvGet = (name) => Deno.env.get(name),
): AgentBearerResolution {
  for (const source of ["AGENT_BEARER_TOKEN", "SW_API_KEY"] as const) {
    const value = String(envGet(source) || "").trim();
    if (value) return { ok: true, bearer: value, source };
  }
  return {
    ok: false,
    code: AGENT_BEARER_UNCONFIGURED,
    error:
      "secureworks agent bearer not configured: set AGENT_BEARER_TOKEN or SW_API_KEY (the service-role key is never sent)",
  };
}

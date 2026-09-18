// Office+tenant gate for reporting-api job_context. Dispatch notes in
// business_events.payload must not leak to a foreign tenant or non-office JWT.
export const REPORTING_OFFICE_ROLES = new Set([
  "admin",
  "owner",
  "ops_manager",
]);

export type ReportingAuthMode = "server_key" | "shared_key" | "jwt";

export async function authenticateReportingRequest(args: {
  sb: any;
  headers: Headers;
  sharedKey?: string;
  serviceKey?: string;
  agentServerKey?: string;
}): Promise<{ authMode: ReportingAuthMode; userId: string | null } | null> {
  const xApiKey = args.headers.get("x-api-key");
  const authorization = args.headers.get("authorization");
  const bearerToken = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : null;
  const credentials = [xApiKey, bearerToken];
  const serverKeys = [args.serviceKey, args.agentServerKey].filter((key) =>
    key && key !== args.sharedKey
  );
  if (credentials.some((key) => key && serverKeys.includes(key))) {
    return { authMode: "server_key", userId: null };
  }
  if (bearerToken && bearerToken !== args.sharedKey) {
    try {
      const { data: { user }, error } = await args.sb.auth.getUser(bearerToken);
      if (!error && user) return { authMode: "jwt", userId: user.id };
    } catch {
      return null;
    }
  }
  if (args.sharedKey && credentials.includes(args.sharedKey)) {
    return { authMode: "shared_key", userId: null };
  }
  return null;
}

export async function authorizeReportingJobContext(args: {
  sb: any;
  jobId: string;
  authMode: ReportingAuthMode;
  userId?: string | null;
}): Promise<
  { jobId: string; orgId: string } | { error: string; status: number }
> {
  const requested = String(args.jobId || "").trim();
  if (!requested) return { error: "job_id required", status: 400 };

  let orgId: string | null = null;
  if (args.authMode !== "server_key") {
    if (args.authMode !== "jwt" || !args.userId) {
      return { error: "Office authorization required", status: 403 };
    }
    const profile = await args.sb.from("users").select("id, org_id, role").eq(
      "id",
      args.userId,
    ).maybeSingle();
    const role = String(profile.data?.role || "").toLowerCase();
    orgId = profile.data?.org_id;
    if (profile.error || !orgId || !REPORTING_OFFICE_ROLES.has(role)) {
      return { error: "Office authorization required", status: 403 };
    }
  }

  let query = args.sb.from("jobs").select("id, org_id");
  if (orgId) query = query.eq("org_id", orgId);
  let job: { id: string; org_id: string } | null = null;
  if (/^SW[A-Z]+-\d+$/i.test(requested)) {
    const found = await query.ilike(
      "job_number",
      requested,
    ).limit(1).maybeSingle();
    job = found.data || null;
  } else {
    const found = await query.eq(
      "id",
      requested,
    ).maybeSingle();
    job = found.data || null;
  }
  if (!job?.id || !job.org_id) return { error: "Job not found", status: 404 };

  return { jobId: job.id, orgId: job.org_id };
}

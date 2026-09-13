// Office+tenant gate for reporting-api job_context. Dispatch notes in
// business_events.payload must not leak to a foreign tenant or non-office JWT.
export const REPORTING_OFFICE_ROLES = new Set([
  "admin",
  "owner",
  "ops_manager",
]);

export type ReportingAuthMode = "api_key" | "jwt";

export async function authorizeReportingJobContext(args: {
  sb: any;
  jobId: string;
  authMode: ReportingAuthMode;
  userId?: string | null;
}): Promise<{ jobId: string; orgId: string } | { error: string; status: number }> {
  const requested = String(args.jobId || "").trim();
  if (!requested) return { error: "job_id required", status: 400 };

  let job: { id: string; org_id: string } | null = null;
  if (/^SW[A-Z]+-\d+$/i.test(requested)) {
    const found = await args.sb.from("jobs").select("id, org_id").ilike(
      "job_number",
      requested,
    ).limit(1).maybeSingle();
    job = found.data || null;
  } else {
    const found = await args.sb.from("jobs").select("id, org_id").eq(
      "id",
      requested,
    ).maybeSingle();
    job = found.data || null;
  }
  if (!job?.id || !job.org_id) return { error: "Job not found", status: 404 };

  if (args.authMode === "api_key") {
    return { jobId: job.id, orgId: job.org_id };
  }
  if (args.authMode !== "jwt" || !args.userId) {
    return { error: "Office authorization required", status: 403 };
  }
  const profile = await args.sb.from("users").select("id, org_id, role").eq(
    "id",
    args.userId,
  ).maybeSingle();
  const role = String(profile.data?.role || "").toLowerCase();
  const orgId = profile.data?.org_id;
  if (!orgId) return { error: "Office authorization required", status: 403 };
  if (!REPORTING_OFFICE_ROLES.has(role)) {
    return { error: "Office authorization required", status: 403 };
  }
  if (String(orgId) !== String(job.org_id)) {
    return { error: "Job is outside this organisation", status: 403 };
  }
  return { jobId: job.id, orgId: job.org_id };
}

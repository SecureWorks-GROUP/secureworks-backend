// deno-lint-ignore-file no-explicit-any

const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";
const SES_MAILBOX = "ses@secureworkswa.com.au";
const FINAL_CASE_STATES = new Set([
  "confirmed_live_job",
  "blocked_live_job",
  "exception",
  "accounted_non_wo",
]);

export async function assertFreshMakesafeSourceSettled(
  client: any,
  sourcePostId: string,
  report: any,
): Promise<void> {
  const requiredNotifications = Number(
    report?.totals?.hugo_notifications_required || 0,
  );
  const acceptedNotifications = Number(
    report?.totals?.hugo_notifications_accepted || 0,
  );
  if (
    report?.ok !== true ||
    report?.completion_status !== "completed" ||
    Number(report?.totals?.write_failures || 0) > 0 ||
    Number(report?.totals?.cases_failed || 0) > 0 ||
    Number(report?.totals?.cases_deferred || 0) > 0 ||
    acceptedNotifications < requiredNotifications
  ) {
    throw new Error("fresh source deterministic settlement incomplete");
  }

  const { data: source, error: sourceError } = await client
    .from("makesafe_intake_case_sources")
    .select("case_id")
    .eq("org_id", DEFAULT_ORG_ID)
    .eq("post_id", sourcePostId)
    .maybeSingle();
  if (sourceError || !source?.case_id) {
    const { data: exclusion, error: exclusionError } = await client
      .from("email_classifier_exclusions")
      .select("post_id")
      .eq("mailbox", SES_MAILBOX)
      .eq("post_id", sourcePostId)
      .maybeSingle();
    if (!exclusionError && exclusion?.post_id) return;
    throw new Error(
      `fresh source canonical case fate missing: ${
        sourceError?.message || exclusionError?.message || sourcePostId
      }`,
    );
  }

  const { data: intakeCase, error: caseError } = await client
    .from("makesafe_intake_cases")
    .select("state,job_id")
    .eq("org_id", DEFAULT_ORG_ID)
    .eq("id", source.case_id)
    .maybeSingle();
  if (
    caseError ||
    !FINAL_CASE_STATES.has(String(intakeCase?.state || "")) ||
    (
      intakeCase?.state === "confirmed_live_job" &&
      !intakeCase?.job_id
    )
  ) {
    throw new Error(
      `fresh source canonical settlement invalid: ${
        caseError?.message || intakeCase?.state || sourcePostId
      }`,
    );
  }
}

// deno-lint-ignore-file no-explicit-any
// Shared sealed-SES classification and refusal contract for invoice/money paths.
//
// The SES Reporting mission covers every make-safe family stored on the make-safe
// job spine. `jobs.type = makesafe` is canonical, the SWMS prefix preserves
// imported legacy rows, and a makesafe_job_details row catches older placeholder
// job types. Ordinary patio, fencing and general jobs remain outside this fence.

export interface SealedSesJobRecord {
  id?: string | null;
  type?: string | null;
  job_number?: string | null;
  ses_money_sealed_at?: string | null;
  ses_money_seal_source?: string | null;
}

export interface SealedSesMoneyRefusal {
  state: "refused";
  code: "sealed_ses_release_required";
  fact: string;
  recovery_action: string;
  evidence?: Record<string, unknown>;
}

export interface SealedSesJobInspection {
  sealed: boolean;
  matched_by:
    | "job_seal"
    | "job_type"
    | "job_number"
    | "makesafe_detail"
    | null;
  job: SealedSesJobRecord | null;
}

export class SealedSesMoneyFenceLookupError extends Error {
  code = "sealed_ses_fence_check_failed";
}

function normalizedJobType(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

export function classifySealedSesJob(
  job: SealedSesJobRecord | null | undefined,
  hasMakesafeDetail = false,
): SealedSesJobInspection {
  if (!job?.id) {
    throw new SealedSesMoneyFenceLookupError(
      "The sealed SES job classification could not be checked because the job row is missing.",
    );
  }
  if (job.ses_money_sealed_at) {
    return { sealed: true, matched_by: "job_seal", job };
  }
  if (normalizedJobType(job.type) === "makesafe") {
    return { sealed: true, matched_by: "job_type", job };
  }
  if (/^SWMS-/i.test(String(job.job_number || "").trim())) {
    return { sealed: true, matched_by: "job_number", job };
  }
  if (hasMakesafeDetail) {
    return { sealed: true, matched_by: "makesafe_detail", job };
  }
  return { sealed: false, matched_by: null, job };
}

export async function inspectSealedSesJob(
  client: any,
  jobId: string,
): Promise<SealedSesJobInspection> {
  const jobResponse = await client.from("jobs")
    .select(
      "id,type,job_number,ses_money_sealed_at,ses_money_seal_source",
    )
    .eq("id", jobId)
    .maybeSingle();
  if (jobResponse.error) {
    throw new SealedSesMoneyFenceLookupError(
      `The sealed SES job classification could not be checked (${
        jobResponse.error.message || "unknown database error"
      }).`,
    );
  }
  if (!jobResponse.data) {
    throw new SealedSesMoneyFenceLookupError(
      "The sealed SES job classification could not be checked because the job row is missing.",
    );
  }
  const direct = classifySealedSesJob(jobResponse.data);
  if (direct.sealed) return direct;

  const detailResponse = await client.from("makesafe_job_details")
    .select("job_id")
    .eq("job_id", jobId)
    .limit(1)
    .maybeSingle();
  if (detailResponse.error) {
    throw new SealedSesMoneyFenceLookupError(
      `The sealed SES make-safe detail could not be checked (${
        detailResponse.error.message || "unknown database error"
      }).`,
    );
  }
  return classifySealedSesJob(jobResponse.data, !!detailResponse.data);
}

export function sealedSesMoneyRefusal(
  action: string,
  evidence?: Record<string, unknown>,
): SealedSesMoneyRefusal {
  return {
    state: "refused",
    code: "sealed_ses_release_required",
    fact:
      `This SES make-safe job is sealed. Legacy ${action} is refused because its invoice may only be created, authorised, changed, linked, or sent through the approved SES release flow.`,
    recovery_action:
      "Prepare and approve the exact SES invoice revision, use execute_ses_invoice_revision, then approve and execute_ses_release_revision for the exact invoice and delivery route.",
    ...(evidence ? { evidence } : {}),
  };
}

export function invoiceLinkRequiredRefusal(
  action: string,
  evidence?: Record<string, unknown>,
) {
  return {
    state: "refused" as const,
    code: "invoice_link_required",
    fact:
      `Legacy ${action} is refused because the ACCREC invoice is not bound to an authoritative job in the local Xero mirror.`,
    recovery_action:
      "Sync and resolve the invoice's real job link before retrying. Never use a caller-supplied or decoy job id as invoice identity.",
    ...(evidence ? { evidence } : {}),
  };
}

export function sealedSesFenceCheckFailedRefusal(
  action: string,
  fact: string,
  evidence?: Record<string, unknown>,
) {
  return {
    state: "refused" as const,
    code: "sealed_ses_fence_check_failed",
    fact:
      `The ${action} sealed SES gate could not prove the effect is safe. ${fact}`,
    recovery_action:
      "Restore the authoritative invoice and job classification reads, then retry. Never proceed while the check is unavailable.",
    ...(evidence ? { evidence } : {}),
  };
}

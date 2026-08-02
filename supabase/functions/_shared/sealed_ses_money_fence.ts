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

// ── Captain's ruling, 2026-08-02: reading is not a money effect ──
//
// Asked whether reading an invoice PDF should be exempt from this seal, the
// captain ruled: "Of course you should be able to allow reading."
//
// Exactly ONE capability is exempt: fetching the bytes of an invoice document
// that already exists. A read creates, drafts, amends, voids, re-links,
// re-numbers, issues, sends and changes nothing, so the refusal it used to
// raise protected no money record — it only stopped operators opening invoices
// SecureWorks Group had already sent to a builder.
//
// This set is closed and it is NOT a maintenance surface. Adding a name is a
// captain-level decision, and three things make that visible rather than easy:
//
//   1. `sealed_ses_money_fence_test.ts` pins the exact membership, so any new
//      name fails a test that names this ruling.
//   2. `sealedSesMoneyReadExemptionWriteVerbViolations()` rejects any name
//      carrying a write verb, so the set cannot quietly grow a write.
//   3. The exemption is double-locked: it also needs an operator caller
//      context, which every write call site structurally omits (see
//      `sealedSesMoneyReadExemptionApplies`).
//
// Everything else the seal refuses — created, authorised, changed, linked,
// sent — is untouched.
export const SEALED_SES_MONEY_READ_EXEMPT_ACTIONS: ReadonlySet<string> =
  new Set(
    [
      "get_invoice_pdf",
    ],
  );

// The identified operator asking for the bytes. `mode` mirrors the ops-api auth
// mode; `role` is the authenticated profile role for a JWT session. This is
// never caller-supplied request data — ops-api resolves both server-side.
export interface SealedSesMoneyReadCaller {
  mode: "api_key" | "jwt" | "routine";
  role?: string | null;
}

export function isSealedSesMoneyReadExemptAction(action: string): boolean {
  return SEALED_SES_MONEY_READ_EXEMPT_ACTIONS.has(String(action ?? "").trim());
}

// Both locks must hold. The action must be on the closed read allow-list AND
// the caller must be an identified operator: the privileged ops key, or an
// admin/owner session. The make-safe automation routine is deliberately not an
// operator, and a write call site passes no caller context at all — so a write
// can never reach this exemption even if a write verb were mistakenly listed.
export function sealedSesMoneyReadExemptionApplies(
  action: string,
  caller: SealedSesMoneyReadCaller | null | undefined,
): boolean {
  if (!isSealedSesMoneyReadExemptAction(action)) return false;
  if (!caller) return false;
  if (caller.mode === "api_key") return true;
  if (caller.mode !== "jwt") return false;
  const role = String(caller.role ?? "").trim().toLowerCase();
  return role === "admin" || role === "owner";
}

// Word-level (never substring) write verbs. `get_invoice_pdf` carries none of
// them; `void_invoice`, `send_invoice_email` or `update_invoice_job_link` each
// carry one, so allow-listing any of those trips this guard.
const SEALED_SES_MONEY_WRITE_VERBS: ReadonlySet<string> = new Set([
  "amend",
  "apply",
  "approve",
  "authorise",
  "authorize",
  "cancel",
  "change",
  "create",
  "delete",
  "draft",
  "email",
  "execute",
  "issue",
  "link",
  "mark",
  "number",
  "pay",
  "post",
  "reconcile",
  "release",
  "relink",
  "remove",
  "renumber",
  "save",
  "send",
  "set",
  "share",
  "submit",
  "sync",
  "update",
  "void",
  "write",
]);

// Returns the allow-listed action names that name a write effect. The test
// suite asserts this is empty; it is the check that fails if someone later
// widens the read exemption into a write.
export function sealedSesMoneyReadExemptionWriteVerbViolations(): string[] {
  return [...SEALED_SES_MONEY_READ_EXEMPT_ACTIONS].filter((action) =>
    String(action).toLowerCase().split(/[^a-z]+/).filter(Boolean).some((word) =>
      SEALED_SES_MONEY_WRITE_VERBS.has(word)
    )
  );
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

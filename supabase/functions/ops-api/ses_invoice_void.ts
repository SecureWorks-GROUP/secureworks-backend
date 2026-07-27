// deno-lint-ignore-file no-explicit-any
import {
  inspectSealedSesJob,
  invoiceLinkRequiredRefusal,
  sealedSesFenceCheckFailedRefusal,
} from "../_shared/sealed_ses_money_fence.ts";
import { sesSha256, stableUuidFromSha256 } from "./ses_docket_envelope.ts";
import {
  buildSesEffect,
  executeSesExternalEffect,
  type SesExternalAdapter,
} from "./ses_external_effects.ts";
import {
  createSupabaseSesEffectStore,
  type SesActionAuth,
  SesActionError,
  type SesSupabaseClient,
} from "./ses_reporting_actions.ts";
import { sesRefusal } from "./ses_reporting_refusals.ts";

export interface SesInvoiceVoidGateway {
  voidInvoice(
    xeroInvoiceId: string,
    targetStatus: "DELETED" | "VOIDED",
    context: { external_token: string; operation_key: string },
  ): Promise<{ xero_invoice_id: string; status: string }>;
  reconcileVoid(
    xeroInvoiceId: string,
    targetStatus: "DELETED" | "VOIDED",
  ): Promise<Array<{ xero_invoice_id: string; status: string }>>;
}

export function targetSesInvoiceVoidStatus(
  status: string,
): "DELETED" | "VOIDED" {
  switch (String(status || "").toUpperCase()) {
    case "DRAFT":
      return "DELETED";
    case "SUBMITTED":
    case "AUTHORISED":
      return "VOIDED";
    default:
      throw new SesActionError(
        409,
        sesRefusal(
          "ses_invoice_void_status_forbidden",
          "Only a current DRAFT, SUBMITTED, or AUTHORISED invoice can be voided. Paid and already-terminal invoices are immutable.",
        ),
      );
  }
}

async function inspectVoidJob(client: any, jobId: string) {
  try {
    return await inspectSealedSesJob(client, jobId);
  } catch (error) {
    throw new SesActionError(
      503,
      sealedSesFenceCheckFailedRefusal(
        "prepare_ses_invoice_void_revision",
        (error as Error).message,
        { job_id: jobId },
      ),
    );
  }
}

export async function prepareSesInvoiceVoidRevisionAction(
  client: SesSupabaseClient,
  args: {
    org_id: string;
    xero_invoice_id: string;
    reason: string;
    created_by: string;
  },
) {
  const invoice = await client.from("xero_invoices").select(
    "xero_invoice_id,invoice_number,invoice_type,job_id,status,invoice_obligation_revision_id,ses_external_token",
  ).eq("org_id", args.org_id).eq(
    "xero_invoice_id",
    args.xero_invoice_id,
  ).maybeSingle();
  if (invoice.error) {
    throw new SesActionError(
      503,
      sealedSesFenceCheckFailedRefusal(
        "prepare_ses_invoice_void_revision",
        `The invoice mirror lookup failed (${invoice.error.message}).`,
        { xero_invoice_id: args.xero_invoice_id },
      ),
    );
  }
  if (!invoice.data) {
    throw new SesActionError(
      503,
      sealedSesFenceCheckFailedRefusal(
        "prepare_ses_invoice_void_revision",
        "The invoice is missing from the local Xero mirror.",
        { xero_invoice_id: args.xero_invoice_id },
      ),
    );
  }
  if (String(invoice.data.invoice_type || "").toUpperCase() !== "ACCREC") {
    throw new SesActionError(
      409,
      sesRefusal(
        "ses_invoice_void_requires_accrec",
        "Use the normal supplier-bill workflow for ACCPAY invoices.",
      ),
    );
  }
  if (!invoice.data.job_id) {
    throw new SesActionError(
      409,
      invoiceLinkRequiredRefusal("prepare_ses_invoice_void_revision", {
        xero_invoice_id: args.xero_invoice_id,
        invoice_type: "ACCREC",
      }),
    );
  }
  const inspection = await inspectVoidJob(client, invoice.data.job_id);
  if (!inspection.sealed) {
    throw new SesActionError(
      409,
      sesRefusal(
        "ses_invoice_void_requires_sealed_job",
        "This invoice belongs to a non-SES job; use the ordinary invoice void workflow.",
      ),
    );
  }
  const reason = String(args.reason || "").trim();
  if (reason.length < 8) {
    throw new SesActionError(400, {
      state: "refused",
      fact: "A specific void reason of at least 8 characters is required.",
    });
  }
  const targetStatus = targetSesInvoiceVoidStatus(invoice.data.status);
  const content = {
    schema: "secureworks.makesafe.invoice-void/v1",
    org_id: args.org_id,
    job_id: invoice.data.job_id,
    xero_invoice_id: args.xero_invoice_id,
    invoice_number: invoice.data.invoice_number || null,
    invoice_obligation_revision_id:
      invoice.data.invoice_obligation_revision_id || null,
    observed_status: String(invoice.data.status || "").toUpperCase(),
    target_status: targetStatus,
    reason,
  };
  const contentHash = await sesSha256(
    content,
    "SecureWorks:ses-invoice-void:v1\n",
  );
  const revisionId = stableUuidFromSha256(contentHash);
  const committed = await client.rpc("commit_ses_invoice_void_revision_v1", {
    p_id: revisionId,
    p_org_id: args.org_id,
    p_job_id: invoice.data.job_id,
    p_xero_invoice_id: args.xero_invoice_id,
    p_invoice_obligation_revision_id:
      invoice.data.invoice_obligation_revision_id || null,
    p_observed_status: content.observed_status,
    p_target_status: targetStatus,
    p_reason: reason,
    p_content_hash: contentHash,
    p_created_by: args.created_by,
  });
  if (committed.error || !committed.data) {
    throw new SesActionError(409, {
      state: "refused",
      fact: `The SES void revision could not be committed${
        committed.error?.message ? ` (${committed.error.message})` : ""
      }.`,
    });
  }
  return {
    revision: committed.data,
    content,
    external_mutations: { xero: 0, email: 0 },
  };
}

async function requireCaptainVoidApproval(
  client: SesSupabaseClient,
  auth: SesActionAuth,
) {
  if (auth.mode !== "jwt" || !auth.user) {
    throw new SesActionError(403, {
      state: "refused",
      fact:
        "SES invoice void approval requires an identified captain or admin/owner session.",
    });
  }
  const operator = await client.from("ses_release_operators")
    .select("operator_class").eq("user_id", auth.user.id).eq("active", true)
    .maybeSingle();
  if (operator.error) {
    throw new SesActionError(503, {
      state: "refused",
      fact:
        `The SES operator allowlist could not be read (${operator.error.message}).`,
    });
  }
  const captain = auth.user.role === "admin" ||
    auth.user.role === "owner" ||
    operator.data?.operator_class === "captain" ||
    operator.data?.operator_class === "admin_owner";
  if (!captain) {
    throw new SesActionError(403, {
      state: "refused",
      fact:
        "Only the SES captain or an admin/owner can approve an invoice void.",
    });
  }
}

export async function approveSesInvoiceVoidRevisionAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  args: { void_revision_id: string },
) {
  await requireCaptainVoidApproval(client, auth);
  const revision = await client.from("makesafe_invoice_void_revisions")
    .select("*").eq("id", args.void_revision_id).maybeSingle();
  if (revision.error || !revision.data) {
    throw new SesActionError(409, {
      state: "refused",
      fact: "The proposed SES invoice void revision no longer exists.",
    });
  }
  const approved = await client.rpc("approve_ses_invoice_void_revision_v1", {
    p_void_revision_id: revision.data.id,
    p_content_hash: revision.data.content_hash,
    p_decided_by: auth.user!.email,
  });
  if (approved.error || !approved.data) {
    throw new SesActionError(409, {
      state: "refused",
      fact: `The exact SES invoice void approval could not be recorded${
        approved.error?.message ? ` (${approved.error.message})` : ""
      }.`,
    });
  }
  return approved.data;
}

export async function executeSesInvoiceVoidRevisionAction(
  client: SesSupabaseClient,
  args: {
    org_id: string;
    void_revision_id: string;
    actor: string;
  },
  gateway: SesInvoiceVoidGateway,
) {
  const revision = await client.from("makesafe_invoice_void_revisions")
    .select("*").eq("org_id", args.org_id).eq(
      "id",
      args.void_revision_id,
    ).maybeSingle();
  if (revision.error || !revision.data) {
    throw new SesActionError(409, {
      state: "refused",
      fact: "The approved SES invoice void revision no longer exists.",
    });
  }
  try {
    const inspection = await inspectSealedSesJob(client, revision.data.job_id);
    if (!inspection.sealed) {
      throw new Error("the authoritative job is no longer sealed");
    }
  } catch (error) {
    throw new SesActionError(
      503,
      sealedSesFenceCheckFailedRefusal(
        "execute_ses_invoice_void_revision",
        (error as Error).message,
        { job_id: revision.data.job_id },
      ),
    );
  }
  const reserved = await client.rpc("begin_ses_invoice_void_execution_v1", {
    p_void_revision_id: revision.data.id,
    p_content_hash: revision.data.content_hash,
  });
  if (reserved.error || !reserved.data) {
    throw new SesActionError(409, {
      state: "refused",
      fact: `The exact approved SES void could not be reserved${
        reserved.error?.message ? ` (${reserved.error.message})` : ""
      }.`,
    });
  }

  const targetStatus = targetSesInvoiceVoidStatus(
    revision.data.observed_status,
  );
  if (targetStatus !== revision.data.target_status) {
    throw new SesActionError(409, {
      state: "refused",
      fact: "The server-selected void target no longer matches this revision.",
    });
  }
  const payload = {
    xero_invoice_id: revision.data.xero_invoice_id,
    target_status: targetStatus,
    reason: revision.data.reason,
  };
  const effect = await buildSesEffect({
    org_id: args.org_id,
    job_id: revision.data.job_id,
    effect_kind: "invoice_void",
    invoice_obligation_revision_id:
      revision.data.invoice_obligation_revision_id || null,
    artifact_hash: revision.data.content_hash,
    payload,
  });
  const adapter: SesExternalAdapter<
    typeof payload,
    { xero_invoice_id: string; status: string }
  > = {
    dispatch: (_payload, context) =>
      gateway.voidInvoice(
        revision.data.xero_invoice_id,
        targetStatus,
        context,
      ),
    reconcile: () =>
      gateway.reconcileVoid(revision.data.xero_invoice_id, targetStatus),
    identify: (result) => result.xero_invoice_id,
    digest: (result) => ({ status: result.status }),
  };
  const executed = await executeSesExternalEffect({
    store: createSupabaseSesEffectStore(client),
    effect,
    payload,
    adapter,
    actor: args.actor,
  });
  if (executed.state !== "confirmed") {
    throw new SesActionError(409, executed.refusal!);
  }
  const result = executed.result ||
    (await gateway.reconcileVoid(
      revision.data.xero_invoice_id,
      targetStatus,
    ))[0];
  if (!result || result.status !== targetStatus) {
    throw new SesActionError(
      409,
      sesRefusal(
        "xero_outcome_unknown",
        "Reconcile this exact Xero invoice before attempting any further remediation.",
      ),
    );
  }
  const confirmed = await client.rpc(
    "confirm_ses_invoice_void_execution_v1",
    {
      p_void_revision_id: revision.data.id,
      p_content_hash: revision.data.content_hash,
      p_final_status: targetStatus,
      p_provider_digest: { status: result.status },
      p_actor: args.actor,
    },
  );
  if (confirmed.error || !confirmed.data) {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        "Xero confirmed the void, but the local SES ledger could not confirm it. Reconcile; never void again.",
    });
  }
  return {
    state: "confirmed",
    revision: confirmed.data,
    xero_invoice_id: result.xero_invoice_id,
    status: result.status,
    dispatched: executed.dispatched,
  };
}

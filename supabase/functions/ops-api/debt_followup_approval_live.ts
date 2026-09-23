/** Production adapters for debt_followup_approval.ts.
 *
 * Reads: the xero_invoices mirror, live Xero invoice + OnlineInvoice GETs, the
 * linked job's GHL contact, contact_matches, a live GHL contact GET, recipient
 * anchors and the payment-link history. Writes: only the two debt follow-up
 * ledger tables, and the desk logs after a confirmed send. The two provider
 * send calls (ghl-proxy send_sms, the Outlook invoice transport) are reached
 * only from the executor's live branch, which needs DEBT_FOLLOWUP_SEND_EXECUTE
 * = "true" and a captain press.
 */
import { ghlRead } from "./sales_booking_read.ts";
import type {
  ApprovalRecord,
  DebtFollowupDeps,
  DebtFollowupLedger,
  DebtFollowupReads,
  DebtFollowupTransports,
  LiveExecution,
} from "./debt_followup_approval.ts";
import {
  addDelimitedEmails,
  loadCompanyRecipientAnchors,
} from "./recipient_anchors.ts";

// deno-lint-ignore no-explicit-any
type Client = any;
// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

const APPROVALS = "debt_followup_approvals";
/** contact_matches rows read per Xero contact; more than this fails closed. */
export const CONTACT_MATCH_SCAN_LIMIT = 500;
const EXECUTIONS = "debt_followup_executions";
const APPROVAL_COLUMNS =
  "approval_id,binding_hash,kind,request,proposal,body_sha256,approved_by_email,approved_by_user_id,approved_at,expires_at,state";

export function debtFollowupLedger(client: Client): DebtFollowupLedger {
  return {
    async getApproval(approvalId) {
      const { data, error } = await client.from(APPROVALS).select(
        APPROVAL_COLUMNS,
      )
        .eq("approval_id", approvalId).maybeSingle();
      if (error) throw new Error("approval_unreadable");
      return (data as ApprovalRecord | null) ?? null;
    },
    async createOrReuseApproval(record) {
      const { data, error } = await client.rpc("debt_followup_create_approval", {
        p_approval: {
          approval_id: record.approval_id,
          binding_hash: record.binding_hash,
          contract: record.proposal.contract,
          kind: record.kind,
          channel: record.proposal.channel,
          xero_invoice_ids: record.request.xero_invoice_ids,
          request: record.request,
          proposal: record.proposal,
          body_sha256: record.body_sha256,
          approved_by_email: record.approved_by_email,
          approved_by_user_id: record.approved_by_user_id,
          approved_at: record.approved_at,
          expires_at: record.expires_at,
        },
      });
      if (error) throw new Error("approval_ledger_unwritable");
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || typeof row !== "object") {
        throw new Error("approval_ledger_unwritable");
      }
      return row as ApprovalRecord;
    },
    async liveExecution(approvalId) {
      const { data, error } = await client.from(EXECUTIONS)
        .select(
          "approval_id,outcome,provider,provider_message_id,provider_proof",
        )
        .eq("approval_id", approvalId).eq("mode", "live").maybeSingle();
      if (error) throw new Error("execution_ledger_unreadable");
      return (data as LiveExecution | null) ?? null;
    },
    async claimLive(row) {
      const { data, error } = await client.rpc("debt_followup_claim_live", {
        p_execution: row,
      });
      if (error) throw new Error("execution_ledger_unwritable");
      if (data === true) return true;
      if (data === false) return false;
      throw new Error("execution_ledger_unwritable");
    },
    async settleLive(approvalId, pressToken, outcome) {
      const { data, error } = await client.from(EXECUTIONS).update({
        outcome: outcome.outcome,
        reason: outcome.reason,
        provider: outcome.provider,
        provider_message_id: outcome.provider_message_id,
        provider_proof: outcome.provider_proof,
        finished_at: new Date().toISOString(),
      }).eq("approval_id", approvalId).eq("mode", "live").eq(
        "outcome",
        "sending",
      )
        .eq("press_token", pressToken)
        .select("approval_id").maybeSingle();
      if (error || !data) throw new Error("execution_ledger_unwritable");
    },
    async recordProviderProof(approvalId, pressToken, proof) {
      const { data, error } = await client.from(EXECUTIONS).update({
        provider: proof.provider,
        provider_message_id: proof.provider_message_id,
        provider_proof: proof.provider_proof,
      }).eq("approval_id", approvalId).eq("mode", "live").eq(
        "outcome",
        "sending",
      ).eq("press_token", pressToken).is("provider_proof", null)
        .select("approval_id").maybeSingle();
      if (error || !data) throw new Error("execution_ledger_unwritable");
    },
    async recordAttempt(row) {
      const { error } = await client.from(EXECUTIONS).insert({
        approval_id: row.approval_id,
        binding_hash: row.binding_hash,
        kind: row.kind,
        channel: row.channel,
        mode: "dry_run",
        outcome: row.outcome,
        reason: row.reason,
        pressed_by: row.pressed_by,
        source_action: row.source_action,
        proposal: row.proposal,
        finished_at: new Date().toISOString(),
      });
      if (error) throw new Error("execution_ledger_unwritable");
    },
  };
}

export interface DebtFollowupLiveInputs {
  orgId: string;
  getToken: (
    client: Client,
  ) => Promise<{ accessToken: string; tenantId: string }>;
  xeroGet: (
    path: string,
    accessToken: string,
    tenantId: string,
  ) => Promise<Obj>;
  /** The legacy sealed SES money fence for one invoice; throws SesActionError on refusal. */
  assertInvoiceAllowed: (
    client: Client,
    xeroInvoiceId: string,
    action: string,
    jobId?: string,
  ) => Promise<unknown>;
  /** Recognises the fence's refusal error; anything else is a failed read. */
  fenceRefusal: (error: unknown) => Obj | null;
  /** The Outlook invoice transport (send_invoice_email's verified path). */
  sendInvoiceEmail: DebtFollowupTransports["sendInvoiceEmail"];
  /** ghl-proxy send_sms, server credential. */
  sendSms: DebtFollowupTransports["sendSms"];
}

export function debtFollowupReads(
  client: Client,
  inputs: DebtFollowupLiveInputs,
): DebtFollowupReads {
  const locationId = Deno.env.get("GHL_LOCATION_ID") || "";
  return {
    async invoiceMirror(ids) {
      const { data, error } = await client.from("xero_invoices")
        .select(
          "xero_invoice_id,org_id,invoice_type,invoice_number,job_id,xero_contact_id,debt_classification,debt_blocker",
        )
        .in("xero_invoice_id", ids);
      if (error) throw new Error("invoice_mirror_unreadable");
      return data ?? [];
    },
    async xeroInvoice(id) {
      const { accessToken, tenantId } = await inputs.getToken(client);
      const res = await inputs.xeroGet(
        `/Invoices/${encodeURIComponent(id)}`,
        accessToken,
        tenantId,
      );
      const invoice = res?.Invoices?.[0];
      if (!invoice) throw new Error("xero_invoice_missing");
      return invoice;
    },
    async jobFacts(jobIds) {
      const { data, error } = await client.from("jobs").select(
        "id,status,ghl_contact_id",
      ).in("id", jobIds);
      if (error) throw new Error("job_read_unreadable");
      const out: Record<
        string,
        { status: string | null; ghl_contact_id: string | null }
      > = {};
      for (const row of (data as Obj[] | null) ?? []) {
        out[row.id] = {
          status: typeof row.status === "string" ? row.status : null,
          ghl_contact_id: row.ghl_contact_id || null,
        };
      }
      return out;
    },
    async contactMatch(xeroContactId) {
      const { data, error } = await client.from("contact_matches")
        .select("ghl_contact_id").eq("org_id", inputs.orgId).eq(
          "xero_contact_id",
          xeroContactId,
        ).limit(CONTACT_MATCH_SCAN_LIMIT + 1);
      if (error) throw new Error("contact_match_unreadable");
      // Every row is checked for a second GHL contact; a set too large to check
      // in one read fails closed instead of silently using the first rows.
      if ((data?.length ?? 0) > CONTACT_MATCH_SCAN_LIMIT) {
        throw new Error("contact_match_too_many");
      }
      const ids = new Set(
        ((data as Obj[] | null) ?? []).map((r) => r.ghl_contact_id).filter(
          Boolean,
        ),
      );
      // Two different GHL contacts for one Xero contact is not a verified binding.
      if (ids.size > 1) throw new Error("contact_match_ambiguous");
      return ids.size ? [...ids][0] as string : null;
    },
    async ghlContact(contactId) {
      const body = await ghlRead(`/contacts/${encodeURIComponent(contactId)}`);
      const contact = (body as Obj)?.contact as Obj | undefined;
      if (
        !contact || contact.id !== contactId ||
        (locationId && contact.locationId !== locationId)
      ) {
        throw new Error("contact_mismatch");
      }
      return {
        id: contact.id,
        phone: typeof contact.phone === "string" ? contact.phone : null,
        first_name: typeof contact.firstName === "string"
          ? contact.firstName
          : null,
      };
    },
    async emailAnchors(jobId) {
      const jobEmails = new Set<string>();
      if (jobId) {
        const { data, error } = await client.from("jobs").select("client_email")
          .eq("id", jobId).maybeSingle();
        if (error) throw new Error("job_email_unreadable");
        addDelimitedEmails(jobEmails, data?.client_email);
      }
      const company = await loadCompanyRecipientAnchors(client, jobId);
      return { job_emails: [...jobEmails], company_emails: [...company] };
    },
    async onlineInvoiceUrl(id) {
      const { accessToken, tenantId } = await inputs.getToken(client);
      const res = await inputs.xeroGet(
        `/Invoices/${encodeURIComponent(id)}/OnlineInvoice`,
        accessToken,
        tenantId,
      );
      const url = res?.OnlineInvoices?.[0]?.OnlineInvoiceUrl;
      return typeof url === "string" && url ? url : null;
    },
    async paymentLinkSentSince(jobId, sinceIso) {
      const { data, error } = await client.from("job_events").select("id")
        .eq("job_id", jobId).eq("event_type", "payment_link_sent").gte(
          "created_at",
          sinceIso,
        ).limit(1);
      if (error) throw new Error("payment_link_history_unreadable");
      return Array.isArray(data) && data.length > 0;
    },
    async sealedFence(action, invoices) {
      for (const inv of invoices) {
        try {
          await inputs.assertInvoiceAllowed(
            client,
            inv.xero_invoice_id,
            action,
            inv.job_id || undefined,
          );
        } catch (error) {
          const refusal = inputs.fenceRefusal(error);
          if (refusal) return refusal;
          throw error;
        }
      }
      return null;
    },
  };
}

export function debtFollowupTransports(
  client: Client,
  inputs: DebtFollowupLiveInputs,
): DebtFollowupTransports {
  return {
    sendSms: inputs.sendSms,
    sendInvoiceEmail: inputs.sendInvoiceEmail,
    async afterSent(proposal, proof, meta) {
      if (proposal.channel !== "sms") return; // the invoice transport logs invoice.emailed itself
      const outcome = proposal.kind === "thank_you_sms"
        ? "Thank-you SMS sent"
        : proposal.kind === "payment_link_sms"
        ? "Payment link SMS sent"
        : "SMS sent";
      const contactId = proposal.destination.channel === "sms"
        ? proposal.destination.ghl_contact_id
        : null;
      try {
        await client.from("payment_chase_logs").insert(
          proposal.invoices.map((inv) => ({
            xero_invoice_id: inv.xero_invoice_id,
            job_id: inv.job_id,
            ghl_contact_id: contactId,
            method: "sms",
            outcome,
            notes: proposal.body.substring(0, 500),
            chased_by: meta.approved_by_email,
          })),
        );
      } catch { /* desk log only */ }
      if (proposal.kind === "payment_link_sms" && proposal.job_id) {
        try {
          await client.from("job_events").insert({
            job_id: proposal.job_id,
            event_type: "payment_link_sent",
            detail_json: {
              xero_invoice_id: proposal.invoices[0].xero_invoice_id,
              invoice_number: proposal.invoices[0].invoice_number,
              message_id: proof.message_id ?? null,
              debt_followup_approval_id: meta.approval_id,
            },
          });
        } catch { /* desk log only */ }
      }
    },
  };
}

export function createDebtFollowupDeps(
  client: Client,
  inputs: DebtFollowupLiveInputs,
): DebtFollowupDeps {
  return {
    reads: debtFollowupReads(client, inputs),
    ledger: debtFollowupLedger(client),
    transports: debtFollowupTransports(client, inputs),
    orgId: inputs.orgId,
  };
}

/** ghl-proxy send_sms with the server credential (same path as the booking executor). */
export async function callGhlProxySendSms(
  body: Obj,
): Promise<{ status: number; body: Obj }> {
  const base = (Deno.env.get("SUPABASE_URL") || "").replace("/rest/v1", "");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!base || !key) {
    return {
      status: 503,
      body: { success: false, code: "proxy_unconfigured" },
    };
  }
  const res = await fetch(`${base}/functions/v1/ghl-proxy?action=send_sms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const parsed = await res.json().catch(() => ({}));
  return {
    status: res.status,
    body: parsed && typeof parsed === "object" ? parsed : {},
  };
}

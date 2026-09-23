/** Debt follow-up: exact-message approval and the one send executor.
 *
 * Every debtor text or invoice email (Clear Debt chase SMS, the payment-link
 * text, the paid thank-you text, and both send_invoice_email branches) goes
 * through this module. Contract: docs/debt-followup-approval.md.
 *
 *   debt_followup_propose  builds the exact proposal from fresh server reads
 *                          and returns its binding hash. Writes nothing.
 *   debt_followup_approve  the captain approves ONE exact proposal: body hash,
 *                          destination identity, selected invoice ids, email
 *                          subject and attachment identity, Xero snapshot and
 *                          debt-desk hold state. Expires after 30 minutes.
 *   debt_followup_execute  the press. Re-reads everything, rebuilds the
 *                          proposal and refuses on any change, failed read,
 *                          expiry or hash mismatch. One approval sends at most
 *                          once; a confirmed send carries provider proof.
 *
 * Dry run is the default. A press sends only when DEBT_FOLLOWUP_SEND_EXECUTE is
 * exactly "true" AND an allow-listed captain session pressed. Every other
 * press records a dry-run result and makes no provider send call. Nothing here
 * writes Xero, allocates money, or changes a payment.
 */
import {
  APPROVAL_ID_PATTERN,
  bookingHash,
  parseSalesBookingCaptainEmails,
} from "../_shared/booking_approval_gate.ts";
import {
  addDelimitedEmails,
  buildExpectedRecipientSet,
  normaliseFullEmail,
} from "./recipient_anchors.ts";
import { SMS_DEFAULT_FROM_NUMBER } from "../_shared/sms_from_number.ts";

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

export const DEBT_FOLLOWUP_CONTRACT = "debt-followup-approval/v1";
/** The execute switch. Only the exact value "true" sends. Never set in code. */
export const DEBT_FOLLOWUP_EXECUTE_ENV = "DEBT_FOLLOWUP_SEND_EXECUTE";
/** Comma-separated JWT emails that may approve and press. Unset: the default captain. */
export const DEBT_FOLLOWUP_CAPTAIN_EMAILS_ENV = "DEBT_FOLLOWUP_CAPTAIN_EMAILS";
export const DEBT_FOLLOWUP_APPROVAL_TTL_MS = 30 * 60_000;
export const DEBT_FOLLOWUP_MAX_INVOICES = 20;
export const DEBT_FOLLOWUP_MAX_SMS_CHARS = 1600;

export const DEBT_FOLLOWUP_KINDS = [
  "chase_sms",
  "payment_link_sms",
  "thank_you_sms",
  "invoice_email",
] as const;
export type DebtFollowupKind = typeof DEBT_FOLLOWUP_KINDS[number];
const SINGLE_INVOICE_KINDS = new Set<DebtFollowupKind>([
  "payment_link_sms",
  "thank_you_sms",
  "invoice_email",
]);
const SMS_KINDS = new Set<DebtFollowupKind>([
  "chase_sms",
  "payment_link_sms",
  "thank_you_sms",
]);
/** Debt-desk states that mean "do not chase this invoice". */
export const DEBT_FOLLOWUP_HOLD_CLASSES = new Set([
  "in_dispute",
  "not_owed",
  "bad_debt",
  "blocked_by_us",
]);
export const DEBT_FOLLOWUP_HOLD_BLOCKERS = new Set([
  "paid_unallocated",
  "payment_claimed",
  "invoice_wrong",
  "context_pending",
]);
const DEBT_HOLD_JOB_STATUSES = new Set([
  "in_progress",
  "scheduled",
  "draft",
  "scoping",
  "quoted",
]);
const COMPLETED_DEBT_JOB_STATUSES = new Set(["complete", "invoiced"]);

export function autoDebtClassificationForJobStatus(
  status: string | null,
): { classification: "blocked_by_us" | "genuine_debt"; reason: string } | null {
  if (!status) return null;
  if (DEBT_HOLD_JOB_STATUSES.has(status)) {
    return { classification: "blocked_by_us", reason: `Job status: ${status}` };
  }
  if (COMPLETED_DEBT_JOB_STATUSES.has(status)) {
    return {
      classification: "genuine_debt",
      reason: "Job complete, payment outstanding",
    };
  }
  return null;
}
const INVOICE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

// ── Request ────────────────────────────────────────────────────────────────

export interface DebtFollowupRequest {
  kind: DebtFollowupKind;
  xero_invoice_ids: string[];
  ghl_contact_id: string | null;
  /** chase_sms only: the operator's exact text. Other kinds are composed here. */
  message: string | null;
  /** invoice_email only. Null: the Xero contact's primary email is proposed. */
  to_email: string | null;
  cc: string[];
  subject: string | null;
}

export type Refusal = { ok: false; reason: string; detail?: Obj };
const refuse = (reason: string, detail?: Obj): Refusal => ({
  ok: false,
  reason,
  ...(detail ? { detail } : {}),
});

function optionalText(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return v ? v : null;
}

function emailList(value: unknown): string[] | null {
  if (value === undefined || value === null || value === "") return [];
  const parts: string[] = [];
  if (typeof value === "string") parts.push(...value.split(","));
  else if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== "string") return null;
      parts.push(...entry.split(","));
    }
  } else return null;
  const out = new Set<string>();
  for (const part of parts) {
    if (!part.trim()) continue;
    const email = normaliseFullEmail(part);
    if (!email) return null;
    out.add(email);
  }
  return [...out].sort();
}

/** Strict: a field the kind does not use is refused, never ignored. */
export function normaliseDebtFollowupRequest(
  raw: unknown,
): { ok: true; request: DebtFollowupRequest } | Refusal {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return refuse("request_required");
  }
  const r = raw as Obj;
  const kind = r.kind;
  if (!(DEBT_FOLLOWUP_KINDS as readonly string[]).includes(kind)) {
    return refuse("kind_invalid");
  }
  const rawIds = Array.isArray(r.xero_invoice_ids)
    ? r.xero_invoice_ids
    : r.xero_invoice_id !== undefined && r.xero_invoice_id !== null
    ? [r.xero_invoice_id]
    : [];
  const ids = new Set<string>();
  for (const id of rawIds) {
    if (typeof id !== "string" || !INVOICE_ID_PATTERN.test(id.trim())) {
      return refuse("invoice_id_invalid");
    }
    ids.add(id.trim());
  }
  if (ids.size === 0) return refuse("invoice_ids_required");
  if (ids.size > DEBT_FOLLOWUP_MAX_INVOICES) return refuse("too_many_invoices");
  if (SINGLE_INVOICE_KINDS.has(kind) && ids.size !== 1) {
    return refuse("single_invoice_required");
  }
  const contact = optionalText(r.ghl_contact_id);
  if (contact === undefined) return refuse("ghl_contact_id_invalid");
  const sms = SMS_KINDS.has(kind);

  let message: string | null = null;
  if (kind === "chase_sms") {
    if (typeof r.message !== "string" || !r.message.trim()) {
      return refuse("message_required");
    }
    if (r.message.length > DEBT_FOLLOWUP_MAX_SMS_CHARS) {
      return refuse("message_too_long");
    }
    if (r.message.includes("—")) return refuse("em_dash_not_allowed");
    message = r.message; // exact bytes: what is approved is what is sent
  } else if (r.message !== undefined && r.message !== null) {
    return refuse("message_not_allowed");
  }

  const to = optionalText(r.to_email);
  if (to === undefined) return refuse("to_email_invalid");
  const cc = emailList(r.cc);
  if (cc === null) return refuse("cc_invalid");
  const subject = optionalText(r.subject);
  if (subject === undefined || (subject && subject.length > 200)) {
    return refuse("subject_invalid");
  }
  if (subject?.includes("—")) return refuse("em_dash_not_allowed");
  if (sms && (to || cc.length || subject)) {
    return refuse("email_fields_not_allowed");
  }
  if (!sms && contact) return refuse("ghl_contact_id_not_allowed");
  const toEmail = to ? normaliseFullEmail(to) : null;
  if (to && !toEmail) return refuse("to_email_invalid");
  return {
    ok: true,
    request: {
      kind,
      xero_invoice_ids: [...ids].sort(),
      ghl_contact_id: contact,
      message,
      to_email: toEmail,
      cc,
      subject,
    },
  };
}

// ── Composed wording (client-facing: no em dashes) ─────────────────────────

export function formatAud(amount: number): string {
  const [whole, cents] = Math.abs(amount).toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${amount < 0 ? "-" : ""}$${grouped}.${cents}`;
}

function firstName(name: string | null): string {
  const first = (name || "").trim().split(/\s+/)[0];
  return first || "there";
}

export function paymentLinkSmsBody(
  name: string | null,
  invoiceNumber: string,
  url: string,
): string {
  return `Hi ${
    firstName(name)
  }, your invoice ${invoiceNumber} is ready. You can view and pay online here: ${url}\n\nThanks,\nSecureWorks Group`;
}

export function thankYouSmsBody(
  name: string | null,
  amountPaid: number,
  invoiceNumber: string,
): string {
  return `Hi ${firstName(name)}, we've received your payment of ${
    formatAud(amountPaid)
  } for invoice ${invoiceNumber}. Thank you, SecureWorks Group`;
}

function htmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(
    />/g,
    "&gt;",
  ).replace(/"/g, "&quot;");
}

/** The ONE invoice email body. send_invoice_email's Outlook transport uses it. */
export function invoiceEmailHtmlBody(invoiceNumber: string): string {
  return `<p>Please find your invoice attached.</p><p>Invoice: <strong>${
    htmlEscape(invoiceNumber)
  }</strong></p>`;
}

export function defaultInvoiceEmailSubject(invoiceNumber: string): string {
  return `Invoice ${invoiceNumber} from SecureWorks Group`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

// ── Proposal ───────────────────────────────────────────────────────────────

export interface MirrorInvoiceRow {
  xero_invoice_id: string;
  org_id: string | null;
  invoice_type: string | null;
  invoice_number: string | null;
  job_id: string | null;
  xero_contact_id: string | null;
  debt_classification: string | null;
  debt_blocker: string | null;
}

/** Server reads. Every one throws on a fault; a thrown read always refuses. */
export interface DebtFollowupReads {
  invoiceMirror(ids: string[]): Promise<MirrorInvoiceRow[]>;
  /** Live Xero GET /Invoices/{id}: the Invoices[0] object. */
  xeroInvoice(id: string): Promise<Obj>;
  /** Current job status and GHL contact for each linked job. */
  jobFacts(jobIds: string[]): Promise<
    Record<string, { status: string | null; ghl_contact_id: string | null }>
  >;
  /** contact_matches: the GHL contact bound to a Xero contact, or null. */
  contactMatch(xeroContactId: string): Promise<string | null>;
  /** Live GHL contact read (location-checked). */
  ghlContact(contactId: string): Promise<
    { id: string; phone: string | null; first_name: string | null }
  >;
  /** jobs.client_email and make-safe company anchors for the linked job. */
  emailAnchors(jobId: string | null): Promise<
    { job_emails: string[]; company_emails: string[] }
  >;
  /** Live Xero GET /Invoices/{id}/OnlineInvoice URL, or null. */
  onlineInvoiceUrl(id: string): Promise<string | null>;
  /** True when a payment link was sent for this job since the instant. */
  paymentLinkSentSince(jobId: string, sinceIso: string): Promise<boolean>;
  /** The sealed SES money fence: a refusal object, or null when allowed. */
  sealedFence(
    action: string,
    invoices: { xero_invoice_id: string; job_id: string | null }[],
  ): Promise<Obj | null>;
}

export interface InvoiceSnapshot {
  xero_invoice_id: string;
  invoice_number: string;
  status: string;
  amount_due: number;
  amount_paid: number;
  total: number;
  currency_code: string | null;
  xero_contact_id: string;
  updated_date_utc: string | null;
  job_id: string | null;
  hold: {
    classification: string | null;
    blocker: string | null;
    job_status: string | null;
  };
}

export type SmsDestination = {
  channel: "sms";
  ghl_contact_id: string;
  phone: string;
  from_number: string;
};
export type EmailDestination = { channel: "email"; to: string; cc: string[] };

export interface DebtFollowupProposal {
  contract: string;
  kind: DebtFollowupKind;
  channel: "sms" | "email";
  org_id: string;
  debtor_xero_contact_id: string;
  /** The one job every selected invoice shares, else null. */
  job_id: string | null;
  invoices: InvoiceSnapshot[];
  destination: SmsDestination | EmailDestination;
  body: string;
  body_sha256: string;
  email: null | {
    subject: string;
    attachment: {
      kind: "xero_invoice_pdf";
      xero_invoice_id: string;
      invoice_number: string;
      file_name: string;
    };
  };
}

export type BuiltProposal = {
  ok: true;
  proposal: DebtFollowupProposal;
  binding_hash: string;
};

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function phoneKey(value: string): string {
  const d = value.replace(/[^\d+]/g, "");
  return d.startsWith("0") ? `+61${d.slice(1)}` : d;
}

async function tryRead<T>(
  read: () => Promise<T>,
  reason: string,
): Promise<{ ok: true; value: T } | Refusal> {
  try {
    return { ok: true, value: await read() };
  } catch {
    return refuse(reason);
  }
}

/** Legacy action name the SES money fence already knows for this kind. */
const FENCE_ACTION: Record<DebtFollowupKind, string> = {
  chase_sms: "send_chase_sms",
  payment_link_sms: "send_payment_link",
  thank_you_sms: "handle_payment_event",
  invoice_email: "send_invoice_email",
};

/** Build the exact proposal from fresh reads. Deterministic in those reads. */
export async function buildDebtFollowupProposal(
  request: DebtFollowupRequest,
  reads: DebtFollowupReads,
  ctx: { orgId: string; now: Date },
): Promise<BuiltProposal | Refusal> {
  const kind = request.kind;
  const ids = request.xero_invoice_ids;

  const mirrorRead = await tryRead(
    () => reads.invoiceMirror(ids),
    "invoice_mirror_unreadable",
  );
  if (!mirrorRead.ok) return mirrorRead;
  const mirror = new Map(mirrorRead.value.map((r) => [r.xero_invoice_id, r]));
  for (const id of ids) {
    const row = mirror.get(id);
    if (!row) return refuse("invoice_not_in_mirror", { xero_invoice_id: id });
    if (row.org_id !== ctx.orgId) {
      return refuse("invoice_wrong_org", { xero_invoice_id: id });
    }
    if (String(row.invoice_type || "").toUpperCase() !== "ACCREC") {
      return refuse("invoice_not_receivable", { xero_invoice_id: id });
    }
  }
  // v1 scope: every approval and send covers invoices of exactly ONE job, so a
  // confirmed send always carries that job id and lands once in that job's
  // conversation. Unlinked invoices and multi-job selections are refused here,
  // before any provider read, at approval and again at the press.
  const scopeJobs = new Set(ids.map((id) => mirror.get(id)!.job_id || ""));
  if (scopeJobs.has("") || scopeJobs.size !== 1) {
    return refuse("single_job_scope_required", {
      job_ids: [...scopeJobs].filter(Boolean).sort(),
      unlinked_invoice_ids: ids.filter((id) => !mirror.get(id)!.job_id),
    });
  }

  const fence = await tryRead(
    () =>
      reads.sealedFence(
        FENCE_ACTION[kind],
        ids.map((id) => ({
          xero_invoice_id: id,
          job_id: mirror.get(id)!.job_id,
        })),
      ),
    "sealed_fence_unreadable",
  );
  if (!fence.ok) return fence;
  if (fence.value) {
    return refuse("sealed_ses_invoice", { refusal: fence.value });
  }

  const linkedJobIds = [
    ...new Set(mirrorRead.value.map((row) => row.job_id).filter(Boolean)),
  ] as string[];
  const jobFactsRead = linkedJobIds.length
    ? await tryRead(
      () => reads.jobFacts(linkedJobIds),
      kind === "thank_you_sms"
        ? "job_contact_unreadable"
        : "job_status_unreadable",
    )
    : { ok: true as const, value: {} };
  if (!jobFactsRead.ok) return jobFactsRead;
  if (kind !== "thank_you_sms") {
    for (const jobId of linkedJobIds) {
      const status = jobFactsRead.value[jobId]?.status;
      if (typeof status !== "string" || !status) {
        return refuse("job_status_unreadable", { job_id: jobId });
      }
    }
  }

  const invoices: InvoiceSnapshot[] = [];
  const xeroById = new Map<string, Obj>();
  for (const id of ids) {
    const read = await tryRead(
      () => reads.xeroInvoice(id),
      "xero_invoice_unreadable",
    );
    if (!read.ok) return { ...read, detail: { xero_invoice_id: id } };
    const x = read.value;
    const row = mirror.get(id)!;
    const amountDue = num(x?.AmountDue), total = num(x?.Total);
    const amountPaid = num(x?.AmountPaid);
    const contactId = typeof x?.Contact?.ContactID === "string"
      ? x.Contact.ContactID
      : "";
    if (
      x?.InvoiceID !== id || amountDue === null || total === null ||
      amountPaid === null || !contactId || typeof x?.Status !== "string"
    ) {
      return refuse("xero_invoice_unreadable", { xero_invoice_id: id });
    }
    if (String(x.Type || "").toUpperCase() !== "ACCREC") {
      return refuse("invoice_not_receivable", { xero_invoice_id: id });
    }
    if (row.xero_contact_id && row.xero_contact_id !== contactId) {
      return refuse("contact_identity_drift", { xero_invoice_id: id });
    }
    const jobStatus = row.job_id
      ? jobFactsRead.value[row.job_id]?.status ?? null
      : null;
    const currentClassification = row.debt_classification || "unclassified";
    const derivedClassification = currentClassification === "unclassified"
      ? autoDebtClassificationForJobStatus(jobStatus)
      : null;
    xeroById.set(id, x);
    invoices.push({
      xero_invoice_id: id,
      invoice_number: String(x.InvoiceNumber || row.invoice_number || id),
      status: String(x.Status).toUpperCase(),
      amount_due: amountDue,
      amount_paid: amountPaid,
      total,
      currency_code: typeof x.CurrencyCode === "string" ? x.CurrencyCode : null,
      xero_contact_id: contactId,
      updated_date_utc: typeof x.UpdatedDateUTC === "string"
        ? x.UpdatedDateUTC
        : null,
      job_id: row.job_id || null,
      hold: {
        classification: derivedClassification?.classification ??
          (row.debt_classification || null),
        blocker: row.debt_blocker || null,
        job_status: jobStatus,
      },
    });
  }
  const debtors = new Set(invoices.map((i) => i.xero_contact_id));
  if (debtors.size !== 1) return refuse("multiple_debtors");
  const debtor = invoices[0].xero_contact_id;

  for (const inv of invoices) {
    if (kind === "thank_you_sms") {
      if (inv.status !== "PAID" || inv.amount_due !== 0) {
        return refuse("invoice_not_paid", {
          xero_invoice_id: inv.xero_invoice_id,
        });
      }
      if (inv.currency_code?.toUpperCase() !== "AUD") {
        return refuse("payment_currency_unsupported", {
          xero_invoice_id: inv.xero_invoice_id,
          currency_code: inv.currency_code,
        });
      }
      continue;
    }
    if (inv.status !== "AUTHORISED" || !(inv.amount_due > 0)) {
      return refuse("invoice_not_payable", {
        xero_invoice_id: inv.xero_invoice_id,
        status: inv.status,
      });
    }
    if (
      DEBT_FOLLOWUP_HOLD_CLASSES.has(inv.hold.classification || "") ||
      DEBT_FOLLOWUP_HOLD_BLOCKERS.has(inv.hold.blocker || "")
    ) {
      return refuse("invoice_on_hold", {
        xero_invoice_id: inv.xero_invoice_id,
        hold: inv.hold,
      });
    }
  }

  const jobIds = [
    ...new Set(invoices.map((i) => i.job_id).filter(Boolean)),
  ] as string[];
  const jobId =
    jobIds.length === 1 && invoices.every((i) => i.job_id === jobIds[0])
      ? jobIds[0]
      : null;
  const first = invoices[0];

  let destination: SmsDestination | EmailDestination;
  let contactName: string | null = null;
  if (SMS_KINDS.has(kind)) {
    const jobFacts = jobFactsRead.value;
    const bound = new Set<string>();
    let matchFor: string | null | undefined;
    for (const inv of invoices) {
      let contact = inv.job_id
        ? jobFacts[inv.job_id]?.ghl_contact_id ?? null
        : null;
      if (!contact) {
        if (matchFor === undefined) {
          const m = await tryRead(
            () => reads.contactMatch(debtor),
            "contact_match_unreadable",
          );
          if (!m.ok) return m;
          matchFor = m.value;
        }
        contact = matchFor;
      }
      if (!contact) {
        return refuse("destination_unverified", {
          xero_invoice_id: inv.xero_invoice_id,
        });
      }
      bound.add(contact);
    }
    if (bound.size !== 1) return refuse("destination_ambiguous");
    const verified = [...bound][0];
    if (request.ghl_contact_id && request.ghl_contact_id !== verified) {
      return refuse("destination_mismatch");
    }
    const c = await tryRead(
      () => reads.ghlContact(verified),
      "contact_unreadable",
    );
    if (!c.ok) return c;
    if (c.value.id !== verified) return refuse("contact_unreadable");
    if (!c.value.phone || !c.value.phone.trim()) {
      return refuse("destination_has_no_phone");
    }
    contactName = c.value.first_name;
    destination = {
      channel: "sms",
      ghl_contact_id: verified,
      phone: phoneKey(c.value.phone),
      from_number: SMS_DEFAULT_FROM_NUMBER,
    };
  } else {
    const x = xeroById.get(first.xero_invoice_id)!;
    const xeroEmails = new Set<string>();
    let malformed = addDelimitedEmails(xeroEmails, x?.Contact?.EmailAddress);
    for (
      const cp of (Array.isArray(x?.Contact?.ContactPersons)
        ? x.Contact.ContactPersons
        : [])
    ) {
      malformed = addDelimitedEmails(xeroEmails, cp?.EmailAddress) || malformed;
    }
    if (malformed) {
      return refuse("xero_contact_email_invalid");
    }
    const anchors = await tryRead(
      () =>
        reads.emailAnchors(first.job_id),
      "recipient_anchors_unreadable",
    );
    if (!anchors.ok) return anchors;
    const expected = buildExpectedRecipientSet({
      xeroEmails,
      jobEmails: new Set(anchors.value.job_emails),
      companyEmails: new Set(anchors.value.company_emails),
    });
    const primary = normaliseFullEmail(
      String(x?.Contact?.EmailAddress || "").split(",")[0] || "",
    );
    const to = request.to_email ?? primary;
    if (!to || expected.size === 0) return refuse("recipient_unverifiable");
    if (!expected.has(to)) return refuse("recipient_mismatch");
    for (const cc of request.cc) {
      if (!expected.has(cc)) return refuse("cc_recipient_mismatch");
    }
    destination = { channel: "email", to, cc: request.cc };
  }

  let body: string;
  let email: DebtFollowupProposal["email"] = null;
  if (kind === "chase_sms") {
    body = request.message as string;
  } else if (kind === "payment_link_sms") {
    if (first.job_id) {
      const since = new Date(ctx.now.getTime() - 24 * 60 * 60_000)
        .toISOString();
      const recent = await tryRead(
        () => reads.paymentLinkSentSince(first.job_id as string, since),
        "payment_link_history_unreadable",
      );
      if (!recent.ok) return recent;
      if (recent.value) return refuse("payment_link_recently_sent");
    }
    const url = await tryRead(
      () => reads.onlineInvoiceUrl(first.xero_invoice_id),
      "online_invoice_unreadable",
    );
    if (!url.ok) return url;
    if (!url.value || !/^https:\/\//.test(url.value)) {
      return refuse("online_invoice_missing");
    }
    body = paymentLinkSmsBody(contactName, first.invoice_number, url.value);
  } else if (kind === "thank_you_sms") {
    if (!(first.amount_paid > 0)) return refuse("payment_amount_unknown");
    body = thankYouSmsBody(
      contactName,
      first.amount_paid,
      first.invoice_number,
    );
  } else {
    body = invoiceEmailHtmlBody(first.invoice_number);
    email = {
      subject: request.subject ??
        defaultInvoiceEmailSubject(first.invoice_number),
      attachment: {
        kind: "xero_invoice_pdf",
        xero_invoice_id: first.xero_invoice_id,
        invoice_number: first.invoice_number,
        file_name: `${first.invoice_number}.pdf`,
      },
    };
  }

  if (body.includes("—") || email?.subject.includes("—")) {
    return refuse("em_dash_not_allowed");
  }

  const proposal: DebtFollowupProposal = {
    contract: DEBT_FOLLOWUP_CONTRACT,
    kind,
    channel: SMS_KINDS.has(kind) ? "sms" : "email",
    org_id: ctx.orgId,
    debtor_xero_contact_id: debtor,
    job_id: jobId,
    invoices,
    destination,
    body,
    body_sha256: await sha256Hex(body),
    email,
  };
  return { ok: true, proposal, binding_hash: await bookingHash(proposal) };
}

/** Which bound coordinates moved between the approved and the fresh proposal. */
export function changedCoordinates(
  approved: DebtFollowupProposal,
  fresh: DebtFollowupProposal,
): string[] {
  const out: string[] = [];
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  for (
    const key of [
      "kind",
      "channel",
      "org_id",
      "debtor_xero_contact_id",
      "job_id",
    ] as const
  ) {
    if (!same(approved[key], fresh[key])) out.push(key);
  }
  const freshInv = new Map(fresh.invoices.map((i) => [i.xero_invoice_id, i]));
  for (const inv of approved.invoices) {
    const now = freshInv.get(inv.xero_invoice_id);
    if (!now) {
      out.push(`invoices.${inv.xero_invoice_id}`);
      continue;
    }
    for (const field of Object.keys(inv) as (keyof InvoiceSnapshot)[]) {
      if (!same(inv[field], now[field])) {
        out.push(`invoices.${inv.xero_invoice_id}.${field}`);
      }
    }
  }
  if (approved.invoices.length !== fresh.invoices.length) out.push("invoices");
  for (
    const field of new Set([
      ...Object.keys(approved.destination),
      ...Object.keys(fresh.destination),
    ])
  ) {
    if (
      !same(
        (approved.destination as Obj)[field],
        (fresh.destination as Obj)[field],
      )
    ) {
      out.push(`destination.${field}`);
    }
  }
  if (approved.body_sha256 !== fresh.body_sha256) out.push("body");
  if (!same(approved.email, fresh.email)) out.push("email");
  return out.length ? out : ["binding_hash"];
}

// ── Ledger, transports, auth ───────────────────────────────────────────────

export interface ApprovalRecord {
  approval_id: string;
  binding_hash: string;
  kind: DebtFollowupKind;
  request: DebtFollowupRequest;
  proposal: DebtFollowupProposal;
  body_sha256: string;
  approved_by_email: string;
  /** The approving captain's user id (the caller identity on the approval). */
  approved_by_user_id: string;
  approved_at: string;
  expires_at: string;
}

export type LiveOutcome = "sending" | "sent" | "failed" | "unknown";
export interface LiveExecution {
  approval_id: string;
  outcome: LiveOutcome;
  provider: string | null;
  provider_message_id: string | null;
  provider_proof: Obj | null;
}

export interface AttemptRow {
  approval_id: string | null;
  binding_hash: string | null;
  kind: DebtFollowupKind;
  channel: "sms" | "email";
  outcome: "dry_run" | "refused";
  reason: string;
  pressed_by: string;
  source_action: string;
  proposal: DebtFollowupProposal | null;
}

export interface DebtFollowupLedger {
  getApproval(approvalId: string): Promise<ApprovalRecord | null>;
  /** An unexpired approval of this exact binding, for an idempotent re-approve. */
  findOpenApproval(
    bindingHash: string,
    nowIso: string,
  ): Promise<ApprovalRecord | null>;
  insertApproval(record: ApprovalRecord): Promise<void>;
  liveExecution(approvalId: string): Promise<LiveExecution | null>;
  /** Insert the one live row (outcome sending). False when one already exists. */
  claimLive(row: {
    approval_id: string;
    binding_hash: string;
    kind: DebtFollowupKind;
    channel: "sms" | "email";
    press_token: string;
    pressed_by: string;
    source_action: string;
    proposal: DebtFollowupProposal;
  }): Promise<boolean>;
  settleLive(
    approvalId: string,
    pressToken: string,
    outcome: {
      outcome: "sent" | "failed" | "unknown";
      reason: string | null;
      provider: "ghl" | "outlook";
      provider_message_id: string | null;
      provider_proof: Obj | null;
    },
  ): Promise<void>;
  /** Dry-run and refused rows. Append only. */
  recordAttempt(row: AttemptRow): Promise<void>;
}

export interface DebtFollowupTransports {
  /** POST ghl-proxy?action=send_sms (server credential). A provider call. */
  sendSms(
    body: { contactId: string; message: string; jobId?: string },
  ): Promise<
    { status: number; body: Obj }
  >;
  /** The Outlook branded-PDF transport (_verifyAndSendInvoiceEmail). A provider call. */
  sendInvoiceEmail(args: {
    xero_invoice_id: string;
    to_email: string;
    cc: string[];
    subject_override: string;
    job_id: string | null;
    approval_id: string;
  }): Promise<{ status: number; body: Obj }>;
  /** Desk logs after a confirmed send (payment_chase_logs / job_events). */
  afterSent(
    proposal: DebtFollowupProposal,
    proof: Obj,
    meta: { approval_id: string; approved_by_email: string },
  ): Promise<void>;
}

export interface DebtFollowupDeps {
  reads: DebtFollowupReads;
  ledger: DebtFollowupLedger;
  transports: DebtFollowupTransports;
  orgId: string;
  envGet?: (name: string) => string | undefined;
  now?: () => Date;
  newToken?: () => string;
}

export interface DebtFollowupAuth {
  mode: string;
  email: string | null;
  /** The signed-in user's id (JWT callers); null for the ops key. */
  user_id?: string | null;
}

export type DebtFollowupResult =
  | { status: "refused"; reason: string; detail?: Obj; recorded?: boolean }
  | {
    status: "proposed";
    binding_hash: string;
    proposal: DebtFollowupProposal;
    execute_switch: "on" | "off";
  }
  | {
    status: "approved";
    approval_id: string;
    binding_hash: string;
    replayed: boolean;
    expires_at: string;
    proposal: DebtFollowupProposal;
  }
  | {
    status: "dry_run";
    reason: string;
    approval_id: string | null;
    binding_hash: string;
    would_send: DebtFollowupProposal;
    execute_switch: "on" | "off";
    recorded: boolean;
  }
  | {
    status: "sent";
    approval_id: string;
    binding_hash: string;
    replayed: boolean;
    provider: string | null;
    provider_message_id: string | null;
    provider_proof: Obj | null;
  }
  | {
    status: "failed" | "unknown";
    reason: string;
    approval_id: string;
    binding_hash: string;
  };

function envOf(deps: DebtFollowupDeps) {
  return deps.envGet ?? ((n: string) => Deno.env.get(n));
}

export function debtFollowupCaptainEmails(
  envGet: (name: string) => string | undefined,
): string[] {
  return parseSalesBookingCaptainEmails(
    envGet(DEBT_FOLLOWUP_CAPTAIN_EMAILS_ENV),
  );
}

/** The switch reads ON only for the exact value "true". Anything else is off. */
export function debtFollowupExecuteSwitchOn(
  envGet: (name: string) => string | undefined,
): boolean {
  try {
    return envGet(DEBT_FOLLOWUP_EXECUTE_ENV) === "true";
  } catch {
    return false;
  }
}

function captainEmail(
  auth: DebtFollowupAuth,
  deps: DebtFollowupDeps,
): string | null {
  if (auth.mode !== "jwt") return null;
  const email = String(auth.email || "").trim().toLowerCase();
  return email && debtFollowupCaptainEmails(envOf(deps)).includes(email)
    ? email
    : null;
}

function pressedBy(auth: DebtFollowupAuth): string {
  const email = String(auth.email || "").trim().toLowerCase();
  return email ? email : `ops-api:${auth.mode || "unknown"}`;
}

const refused = (reason: string, detail?: Obj): DebtFollowupResult => ({
  status: "refused",
  reason,
  ...(detail ? { detail } : {}),
});

async function recordAttempt(
  deps: DebtFollowupDeps,
  row: AttemptRow,
): Promise<boolean> {
  try {
    await deps.ledger.recordAttempt(row);
    return true;
  } catch {
    return false;
  }
}

// ── Actions ────────────────────────────────────────────────────────────────

export async function debtFollowupProposeAction(args: {
  method: string;
  body: Obj;
  deps: DebtFollowupDeps;
}): Promise<DebtFollowupResult> {
  if (args.method !== "POST") return refused("method_not_allowed");
  const norm = normaliseDebtFollowupRequest(args.body?.request ?? args.body);
  if (!norm.ok) return refused(norm.reason, norm.detail);
  const now = (args.deps.now ?? (() => new Date()))();
  const built = await buildDebtFollowupProposal(norm.request, args.deps.reads, {
    orgId: args.deps.orgId,
    now,
  });
  if (!built.ok) return refused(built.reason, built.detail);
  return {
    status: "proposed",
    binding_hash: built.binding_hash,
    proposal: built.proposal,
    execute_switch: debtFollowupExecuteSwitchOn(envOf(args.deps))
      ? "on"
      : "off",
  };
}

/** The captain approves one exact proposal. Records approval only; never sends. */
export async function debtFollowupApproveAction(args: {
  method: string;
  auth: DebtFollowupAuth;
  body: Obj;
  deps: DebtFollowupDeps;
}): Promise<DebtFollowupResult> {
  const { deps } = args;
  if (args.method !== "POST") return refused("method_not_allowed");
  const approver = captainEmail(args.auth, deps);
  const approverUserId = String(args.auth.user_id || "").trim();
  if (!approver || !approverUserId) return refused("approval_requires_captain");
  const expected = args.body?.expected_binding_hash;
  if (typeof expected !== "string" || !APPROVAL_ID_PATTERN.test(expected)) {
    return refused("expected_binding_hash_required");
  }
  const norm = normaliseDebtFollowupRequest(args.body?.request);
  if (!norm.ok) return refused(norm.reason, norm.detail);
  const now = (deps.now ?? (() => new Date()))();
  const built = await buildDebtFollowupProposal(norm.request, deps.reads, {
    orgId: deps.orgId,
    now,
  });
  if (!built.ok) return refused(built.reason, built.detail);
  if (built.binding_hash !== expected) {
    return refused("proposal_changed", {
      binding_hash: built.binding_hash,
      proposal: built.proposal,
    });
  }
  let open: ApprovalRecord | null;
  try {
    open = await deps.ledger.findOpenApproval(expected, now.toISOString());
  } catch {
    return refused("approval_ledger_unreadable");
  }
  if (open) {
    return {
      status: "approved",
      approval_id: open.approval_id,
      binding_hash: open.binding_hash,
      replayed: true,
      expires_at: open.expires_at,
      proposal: open.proposal,
    };
  }
  const approvedAt = now.toISOString();
  const record: ApprovalRecord = {
    approval_id: await bookingHash({
      binding_hash: expected,
      approved_at: approvedAt,
    }),
    binding_hash: expected,
    kind: norm.request.kind,
    request: norm.request,
    proposal: built.proposal,
    body_sha256: built.proposal.body_sha256,
    approved_by_email: approver,
    approved_by_user_id: approverUserId,
    approved_at: approvedAt,
    expires_at: new Date(now.getTime() + DEBT_FOLLOWUP_APPROVAL_TTL_MS)
      .toISOString(),
  };
  try {
    await deps.ledger.insertApproval(record);
  } catch {
    return refused("approval_ledger_unwritable");
  }
  return {
    status: "approved",
    approval_id: record.approval_id,
    binding_hash: record.binding_hash,
    replayed: false,
    expires_at: record.expires_at,
    proposal: record.proposal,
  };
}

function priorLiveResult(
  live: LiveExecution,
  record: ApprovalRecord,
): DebtFollowupResult {
  if (live.outcome === "sent") {
    return {
      status: "sent",
      approval_id: record.approval_id,
      binding_hash: record.binding_hash,
      replayed: true,
      provider: live.provider,
      provider_message_id: live.provider_message_id,
      provider_proof: live.provider_proof,
    };
  }
  // sending / unknown / failed: one approval, one press. Never send again.
  return refused("approval_already_pressed", { outcome: live.outcome });
}

/** Legacy bodies may restate coordinates; any restated one must match the approval. */
export function legacyBodyMatchesApproval(
  approved: DebtFollowupRequest,
  legacy: Obj,
): boolean {
  const ids = Array.isArray(legacy.xero_invoice_ids)
    ? legacy.xero_invoice_ids
    : legacy.xero_invoice_id
    ? [legacy.xero_invoice_id]
    : null;
  if (
    ids &&
    JSON.stringify([...new Set(ids.map(String))].sort()) !==
      JSON.stringify(approved.xero_invoice_ids)
  ) {
    return false;
  }
  if (
    legacy.ghl_contact_id && legacy.ghl_contact_id !== approved.ghl_contact_id
  ) {
    return false;
  }
  if (
    typeof legacy.message === "string" && legacy.message !== approved.message
  ) return false;
  if (legacy.to_email) {
    const to = normaliseFullEmail(String(legacy.to_email));
    if (to !== approved.to_email) return false;
  }
  if (legacy.cc !== undefined && legacy.cc !== null && legacy.cc !== "") {
    const cc = emailList(legacy.cc);
    if (!cc || JSON.stringify(cc) !== JSON.stringify(approved.cc)) return false;
  }
  if (legacy.subject && String(legacy.subject).trim() !== approved.subject) {
    return false;
  }
  return true;
}

/** The press. Every check runs; only a captain press with the switch on sends. */
export async function debtFollowupExecuteAction(args: {
  method: string;
  auth: DebtFollowupAuth;
  body: Obj;
  deps: DebtFollowupDeps;
  /** Legacy wrappers: the approval must be for this kind and match the body. */
  expectKind?: DebtFollowupKind;
  legacyBody?: Obj;
  sourceAction?: string;
}): Promise<DebtFollowupResult> {
  const { deps } = args;
  const source = args.sourceAction ?? "debt_followup_execute";
  if (args.method !== "POST") return refused("method_not_allowed");
  const approvalId = args.body?.approval_id;
  if (typeof approvalId !== "string" || !APPROVAL_ID_PATTERN.test(approvalId)) {
    return refused("approval_id_required");
  }
  if (
    "dry_run" in (args.body ?? {}) && typeof args.body.dry_run !== "boolean"
  ) {
    return refused("invalid_dry_run");
  }
  let record: ApprovalRecord | null;
  try {
    record = await deps.ledger.getApproval(approvalId);
  } catch {
    return refused("approval_unreadable");
  }
  if (!record) return refused("approval_not_found");
  if (args.expectKind && record.kind !== args.expectKind) {
    return refused("approval_kind_mismatch");
  }
  if (
    args.legacyBody &&
    !legacyBodyMatchesApproval(record.request, args.legacyBody)
  ) {
    return refused("approval_request_mismatch");
  }
  const integrity = record.proposal?.contract === DEBT_FOLLOWUP_CONTRACT &&
    record.proposal.kind === record.kind &&
    (await bookingHash(record.proposal)) === record.binding_hash &&
    (await sha256Hex(String(record.proposal.body))) === record.body_sha256 &&
    record.proposal.body_sha256 === record.body_sha256;
  if (!integrity) return refused("approval_integrity_failed");
  const captains = debtFollowupCaptainEmails(envOf(deps));
  if (
    !captains.includes(String(record.approved_by_email || "").toLowerCase())
  ) {
    return refused("approval_not_by_captain");
  }
  let live: LiveExecution | null;
  try {
    live = await deps.ledger.liveExecution(record.approval_id);
  } catch {
    return refused("execution_ledger_unreadable");
  }
  // A settled press replays its proof (never a second send), even after expiry.
  if (live) return priorLiveResult(live, record);
  const now = (deps.now ?? (() => new Date()))();
  const expiresAt = Date.parse(record.expires_at);
  if (!Number.isFinite(expiresAt) || now.getTime() >= expiresAt) {
    return refused("approval_expired");
  }

  // Rebuild from fresh reads. Any refusal, failed read or moved coordinate refuses.
  const norm = normaliseDebtFollowupRequest(record.request);
  if (!norm.ok) return refused("approval_integrity_failed");
  const fresh = await buildDebtFollowupProposal(norm.request, deps.reads, {
    orgId: deps.orgId,
    now,
  });
  const press = pressedBy(args.auth);
  if (!fresh.ok) {
    const recordedRefusal = await recordAttempt(deps, {
      approval_id: record.approval_id,
      binding_hash: record.binding_hash,
      kind: record.kind,
      channel: record.proposal.channel,
      outcome: "refused",
      reason: fresh.reason,
      pressed_by: press,
      source_action: source,
      proposal: null,
    });
    return {
      ...refused(fresh.reason, fresh.detail),
      recorded: recordedRefusal,
    } as DebtFollowupResult;
  }
  if (fresh.binding_hash !== record.binding_hash) {
    const changed = changedCoordinates(record.proposal, fresh.proposal);
    const recordedStale = await recordAttempt(deps, {
      approval_id: record.approval_id,
      binding_hash: record.binding_hash,
      kind: record.kind,
      channel: record.proposal.channel,
      outcome: "refused",
      reason: "approval_stale",
      pressed_by: press,
      source_action: source,
      proposal: fresh.proposal,
    });
    return {
      status: "refused",
      reason: "approval_stale",
      detail: { changed },
      recorded: recordedStale,
    };
  }

  const switchOn = debtFollowupExecuteSwitchOn(envOf(deps));
  const captainPress = captainEmail(args.auth, deps);
  const dryReason = !captainPress
    ? "press_is_not_captain"
    : args.body?.dry_run === true
    ? "dry_run_requested"
    : !switchOn
    ? "execute_switch_off"
    : null;
  if (dryReason) {
    const recorded = await recordAttempt(deps, {
      approval_id: record.approval_id,
      binding_hash: record.binding_hash,
      kind: record.kind,
      channel: record.proposal.channel,
      outcome: "dry_run",
      reason: dryReason,
      pressed_by: press,
      source_action: source,
      proposal: record.proposal,
    });
    return {
      status: "dry_run",
      reason: dryReason,
      approval_id: record.approval_id,
      binding_hash: record.binding_hash,
      would_send: record.proposal,
      execute_switch: switchOn ? "on" : "off",
      recorded,
    };
  }

  // Live: claim first. A claim is permanent: one approval, one provider call.
  const token = (deps.newToken ?? (() => crypto.randomUUID()))();
  let claimed: boolean;
  try {
    claimed = await deps.ledger.claimLive({
      approval_id: record.approval_id,
      binding_hash: record.binding_hash,
      kind: record.kind,
      channel: record.proposal.channel,
      press_token: token,
      pressed_by: captainPress as string,
      source_action: source,
      proposal: record.proposal,
    });
  } catch {
    return refused("execution_ledger_unwritable");
  }
  if (!claimed) {
    try {
      const after = await deps.ledger.liveExecution(record.approval_id);
      if (after) return priorLiveResult(after, record);
    } catch { /* fall through */ }
    return refused("approval_already_pressed");
  }

  const p = record.proposal;
  const settled = await sendOnce(deps, record, p, token);
  if (settled.outcome === "sent") {
    try {
      await deps.transports.afterSent(p, settled.provider_proof ?? {}, {
        approval_id: record.approval_id,
        approved_by_email: record.approved_by_email,
      });
    } catch { /* desk logs never change a confirmed send */ }
    return {
      status: "sent",
      approval_id: record.approval_id,
      binding_hash: record.binding_hash,
      replayed: false,
      provider: settled.provider,
      provider_message_id: settled.provider_message_id,
      provider_proof: settled.provider_proof,
    };
  }
  return {
    status: settled.outcome,
    reason: settled.reason ?? settled.outcome,
    approval_id: record.approval_id,
    binding_hash: record.binding_hash,
  };
}

type Settled = {
  outcome: "sent" | "failed" | "unknown";
  reason: string | null;
  provider: "ghl" | "outlook";
  provider_message_id: string | null;
  provider_proof: Obj | null;
};

/** The only provider call in this module. Settles the claimed row once. */
async function sendOnce(
  deps: DebtFollowupDeps,
  record: ApprovalRecord,
  p: DebtFollowupProposal,
  token: string,
): Promise<Settled> {
  let settled: Settled;
  if (p.destination.channel === "sms") {
    const dest = p.destination;
    try {
      const res = await deps.transports.sendSms({
        contactId: dest.ghl_contact_id,
        message: p.body,
        ...(p.job_id ? { jobId: p.job_id } : {}),
      });
      const messageId =
        typeof res.body?.messageId === "string" && res.body.messageId
          ? res.body.messageId
          : null;
      if (
        res.status >= 200 && res.status < 300 && res.body?.success === true &&
        messageId
      ) {
        settled = {
          outcome: "sent",
          reason: null,
          provider: "ghl",
          provider_message_id: messageId,
          provider_proof: {
            provider: "ghl",
            message_id: messageId,
            evidence: res.body?.evidence ?? null,
            from_number: dest.from_number,
            to_contact_id: dest.ghl_contact_id,
            body_sha256: p.body_sha256,
          },
        };
      } else if (res.status >= 400 && res.status < 500) {
        // The proxy refused before calling GHL (validation, mismatch, dedup).
        settled = {
          outcome: "failed",
          reason: `provider_refused_${res.status}`,
          provider: "ghl",
          provider_message_id: null,
          provider_proof: null,
        };
      } else {
        settled = {
          outcome: "unknown",
          reason: "provider_outcome_unknown",
          provider: "ghl",
          provider_message_id: null,
          provider_proof: null,
        };
      }
    } catch {
      settled = {
        outcome: "unknown",
        reason: "provider_outcome_unknown",
        provider: "ghl",
        provider_message_id: null,
        provider_proof: null,
      };
    }
  } else {
    const dest = p.destination;
    const attachment = p.email!.attachment;
    try {
      const res = await deps.transports.sendInvoiceEmail({
        xero_invoice_id: attachment.xero_invoice_id,
        to_email: dest.to,
        cc: dest.cc,
        subject_override: p.email!.subject,
        job_id: p.job_id,
        approval_id: record.approval_id,
      });
      if (
        res.status >= 200 && res.status < 300 && res.body?.success === true &&
        res.body?.emailed === true
      ) {
        const responseProof = res.body?.provider_proof &&
            typeof res.body.provider_proof === "object"
          ? res.body.provider_proof as Obj
          : {};
        settled = {
          outcome: "sent",
          reason: null,
          provider: "outlook",
          provider_message_id: null,
          provider_proof: {
            provider: "outlook",
            label: "accepted by Outlook",
            accepted: true,
            status: responseProof.status ?? res.status,
            request_id: responseProof.request_id ?? null,
            client_request_id: responseProof.client_request_id ?? null,
            sent_at: responseProof.sent_at ?? null,
            approval_id: record.approval_id,
            via: res.body?.via ?? "outlook",
            to: dest.to,
            cc: dest.cc,
            subject: p.email!.subject,
            invoice_number: attachment.invoice_number,
            attachment_sha256: responseProof.attachment_sha256 ??
              res.body?.attachment_sha256 ?? null,
            body_sha256: p.body_sha256,
            timeline_write_failed: res.body?.timeline_write_failed === true,
          },
        };
      } else if (
        res.status >= 400 && res.status < 500 &&
        typeof res.body?.code === "string"
      ) {
        // The transport's own recipient/fence checks refused before Outlook.
        settled = {
          outcome: "failed",
          reason: res.body.code,
          provider: "outlook",
          provider_message_id: null,
          provider_proof: null,
        };
      } else {
        settled = {
          outcome: "unknown",
          reason: "provider_outcome_unknown",
          provider: "outlook",
          provider_message_id: null,
          provider_proof: null,
        };
      }
    } catch {
      settled = {
        outcome: "unknown",
        reason: "provider_outcome_unknown",
        provider: "outlook",
        provider_message_id: null,
        provider_proof: null,
      };
    }
  }
  try {
    await deps.ledger.settleLive(record.approval_id, token, settled);
  } catch {
    // The row stays `sending`, which already blocks any second press.
  }
  return settled;
}

/** Old send actions. With an approval_id they press it; without one they record
 * a dry-run preview of what they would have sent and send nothing. */
export async function debtFollowupLegacySend(args: {
  sourceAction: string;
  kind: DebtFollowupKind;
  method: string;
  auth: DebtFollowupAuth;
  /** The request the old body describes (used only for the preview). */
  request: Obj;
  /** The raw old body (approval_id, dry_run and any restated coordinates). */
  body: Obj;
  deps: DebtFollowupDeps;
}): Promise<DebtFollowupResult> {
  const { deps } = args;
  if (args.body?.approval_id !== undefined && args.body?.approval_id !== null) {
    return await debtFollowupExecuteAction({
      method: "POST",
      auth: args.auth,
      body: args.body,
      deps,
      expectKind: args.kind,
      legacyBody: args.body,
      sourceAction: args.sourceAction,
    });
  }
  const switchOn = debtFollowupExecuteSwitchOn(envOf(deps));
  const channel = SMS_KINDS.has(args.kind) ? "sms" : "email";
  const press = pressedBy(args.auth);
  const norm = normaliseDebtFollowupRequest({
    ...args.request,
    kind: args.kind,
  });
  if (!norm.ok) {
    const recorded = await recordAttempt(deps, {
      approval_id: null,
      binding_hash: null,
      kind: args.kind,
      channel,
      outcome: "refused",
      reason: norm.reason,
      pressed_by: press,
      source_action: args.sourceAction,
      proposal: null,
    });
    return { status: "refused", reason: norm.reason, recorded };
  }
  const now = (deps.now ?? (() => new Date()))();
  const built = await buildDebtFollowupProposal(norm.request, deps.reads, {
    orgId: deps.orgId,
    now,
  });
  if (!built.ok) {
    const recorded = await recordAttempt(deps, {
      approval_id: null,
      binding_hash: null,
      kind: args.kind,
      channel,
      outcome: "refused",
      reason: built.reason,
      pressed_by: press,
      source_action: args.sourceAction,
      proposal: null,
    });
    return {
      status: "refused",
      reason: built.reason,
      ...(built.detail ? { detail: built.detail } : {}),
      recorded,
    };
  }
  const recorded = await recordAttempt(deps, {
    approval_id: null,
    binding_hash: built.binding_hash,
    kind: args.kind,
    channel,
    outcome: "dry_run",
    reason: "approval_required",
    pressed_by: press,
    source_action: args.sourceAction,
    proposal: built.proposal,
  });
  return {
    status: "dry_run",
    reason: "approval_required",
    approval_id: null,
    binding_hash: built.binding_hash,
    would_send: built.proposal,
    execute_switch: switchOn ? "on" : "off",
    recorded,
  };
}

// ── Who may use the three debt follow-up actions ───────────────────────────

/** The caller as the ops-api front door resolved it. */
export interface DebtFollowupCaller {
  /** ops-api auth mode: api_key, jwt, routine, agent_read, none. */
  mode: string;
  /** A signed-in session with the ONE staff-operator role set. */
  staff_role: boolean;
  /** The server-owned profile org of a signed-in caller. */
  org_id: string | null;
  /** The privileged ops key (a server-only credential), never the shared browser key. */
  server_secret: boolean;
}

/** Captain's standing ruling: one staff access level, signed-in office staff of
 * the SecureWorks org (identity recorded, not restricted), or the privileged
 * ops key. Everyone else is a 403 before any dependency is built. */
export function debtFollowupCallerRefusal(
  caller: DebtFollowupCaller,
  orgId: string,
): { code: string; error: string } | null {
  if (caller.mode === "api_key" && caller.server_secret) return null;
  if (caller.mode === "jwt" && caller.staff_role) {
    if (caller.org_id && caller.org_id === orgId) return null;
    return {
      code: "operator_org_required",
      error: "Debt follow-up is limited to SecureWorks office staff.",
    };
  }
  return {
    code: "operator_access_required",
    error:
      "Debt follow-up requires a signed-in SecureWorks staff session or the privileged ops key.",
  };
}

export type DebtFollowupAction =
  | "debt_followup_propose"
  | "debt_followup_approve"
  | "debt_followup_execute";

/** The one door for the three actions: the caller gate runs first, and the
 * dependencies (every read and the ledger) are built only for an allowed caller. */
export async function debtFollowupActionEntry(input: {
  action: DebtFollowupAction;
  caller: DebtFollowupCaller;
  orgId: string;
  method: string;
  auth: DebtFollowupAuth;
  body: Obj;
  makeDeps: () => DebtFollowupDeps;
}): Promise<{ status: number; body: Obj }> {
  const refusal = debtFollowupCallerRefusal(input.caller, input.orgId);
  if (refusal) {
    return {
      status: 403,
      body: {
        status: "refused",
        reason: refusal.code,
        code: refusal.code,
        error: refusal.error,
      },
    };
  }
  const args = {
    method: input.method,
    auth: input.auth,
    body: input.body,
    deps: input.makeDeps(),
  };
  const result = input.action === "debt_followup_propose"
    ? await debtFollowupProposeAction(args)
    : input.action === "debt_followup_approve"
    ? await debtFollowupApproveAction(args)
    : await debtFollowupExecuteAction(args);
  const captainOnly = result.status === "refused" &&
    result.reason === "approval_requires_captain";
  return { status: captainOnly ? 403 : 200, body: result as Obj };
}

// ── Invoice email evidence (through capture_business_event) ────────────────

/** One approval sends at most once, so the approval id is a stable evidence key. */
export function debtInvoiceEmailProviderMessageId(approvalId: string): string {
  return `outlook-accepted:${approvalId}`;
}

/** The capture_business_event row for one approved, Outlook-accepted invoice
 * email. Keyed on the approval; the writer owns the event time and attribution
 * (no occurred_at, event_at, match_status or attribution field is supplied). */
export function debtInvoiceEmailEvidenceRow(input: {
  approval_id: string;
  xero_invoice_id: string;
  job_id: string;
  invoice_number: string;
  to: string;
  cc: string[];
  subject: string;
  body: string;
  attachment_file_name: string;
  body_preview: string;
  provider_proof: Obj;
  source: string;
}): Obj {
  return {
    event_type: "invoice.emailed",
    source: input.source,
    entity_type: "xero_invoice",
    entity_id: input.xero_invoice_id,
    job_id: input.job_id,
    match_method: "direct_job_id",
    provider_message_id: debtInvoiceEmailProviderMessageId(input.approval_id),
    channel: "email",
    direction: "outbound",
    body_preview: input.body_preview,
    safe_summary: input.body_preview,
    privacy_classification: "staff_only",
    retention_class: "7y_audit",
    payload: {
      invoice_number: input.invoice_number,
      to: input.to,
      cc: input.cc,
      via: "outlook",
      linked: true,
      subject: input.subject,
      // Not under `body`: context_event_text reads payload.body first, and the
      // invoice number in this HTML would feed the ladder's number match (K3).
      email_body_html: input.body,
      attachment_file_name: input.attachment_file_name,
      provider_proof: input.provider_proof,
      debt_followup_approval_id: input.approval_id,
      attachment_sha256: input.provider_proof.attachment_sha256 ?? null,
    },
    metadata: { capture_mode: "live" },
  };
}

/** Old callers read `success`; only a confirmed send is a success. */
export function legacySendResponse(
  result: DebtFollowupResult,
): { status: number; body: Obj } {
  if (result.status === "sent") {
    return {
      status: 200,
      body: {
        success: true,
        sent: true,
        replayed: result.replayed,
        approval_id: result.approval_id,
        message_id: result.provider_message_id,
        provider_proof: result.provider_proof,
      },
    };
  }
  const reason = "reason" in result ? result.reason : result.status;
  return {
    status: 409,
    body: {
      success: false,
      sent: false,
      error: result.status === "dry_run"
        ? `Not sent: ${reason}. Debtor texts and emails need the captain's approval of the exact message (debt_followup_approve), and sends stay off until the execute switch is turned on.`
        : `Not sent: ${reason}.`,
      code: `debt_followup_${result.status}`,
      debt_followup: result,
    },
  };
}

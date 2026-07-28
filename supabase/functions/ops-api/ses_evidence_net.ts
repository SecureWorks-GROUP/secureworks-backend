import {
  canonicalExternalObligationRef,
  canonicalObligationPoCore,
} from "../_shared/makesafe_refs.ts";
import type {
  SesOperationalEvidence,
  SesOperationalEvidenceFact,
} from "./ses_docket_envelope.ts";

// Pure U4 evidence classification over rows loaded by the adapter. Cross-store
// joins accept only canonical WO/PO/card keys; address is intentionally absent.
type EvidenceRow = Record<string, unknown>;

// The audit's replay ghosts were one to eight weeks old, while sub-week work
// orders were still ordinary live obligations. Keep that boundary explicit.
export const SES_REPLAY_AGE_THRESHOLD_HOURS = 7 * 24;

export interface SesEvidenceReferenceKey {
  kind: "builder_reference" | "po";
  normalized: string;
  display: string;
  match_tokens: string[];
}

export interface SesEvidenceNetRows {
  job: EvidenceRow;
  source: {
    builder_reference: string;
    po_or_external_ref: string | null;
  };
  emails: EvidenceRow[];
  email_attachments: EvidenceRow[];
  xero_invoices: EvidenceRow[];
  trade_invoice_lines: EvidenceRow[];
  twin_details: EvidenceRow[];
  twin_jobs: EvidenceRow[];
  replay_age_threshold_hours?: number;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): EvidenceRow {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as EvidenceRow
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const candidate = text(value);
    if (candidate) return candidate;
  }
  return "";
}

export function normalizeSesEvidenceReference(value: unknown): string {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function referenceKey(
  kind: SesEvidenceReferenceKey["kind"],
  display: string,
  normalized: string,
  aliases: string[] = [],
): SesEvidenceReferenceKey {
  return {
    kind,
    normalized,
    display,
    match_tokens: unique([normalized, ...aliases]),
  };
}

export function buildSesEvidenceReferenceKeys(args: {
  builder_reference: string;
  po_or_external_ref: string | null;
}): SesEvidenceReferenceKey[] {
  const keys: SesEvidenceReferenceKey[] = [];
  const canonicalBuilder = canonicalExternalObligationRef(
    args.builder_reference,
  );
  const builderNormalized = normalizeSesEvidenceReference(
    canonicalBuilder || args.builder_reference,
  );
  if (builderNormalized) {
    const digits = builderNormalized.match(/\d{3,}$/)?.[0] || "";
    const aliases = /^(?:AJ|AJBR)\d+$/.test(builderNormalized) && digits
      ? [`JOBNO${digits}`]
      : /^\d{5,}$/.test(builderNormalized)
      ? [`JOBNO${builderNormalized}`]
      : [];
    keys.push(
      referenceKey(
        "builder_reference",
        canonicalBuilder || args.builder_reference,
        builderNormalized,
        aliases,
      ),
    );
  }

  const rawPo = text(args.po_or_external_ref);
  const labelledPo = canonicalObligationPoCore(rawPo, true);
  const barePo = rawPo && normalizeSesEvidenceReference(rawPo) !==
      builderNormalized
    ? canonicalObligationPoCore(rawPo)
    : null;
  const po = labelledPo || barePo;
  if (po) {
    keys.push(
      referenceKey("po", `PO-${po}`, `PO${po}`, [`PURCHASEORDER${po}`]),
    );
  }
  return keys.filter((key, index, rows) =>
    rows.findIndex((candidate) =>
      candidate.kind === key.kind &&
      candidate.normalized === key.normalized
    ) === index
  );
}

export function sesEvidenceSearchAnchors(
  keys: SesEvidenceReferenceKey[],
): string[] {
  const digitAnchors = keys.flatMap((key) =>
    key.match_tokens.flatMap((token) => token.match(/\d{4,}/g) || [])
  );
  if (digitAnchors.length) return unique(digitAnchors);
  return unique(
    keys.flatMap((key) => key.match_tokens)
      .filter((token) => token.length >= 6),
  );
}

function attachmentsByEmail(rows: EvidenceRow[]): Map<string, EvidenceRow[]> {
  const byEmail = new Map<string, EvidenceRow[]>();
  for (const row of rows) {
    const emailId = text(row.email_id);
    if (!emailId) continue;
    byEmail.set(emailId, [...(byEmail.get(emailId) || []), row]);
  }
  return byEmail;
}

function emailSearchText(
  row: EvidenceRow,
  attachments: EvidenceRow[],
): string {
  return [
    row.subject,
    row.body_preview,
    row.body_content,
    ...attachments.map((item) => item.name),
  ].map((value) => text(value)).filter(Boolean).join(" ");
}

function normalizedTextContainsToken(haystack: string, token: string): boolean {
  const normalized = normalizeSesEvidenceReference(haystack);
  let offset = normalized.indexOf(token);
  while (offset >= 0) {
    const next = normalized[offset + token.length] || "";
    if (!/\d/.test(next)) return true;
    offset = normalized.indexOf(token, offset + 1);
  }
  return false;
}

export function matchedSesEvidenceReferenceKey(
  row: EvidenceRow,
  attachments: EvidenceRow[],
  keys: SesEvidenceReferenceKey[],
): SesEvidenceReferenceKey | null {
  const haystack = emailSearchText(row, attachments);
  for (const key of keys) {
    if (
      key.match_tokens.some((token) =>
        normalizedTextContainsToken(haystack, token)
      )
    ) {
      return key;
    }
  }
  return null;
}

function ownDomain(value: unknown): boolean {
  return /(?:^|[<\s])[^<\s@]+@secureworkswa\.com\.au(?:>|$)/i.test(
    text(value),
  );
}

function externalRecipients(value: unknown): string[] {
  const source = typeof value === "string"
    ? value
    : JSON.stringify(value ?? "");
  return unique(
    (source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])
      .map((address) => address.toLowerCase())
      .filter((address) => !address.endsWith("@secureworkswa.com.au")),
  );
}

function qaEvidence(...values: unknown[]): boolean {
  const haystack = values.map((value) =>
    typeof value === "string" ? value : JSON.stringify(value ?? "")
  ).join(" ");
  return /\bQA\s+TEST\b|\bmarnin\s+test\d*\b/i.test(haystack);
}

function qaEmail(row: EvidenceRow, attachments: EvidenceRow[]): boolean {
  return qaEvidence(
    row.from_name,
    row.from_email,
    row.subject,
    row.body_content,
    attachments.map((item) => item.name),
  );
}

function deliveryKinds(
  row: EvidenceRow,
  attachments: EvidenceRow[],
): string[] {
  const haystack = emailSearchText(row, attachments);
  const kinds: string[] = [];
  if (/\b(?:make[\s-]*safe|roof|assessment)?\s*report\b/i.test(haystack)) {
    kinds.push("report");
  }
  if (/\b(?:xero\s+)?invoice\b|\bINV-?\d{3,}\b/i.test(haystack)) {
    kinds.push("invoice");
  }
  if (/\bphoto(?:s|\s+evidence|\s+schedule)?\b/i.test(haystack)) {
    kinds.push("photos");
  }
  if (/\bSWMS\b/i.test(haystack)) kinds.push("swms");
  return unique(kinds);
}

function stableFact(
  fact: SesOperationalEvidenceFact,
): SesOperationalEvidenceFact {
  return fact;
}

function outboundDeliveryFacts(
  rows: SesEvidenceNetRows,
  keys: SesEvidenceReferenceKey[],
): SesOperationalEvidenceFact[] {
  const byEmail = attachmentsByEmail(rows.email_attachments);
  const facts: SesOperationalEvidenceFact[] = [];
  for (const row of rows.emails) {
    const postId = text(row.post_id);
    if (!postId) continue;
    const attachments = byEmail.get(postId) || [];
    if (!ownDomain(row.from_email) || qaEmail(row, attachments)) continue;
    const key = matchedSesEvidenceReferenceKey(row, attachments, keys);
    if (!key) continue;
    const kinds = deliveryKinds(row, attachments);
    if (!kinds.includes("report") || !kinds.includes("invoice")) continue;
    if (row.has_attachments !== true && !attachments.length) continue;
    const deliveredTo = externalRecipients(row.to_recipients);
    if (!deliveredTo.length) continue;
    facts.push(stableFact({
      id: `emails:${postId}:outbound_delivery:${key.normalized}`,
      kind: "outbound_delivery",
      occurred_at: text(row.received_at) || null,
      summary: `SecureWorks outbound mail records delivered ${
        kinds.join(", ")
      } evidence.`,
      provenance: {
        store: "emails",
        row_id: postId,
        matched_key: `${key.kind}:${key.normalized}`,
      },
      details: {
        subject: text(row.subject) || null,
        from_email: text(row.from_email) || null,
        delivered_to: deliveredTo,
        delivered_kinds: kinds,
        attachment_row_ids: attachments.map((item) => text(item.id)).filter(
          Boolean,
        ).sort(),
        conversation_id: text(row.conversation_id) || null,
        thread_id: text(row.thread_id) || null,
      },
    }));
  }
  return facts;
}

function threadCoordinates(row: EvidenceRow): string[] {
  return [
    text(row.conversation_id)
      ? `conversation_id:${text(row.conversation_id)}`
      : "",
    text(row.thread_id) ? `thread_id:${text(row.thread_id)}` : "",
  ].filter(Boolean);
}

function threadEvidenceKind(
  row: EvidenceRow,
):
  | "builder_cancellation"
  | "work_handed_back"
  | "booked_forward"
  | null {
  const haystack = [row.subject, row.body_preview, row.body_content]
    .map((value) => text(value))
    .join(" ")
    .replace(/\s+/g, " ");
  if (
    /\bCANCELLED?\s+WORK\s+ORDER\b/i.test(haystack) ||
    /\bplease\s+cancel(?:\s+(?:your|the))?\s+(?:WO|work\s+order)\b/i.test(
      haystack,
    ) ||
    /\bplease\s+disregard(?:\s+(?:this|the))?\s+job\b/i.test(haystack) ||
    /\b(?:insured|client)\b[^.]{0,80}\bno\s+longer\s+wants?\b/i.test(
      haystack,
    ) ||
    /\bclient\b[^.]{0,80}\brequested\s+not\s+to\s+have\b/i.test(haystack)
  ) {
    return "builder_cancellation";
  }
  if (
    !/\b(?:can'?t|cannot)\s+keep\s+taking\s+work\s+back\b/i.test(haystack) &&
    (
      (ownDomain(row.from_email) &&
        /\btoo\s+far\s+for\s+us\b/i.test(haystack)) ||
      /\btoo\s+far\b[^.]{0,100}\btake\b[^.]{0,30}\bback\b/i.test(haystack) ||
      /\bplease\b[^.]{0,50}\btake\b[^.]{0,30}\bback\b/i.test(haystack) ||
      /\bhanded?\s+back\b/i.test(haystack) ||
      /\breallocated\b/i.test(haystack)
    )
  ) {
    return "work_handed_back";
  }
  if (
    /\bput\s+it\s+in\s+for\s+\d{1,2}\s+[A-Za-z]{3,9}\b/i.test(haystack) ||
    /\b(?:report|work|visit)\s+scheduled\s+for\s+(?:today|tomorrow|\d{1,2}\s+[A-Za-z]{3,9})\b/i
      .test(haystack) ||
    /\borganised?\s+(?:to|at)\s+attend\s+(?:today|tomorrow|\d{1,2}\s+[A-Za-z]{3,9})\b/i
      .test(haystack) ||
    /\bcontacted\s+the\s+insured\b[^.]{0,120}\bdate\b/i.test(haystack)
  ) {
    return "booked_forward";
  }
  return null;
}

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

function bookedFor(row: EvidenceRow): string | null {
  const body = [row.subject, row.body_preview, row.body_content]
    .map((value) => text(value)).join(" ");
  const received = new Date(text(row.received_at));
  if (!Number.isFinite(received.getTime())) return null;
  const lower = body.toLowerCase();
  if (/\btomorrow\b/.test(lower)) {
    received.setUTCDate(received.getUTCDate() + 1);
    return received.toISOString().slice(0, 10);
  }
  if (/\btoday\b/.test(lower)) return received.toISOString().slice(0, 10);
  const match = lower.match(
    /\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/,
  );
  if (!match) return null;
  const month = MONTHS[match[2]];
  if (month === undefined) return null;
  const candidate = new Date(Date.UTC(
    received.getUTCFullYear(),
    month,
    Number(match[1]),
  ));
  if (candidate.getTime() < received.getTime() - 30 * 86_400_000) {
    candidate.setUTCFullYear(candidate.getUTCFullYear() + 1);
  }
  return candidate.toISOString().slice(0, 10);
}

function wholeThreadFacts(
  rows: SesEvidenceNetRows,
  keys: SesEvidenceReferenceKey[],
): SesOperationalEvidenceFact[] {
  const byEmail = attachmentsByEmail(rows.email_attachments);
  const seedKeyByCoordinate = new Map<string, SesEvidenceReferenceKey>();
  for (const row of rows.emails) {
    const rowAttachments = byEmail.get(text(row.post_id)) || [];
    if (qaEmail(row, rowAttachments)) continue;
    const key = matchedSesEvidenceReferenceKey(
      row,
      rowAttachments,
      keys,
    );
    if (!key) continue;
    for (const coordinate of threadCoordinates(row)) {
      if (!seedKeyByCoordinate.has(coordinate)) {
        seedKeyByCoordinate.set(coordinate, key);
      }
    }
  }

  const facts: SesOperationalEvidenceFact[] = [];
  for (const row of rows.emails) {
    if (qaEmail(row, byEmail.get(text(row.post_id)) || [])) continue;
    const binding = threadCoordinates(row)
      .map((coordinate) => ({
        coordinate,
        key: seedKeyByCoordinate.get(coordinate),
      }))
      .find((item) => item.key);
    if (!binding?.key) continue;
    const kind = threadEvidenceKind(row);
    if (!kind) continue;
    const postId = text(row.post_id);
    if (!postId) continue;
    facts.push(stableFact({
      id: `emails:${postId}:${kind}`,
      kind,
      occurred_at: text(row.received_at) || null,
      summary: kind === "builder_cancellation"
        ? "The matched mail thread records a builder cancellation."
        : kind === "work_handed_back"
        ? "The matched mail thread records a handback or reallocation."
        : "The matched mail thread records a forward booking.",
      provenance: {
        store: "emails",
        row_id: postId,
        matched_key:
          `${binding.key.kind}:${binding.key.normalized}/${binding.coordinate}`,
      },
      details: {
        binding_reference: `${binding.key.kind}:${binding.key.normalized}`,
        subject: text(row.subject) || null,
        from_email: text(row.from_email) || null,
        booked_for: kind === "booked_forward" ? bookedFor(row) : null,
      },
    }));
  }
  return facts;
}

function jobNumberMatcher(jobNumber: string): RegExp | null {
  const normalized = normalizeSesEvidenceReference(jobNumber);
  const match = normalized.match(/^SWMS(\d+)$/);
  if (!match) return null;
  return new RegExp(`(?:^|[^A-Z0-9])SWMS[\\s-]*${match[1]}(?:[^0-9]|$)`, "i");
}

function xeroLineItems(row: EvidenceRow): EvidenceRow[] {
  return array(row.line_items).map(record);
}

function xeroLineDescription(row: EvidenceRow): string {
  return firstText(
    row.Description,
    row.description,
    row.ItemDescription,
    row.item_description,
  );
}

function crewBillFacts(rows: SesEvidenceNetRows): SesOperationalEvidenceFact[] {
  const jobNumber = text(rows.job.job_number);
  const matcher = jobNumberMatcher(jobNumber);
  if (!matcher) return [];
  const facts: SesOperationalEvidenceFact[] = [];
  for (const invoice of rows.xero_invoices) {
    if (
      text(invoice.invoice_type).toUpperCase() !== "ACCPAY" ||
      text(invoice.status).toUpperCase() !== "PAID" ||
      qaEvidence(invoice.contact_name)
    ) {
      continue;
    }
    const invoiceId = text(invoice.id);
    if (!invoiceId) continue;
    for (const [index, item] of xeroLineItems(invoice).entries()) {
      const description = xeroLineDescription(item);
      if (!matcher.test(description) || qaEvidence(description)) continue;
      const lineId = firstText(
        item.LineItemID,
        item.LineItemId,
        item.line_item_id,
        String(index),
      );
      facts.push(stableFact({
        id: `xero_invoices:${invoiceId}:line:${lineId}`,
        kind: "crew_bill_attendance",
        occurred_at: firstText(
          invoice.fully_paid_on,
          invoice.invoice_date,
        ) || null,
        summary: "A paid subcontractor bill names this card exactly.",
        provenance: {
          store: "xero_invoices",
          row_id: invoiceId,
          matched_key: `job_number:${normalizeSesEvidenceReference(jobNumber)}`,
        },
        details: {
          invoice_number: text(invoice.invoice_number) || null,
          contact_name: text(invoice.contact_name) || null,
          payment_status: "PAID",
          line_item_id: lineId,
        },
      }));
    }
  }

  for (const line of rows.trade_invoice_lines) {
    if (
      normalizeSesEvidenceReference(line.job_number) !==
        normalizeSesEvidenceReference(jobNumber)
    ) {
      continue;
    }
    const invoice = record(line.trade_invoices);
    const user = record(invoice.users);
    if (
      qaEvidence(
        line.description,
        line.client_name,
        user.name,
        invoice.notes,
      )
    ) {
      continue;
    }
    const status = text(invoice.status).toLowerCase();
    if (!["paid", "pushed_to_xero"].includes(status)) continue;
    const lineId = text(line.id);
    if (!lineId) continue;
    facts.push(stableFact({
      id: `trade_invoice_lines:${lineId}`,
      kind: status === "paid" ? "crew_bill_attendance" : "crew_bill_claim",
      occurred_at: firstText(
        invoice.xero_pushed_at,
        invoice.submitted_at,
        invoice.week_end,
        line.created_at,
      ) || null,
      summary: status === "paid"
        ? "A paid relational subcontractor bill names this card exactly."
        : "A submitted subcontractor bill names this card exactly.",
      provenance: {
        store: "trade_invoice_lines",
        row_id: lineId,
        matched_key: `job_number:${normalizeSesEvidenceReference(jobNumber)}`,
      },
      details: {
        trade_invoice_id: text(line.trade_invoice_id) ||
          text(invoice.id) || null,
        trade_name: text(user.name) || null,
        settlement_status: status,
        total_hours: typeof line.total_hours === "number"
          ? line.total_hours
          : null,
      },
    }));
  }
  return facts;
}

function workOrderSourceEmail(
  rows: SesEvidenceNetRows,
  keys: SesEvidenceReferenceKey[],
): EvidenceRow | null {
  const byEmail = attachmentsByEmail(rows.email_attachments);
  const matches = rows.emails.filter((row) => {
    if (ownDomain(row.from_email)) return false;
    const attachments = byEmail.get(text(row.post_id)) || [];
    if (qaEmail(row, attachments)) return false;
    if (!matchedSesEvidenceReferenceKey(row, attachments, keys)) return false;
    const haystack = emailSearchText(row, attachments);
    return /\bNEW\s+WORK\s+ORDER\b|\bWORK\s+ORDER\b|\bJOB\s+NO\b|work_order_/i
      .test(haystack);
  }).sort((left, right) =>
    text(left.received_at).localeCompare(text(right.received_at))
  );
  return matches[0] || null;
}

function closedTwin(
  job: EvidenceRow,
  detail: EvidenceRow,
): boolean {
  return !!text(detail.cancelled_at) ||
    [
      "archived",
      "cancelled",
      "canceled",
      "closed",
      "complete",
      "completed",
      "paid",
      "invoiced",
    ].includes(text(job.status).toLowerCase());
}

function duplicateOfClosedFacts(
  rows: SesEvidenceNetRows,
  keys: SesEvidenceReferenceKey[],
): SesOperationalEvidenceFact[] {
  const currentCreatedAt = new Date(text(rows.job.created_at));
  const sourceEmail = workOrderSourceEmail(rows, keys);
  const sourceReceivedAt = new Date(text(sourceEmail?.received_at));
  if (
    !sourceEmail ||
    !Number.isFinite(currentCreatedAt.getTime()) ||
    !Number.isFinite(sourceReceivedAt.getTime())
  ) {
    return [];
  }
  const replayAgeHours =
    (currentCreatedAt.getTime() - sourceReceivedAt.getTime()) / 3_600_000;
  const threshold = rows.replay_age_threshold_hours ??
    SES_REPLAY_AGE_THRESHOLD_HOURS;
  if (replayAgeHours < threshold) return [];

  const currentReference = canonicalExternalObligationRef(
    rows.source.builder_reference,
  );
  const currentReferenceNormalized = normalizeSesEvidenceReference(
    currentReference,
  );
  const currentPo = keys.find((key) => key.kind === "po")?.normalized || null;
  if (!currentReferenceNormalized) return [];
  const jobsById = new Map(
    rows.twin_jobs.map((job) => [text(job.id), job]),
  );
  const facts: SesOperationalEvidenceFact[] = [];
  for (const detail of rows.twin_details) {
    const twinJobId = text(detail.job_id);
    const twinJob = jobsById.get(twinJobId);
    if (!twinJob || twinJobId === text(rows.job.id)) continue;
    if (qaEvidence(twinJob.client_name, twinJob.job_number)) continue;
    const metadata = record(twinJob.metadata);
    const candidateReference = canonicalExternalObligationRef(firstText(
      detail.external_ref,
      metadata.external_ref,
      metadata.builder_work_order_number,
    ));
    if (
      normalizeSesEvidenceReference(candidateReference) !==
        currentReferenceNormalized
    ) {
      continue;
    }
    const candidatePo = canonicalObligationPoCore(
      metadata.builder_po_number,
    ) ||
      canonicalObligationPoCore(
        metadata.builder_work_order_number,
        true,
      ) ||
      canonicalObligationPoCore(detail.external_ref, true);
    if (
      currentPo &&
      `PO${candidatePo || ""}` !== currentPo
    ) {
      continue;
    }
    if (!closedTwin(twinJob, detail)) continue;
    const twinJobNumber = text(twinJob.job_number);
    facts.push(stableFact({
      id: `jobs:${twinJobId}:duplicate_of_closed`,
      kind: "duplicate_of_closed",
      occurred_at: firstText(
        detail.cancelled_at,
        twinJob.updated_at,
        twinJob.created_at,
      ) || null,
      summary:
        `Replay-aged work order is already represented by closed card ${twinJobNumber}.`,
      provenance: {
        store: "jobs",
        row_id: twinJobId,
        matched_key: currentPo
          ? `builder_reference:${currentReferenceNormalized}/po:${currentPo}`
          : `builder_reference:${currentReferenceNormalized}`,
      },
      details: {
        duplicate_of_job_id: twinJobId,
        duplicate_of_job_number: twinJobNumber || null,
        duplicate_status: text(twinJob.status) || null,
        cancelled_at: text(detail.cancelled_at) || null,
        source_email_post_id: text(sourceEmail.post_id),
        source_email_received_at: text(sourceEmail.received_at),
        current_card_created_at: text(rows.job.created_at),
        replay_age_hours: Math.floor(replayAgeHours),
        replay_age_threshold_hours: threshold,
      },
    }));
  }
  return facts;
}

export function classifySesOperationalEvidence(
  facts: SesOperationalEvidenceFact[],
): SesOperationalEvidence["triage"] {
  const sortedIds = facts.map((fact) => fact.id).sort();
  const has = (...kinds: SesOperationalEvidenceFact["kind"][]) =>
    facts.some((fact) => kinds.includes(fact.kind));
  if (has("builder_cancellation", "work_handed_back")) {
    return {
      disposition: "cancelled_or_handed_back",
      reason_code: "thread_cancellation_or_handback_evidence",
      staff_action_allowed: false,
      consulted_fact_ids: sortedIds,
    };
  }
  if (has("duplicate_of_closed")) {
    return {
      disposition: "duplicate_of_closed",
      reason_code: "replay_age_closed_twin_evidence",
      staff_action_allowed: false,
      consulted_fact_ids: sortedIds,
    };
  }
  if (has("outbound_delivery")) {
    return {
      disposition: "already_delivered",
      reason_code: "outbound_delivery_evidence",
      staff_action_allowed: false,
      consulted_fact_ids: sortedIds,
    };
  }
  if (has("crew_bill_attendance", "crew_bill_claim")) {
    return {
      disposition: "attendance_evidenced",
      reason_code: "subcontractor_bill_evidence",
      staff_action_allowed: false,
      consulted_fact_ids: sortedIds,
    };
  }
  if (has("booked_forward")) {
    return {
      disposition: "booked_forward",
      reason_code: "thread_forward_booking_evidence",
      staff_action_allowed: false,
      consulted_fact_ids: sortedIds,
    };
  }
  return {
    disposition: "evidence_inconclusive",
    reason_code: "positive_staff_action_evidence_missing",
    staff_action_allowed: false,
    consulted_fact_ids: sortedIds,
  };
}

export function resolveSesOperationalEvidence(
  rows: SesEvidenceNetRows,
): SesOperationalEvidence {
  const keys = buildSesEvidenceReferenceKeys(rows.source);
  const facts = [
    ...outboundDeliveryFacts(rows, keys),
    ...wholeThreadFacts(rows, keys),
    ...crewBillFacts(rows),
    ...duplicateOfClosedFacts(rows, keys),
  ]
    .filter((fact, index, all) =>
      all.findIndex((candidate) => candidate.id === fact.id) === index
    )
    .sort((left, right) =>
      (left.occurred_at || "").localeCompare(right.occurred_at || "") ||
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id)
    );
  return {
    facts,
    triage: classifySesOperationalEvidence(facts),
  };
}

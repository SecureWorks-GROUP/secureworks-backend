// Ticket P3-02.3: propose supplier credits from stored email PDF attachments
// and raise each proposed credit once on the Reconcile list for a person.
//
// Runs only when feature_flags.supplier_credit_drafts_v1 is enabled.
// Never writes to Xero, never places a cost, never calls AI, and never throws.
// Error logs carry attachment ids and error codes only, never amounts or text.

import { readSwitch } from "../_shared/switch_cache.ts";
import { parseSupplierCredit } from "../_shared/supplier_credit_parse.ts";
import { extractPdfText } from "../ops-api/makesafe_pdf_text.ts";

export const SUPPLIER_CREDIT_DRAFTS_FLAG = "supplier_credit_drafts_v1";
export const SUPPLIER_CREDIT_WINDOW_DAYS = 14;
export const SUPPLIER_CREDIT_DEFAULT_LIMIT = 10;
export const CONTEXT_EMAIL_ATTACHMENTS_BUCKET = "context-email-attachments";

export interface ProposeSupplierCreditsOptions {
  limit?: number;
  now?: () => Date;
  extractText?: (bytes: Uint8Array) => Promise<string>;
}

export interface ProposeSupplierCreditsResult {
  read: number;
  proposed: number;
  duplicate: number;
  not_credit: number;
  error?: string;
}

interface CandidateAttachmentRow {
  id: string;
  file_name: string | null;
  content_type: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  status: string | null;
  created_at: string | null;
}

interface MatchedBillRow {
  xero_invoice_id: string | null;
  invoice_number: string | null;
  xero_contact_id: string | null;
  contact_name: string | null;
  job_id: string | null;
}

function errCode(err: unknown): string {
  // deno-lint-ignore no-explicit-any
  const e = err as any;
  const raw = String(e?.code || e?.statusCode || e?.name || "error");
  const clean = raw.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64);
  return clean || "error";
}

function safeStoragePath(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("..")) {
    return null;
  }
  return trimmed;
}

function nonEmptyTrimmed(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
}

function firstNonEmptyLine(text: string): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length > 0) return line;
  }
  return null;
}

function positiveMoney(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const rounded = Math.round(value * 100) / 100;
  return rounded > 0 ? rounded : null;
}

async function toBytes(payload: unknown): Promise<Uint8Array | null> {
  if (!payload) return null;
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  // deno-lint-ignore no-explicit-any
  const blobLike = payload as any;
  if (typeof blobLike.arrayBuffer === "function") {
    const ab = await blobLike.arrayBuffer();
    return new Uint8Array(ab);
  }
  return null;
}

async function defaultExtractPdfText(bytes: Uint8Array): Promise<string> {
  const res = await extractPdfText(bytes);
  return res.text || res.rawText || "";
}

export async function proposeSupplierCredits(
  // deno-lint-ignore no-explicit-any
  sb: any,
  orgId: string,
  opts: ProposeSupplierCreditsOptions = { limit: SUPPLIER_CREDIT_DEFAULT_LIMIT },
): Promise<ProposeSupplierCreditsResult> {
  const counts = { read: 0, proposed: 0, duplicate: 0, not_credit: 0 };
  let firstError: string | undefined;

  try {
    if (!nonEmptyTrimmed(orgId)) {
      return { ...counts, error: "org_id_required" };
    }
    if (!(await readSwitch(sb, SUPPLIER_CREDIT_DRAFTS_FLAG))) {
      return counts;
    }

    const rawLimit = opts?.limit ?? SUPPLIER_CREDIT_DEFAULT_LIMIT;
    if (!Number.isFinite(rawLimit) || rawLimit <= 0) {
      return counts;
    }
    const limit = Math.floor(rawLimit);

    const nowDate = (opts?.now ?? (() => new Date()))();
    const sinceIso = new Date(
      nowDate.getTime() - SUPPLIER_CREDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const skippedInRun = new Set<string>();
    const extractText = opts?.extractText ?? defaultExtractPdfText;

    const { data: candidateRows, error: candErr } = await sb.rpc(
      "supplier_credit_candidate_attachments",
      {
        p_org_id: orgId,
        p_since: sinceIso,
        p_limit: limit,
        p_exclude_ids: [],
      },
    );
    if (candErr || !Array.isArray(candidateRows)) {
      console.error(
        "[supplier_credit_propose] candidate read failed:",
        errCode(candErr),
      );
      return { ...counts, error: "candidate_read_failed" };
    }

    const candidates = (candidateRows as CandidateAttachmentRow[]).slice(
      0,
      limit,
    );

    for (const att of candidates) {
      const attId = nonEmptyTrimmed(att?.id);
      if (!attId || skippedInRun.has(attId)) continue;

      const bucket = nonEmptyTrimmed(att.storage_bucket);
      const path = safeStoragePath(att.storage_path);
      if (bucket !== CONTEXT_EMAIL_ATTACHMENTS_BUCKET || !path) {
        console.error(
          "[supplier_credit_propose] invalid storage location:",
          attId,
        );
        firstError ??= "attachment_location_invalid";
        continue;
      }

      let bytes: Uint8Array | null = null;
      try {
        const { data: dlData, error: dlErr } = await sb.storage
          .from(bucket)
          .download(path);
        if (dlErr || !dlData) {
          console.error(
            "[supplier_credit_propose] attachment download failed:",
            attId,
            errCode(dlErr),
          );
          firstError ??= "attachment_download_failed";
          continue;
        }
        bytes = await toBytes(dlData);
      } catch (dlThrown) {
        console.error(
          "[supplier_credit_propose] attachment download threw:",
          attId,
          errCode(dlThrown),
        );
        firstError ??= "attachment_download_failed";
        continue;
      }

      if (!bytes) {
        console.error(
          "[supplier_credit_propose] attachment bytes unreadable:",
          attId,
        );
        firstError ??= "attachment_bytes_unreadable";
        continue;
      }

      let text = "";
      try {
        text = await extractText(bytes);
      } catch (extThrown) {
        console.error(
          "[supplier_credit_propose] pdf extract failed:",
          attId,
          errCode(extThrown),
        );
        firstError ??= "pdf_extract_failed";
        continue;
      }

      counts.read++;

      const parsed = parseSupplierCredit(text);
      if (!parsed) {
        skippedInRun.add(attId);
        counts.not_credit++;
        continue;
      }

      let matchedBill: MatchedBillRow | null = null;
      if (parsed.names_bill_number) {
        const { data: billRows, error: billErr } = await sb.rpc(
          "supplier_credit_matching_bills",
          {
            p_org_id: orgId,
            p_bill_number: parsed.names_bill_number,
          },
        );
        if (billErr || !Array.isArray(billRows)) {
          console.error(
            "[supplier_credit_propose] bill lookup failed:",
            attId,
            errCode(billErr),
          );
          firstError ??= "bill_lookup_failed";
          continue;
        }
        if (billRows.length === 1) {
          matchedBill = billRows[0] as MatchedBillRow;
        }
      }

      const fallbackSupplier = firstNonEmptyLine(text) ?? parsed.credit_number;
      const supplierName = matchedBill
        ? (nonEmptyTrimmed(matchedBill.contact_name) ?? fallbackSupplier)
        : fallbackSupplier;
      const xeroContactId = matchedBill
        ? nonEmptyTrimmed(matchedBill.xero_contact_id)
        : null;
      const matchedJobId = matchedBill
        ? nonEmptyTrimmed(matchedBill.job_id)
        : null;
      const matchedBillId = matchedBill
        ? nonEmptyTrimmed(matchedBill.xero_invoice_id)
        : null;
      const matchedBillNumber = matchedBill
        ? (nonEmptyTrimmed(matchedBill.invoice_number) ??
          parsed.names_bill_number)
        : null;
      const matchReasons = matchedBill && matchedBillNumber
        ? [{ code: "credit_names_bill", value: matchedBillNumber }]
        : [];

      const amountEx = positiveMoney(parsed.amount_ex);
      const amountInc = positiveMoney(parsed.amount_inc);
      const suggestion = matchedJobId
        ? { outcome: "job", job_id: matchedJobId }
        : null;
      const billLabel = parsed.names_bill_number ?? "no bill named";
      const evidence = {
        reason: "credit_document_read",
        amount_ex: amountEx,
        document_date: parsed.credit_date,
        ...(parsed.needs_review ? { amounts_need_review: true } : {}),
        summary: {
          words:
            `Credit ${parsed.credit_number} from ${supplierName} for bill ${billLabel}`,
          credit_number: parsed.credit_number,
          supplier_name: supplierName,
          names_bill_number: parsed.names_bill_number,
          amount_inc: amountInc,
          ...(parsed.needs_review ? { amounts_need_review: true } : {}),
        },
      };

      const { data: recData, error: recErr } = await sb.rpc(
        "supplier_credit_record_proposal",
        {
          p_org_id: orgId,
          p_source_attachment_id: attId,
          p_storage_bucket: bucket,
          p_storage_path: path,
          p_xero_contact_id: xeroContactId,
          p_supplier_name: supplierName,
          p_credit_number: parsed.credit_number,
          p_credit_date: parsed.credit_date,
          p_amount_ex: amountEx,
          p_amount_inc: amountInc,
          p_names_bill_number: parsed.names_bill_number,
          p_matched_bill_xero_invoice_id: matchedBillId,
          p_matched_job_id: matchedJobId,
          p_match_reasons: matchReasons,
          p_suggestion: suggestion,
          p_evidence: evidence,
        },
      );

      if (recErr || !recData || typeof recData !== "object") {
        console.error(
          "[supplier_credit_propose] proposal record failed:",
          attId,
          errCode(recErr),
        );
        firstError ??= "proposal_write_failed";
        continue;
      }

      // deno-lint-ignore no-explicit-any
      const outcome = (recData as any).outcome;
      if (outcome === "proposed") {
        counts.proposed++;
      } else if (outcome === "duplicate") {
        counts.duplicate++;
      }
    }

    return firstError ? { ...counts, error: firstError } : counts;
  } catch (unexpected) {
    console.error(
      "[supplier_credit_propose] unexpected error:",
      errCode(unexpected),
    );
    return { ...counts, error: firstError ?? "unexpected_error" };
  }
}

// ════════════════════════════════════════════════════════════
// MATERIALS ACTUALS — EMAIL ENRICHMENT + DEEPER-READ-PATH SCAFFOLD (U3 SECONDARY)
//
// SECONDARY leg. Enrichment NEVER creates a materials fact on its own — the
// Xero ACCPAY bill is always the fact's system-of-record. This module:
//   (a) parses an emailed supplier invoice (B&D / CMI / Ampelite / FWWA / R&R
//       class) to CROSS-CHECK the Xero bill amount, attach line detail, and —
//       most valuably — RECOVER a printed job reference the supplier quoted back
//       so the bill can be linked via the SAME matchBill() reference path; and
//   (b) scaffolds a DEEPER READ PATH for finance@ archive backfill, because the
//       sw_get_group_emails tool caps at ~150 most-recent messages (~10 days at
//       finance@ volume). The archive is deeper (Marnin, 2026-07-05) — reaching
//       it needs raw Graph pagination, which this module structures but does not
//       execute (no creds/deploy in scope). The pagination LOGIC is pure and
//       tested via an injected page-fetcher so it is live-wireable later.
//
// Pure + I/O-free except paginateGraphMessages, whose network is dependency-
// injected. No sends, no mutations.
// ════════════════════════════════════════════════════════════

import { extractJobNumber } from "./materials_ingest.ts";

// ─────────────────────────────────────────────────────────────
// (a) Supplier invoice text parsing (enrichment / ref recovery)
// ─────────────────────────────────────────────────────────────
export type SupplierClass =
  | "fwwa"
  | "rnr"
  | "bnd"
  | "cmi"
  | "ampelite"
  | "unknown";

export interface ParsedSupplierInvoice {
  supplierClass: SupplierClass;
  invoiceNumber: string | null;
  jobRef: string | null; // canonical SW…-##### recovered from the PDF text
  amountExGst: number | null;
  amountIncGst: number | null;
}

function classifySupplier(text: string): SupplierClass {
  const t = text.toLowerCase();
  if (/fencing\s+warehouse/.test(t)) return "fwwa";
  if (/\br\s*&\s*r\b|r and r fencing/.test(t)) return "rnr";
  if (/b\s*&\s*d\s*metals|b and d metals/.test(t)) return "bnd";
  if (/\bcmi\b|combined metal industries/.test(t)) return "cmi";
  if (/ampelite/.test(t)) return "ampelite";
  return "unknown";
}

function parseMoney(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Best-effort invoice-number extraction across the supplier classes we email with.
export function parseInvoiceNumber(text: string): string | null {
  const patterns = [
    /Tax\s+Invoice\s*(?:No\.?|Number|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{3,})/i,
    /Invoice\s*(?:No\.?|Number|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{3,})/i,
    /\bINV[\-\s]?([A-Z0-9\-\/]{3,})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1].replace(/[.,;]+$/, "").toUpperCase();
  }
  return null;
}

// Amount extraction: prefer an explicit ex-GST subtotal; fall back to the
// GST-inclusive total (flagged separately so the caller knows which it got).
export function parseAmounts(
  text: string,
): { exGst: number | null; incGst: number | null } {
  const exMatch =
    text.match(/Sub[\s\-]?total\s*(?:\(ex[^)]*\))?\s*\$?\s*([\d,]+\.\d{2})/i) ||
    text.match(/Total\s*\(ex[^)]*\)\s*\$?\s*([\d,]+\.\d{2})/i);
  const incMatch = text.match(
    /Total\s*(?:\(inc[^)]*\)|Due|Amount)?\s*\$?\s*([\d,]+\.\d{2})/i,
  ) ||
    text.match(/Amount\s*Due\s*\$?\s*([\d,]+\.\d{2})/i);
  return { exGst: parseMoney(exMatch?.[1]), incGst: parseMoney(incMatch?.[1]) };
}

export function parseSupplierInvoiceText(text: string): ParsedSupplierInvoice {
  const amounts = parseAmounts(text);
  return {
    supplierClass: classifySupplier(text),
    invoiceNumber: parseInvoiceNumber(text),
    jobRef: extractJobNumber(text), // reuse the canonical extractor — ref discipline pays off here
    amountExGst: amounts.exGst,
    amountIncGst: amounts.incGst,
  };
}

// ─────────────────────────────────────────────────────────────
// Enrichment result: what the parsed email can add to an existing Xero bill.
// NEVER a fact by itself — the ingester decides what to do with these signals.
// ─────────────────────────────────────────────────────────────
export interface BillLike {
  xero_invoice_id: string;
  reference: string | null;
  sub_total: number | null;
  total: number | null;
}

export interface EnrichmentResult {
  recoveredJobRef: string | null; // feed into matchBill() as a reference match when the Xero bill had none
  amountCrossCheckOk: boolean | null; // parsed amount vs Xero bill total (null when we couldn't compare)
  amountDeltaAbs: number | null;
  parsedInvoiceNumber: string | null;
}

export function enrichBill(
  bill: BillLike,
  parsed: ParsedSupplierInvoice,
  tolerancePct = 0.02,
  toleranceAbs = 5,
): EnrichmentResult {
  // Only surface a recovered ref if the Xero bill itself carried no job ref.
  const billRef = extractJobNumber(bill.reference);
  const recoveredJobRef = billRef ? null : parsed.jobRef;

  let amountCrossCheckOk: boolean | null = null;
  let amountDeltaAbs: number | null = null;
  const parsedAmt = parsed.amountIncGst ?? parsed.amountExGst;
  const billAmt = parsed.amountIncGst != null ? bill.total : bill.sub_total;
  if (parsedAmt != null && billAmt != null) {
    amountDeltaAbs = Math.abs(parsedAmt - billAmt);
    const tol = Math.max(toleranceAbs, Math.abs(billAmt) * tolerancePct);
    amountCrossCheckOk = amountDeltaAbs <= tol + 1e-9;
  }

  return {
    recoveredJobRef,
    amountCrossCheckOk,
    amountDeltaAbs,
    parsedInvoiceNumber: parsed.invoiceNumber,
  };
}

// ─────────────────────────────────────────────────────────────
// (b) DEEPER READ PATH — finance@ archive backfill scaffold.
//
// The sw_get_group_emails tool caps ~150 recent messages. To reach the archive
// (needed for email backfill) we page raw Microsoft Graph. Two live wirings are
// possible (documented, NOT executed here — both need creds + a deploy Marnin
// gates):
//
//   OPTION 1 — group conversations:
//     GET /groups/{finance-group-id}/conversations?$top=50            (+ nextLink)
//     then /conversations/{id}/threads/{id}/posts for bodies.
//   OPTION 2 — mirrored user mailbox (a user account subscribed to finance@):
//     GET /users/{mirror-upn}/mailFolders/inbox/messages
//         ?$top=50&$select=subject,from,receivedDateTime,body,hasAttachments
//         &$filter=receivedDateTime ge {sinceIso}                     (+ nextLink)
//     Option 2 is simpler (delta-capable, attachment endpoints) and is the
//     recommended wiring; U1 measured finance@ is an M365 GROUP so a mirror user
//     is the pragmatic archive reader.
//
// The pagination LOOP below is pure over an injected fetchPage() so it is unit-
// tested now and only needs the real Graph fetcher slotted in at deploy time.
// ─────────────────────────────────────────────────────────────
export interface GraphMessage {
  id: string;
  subject?: string;
  receivedDateTime?: string;
  from?: string;
  bodyText?: string;
  hasAttachments?: boolean;
}

export interface GraphPage {
  value: GraphMessage[];
  nextLink: string | null; // @odata.nextLink, or null when exhausted
}

export interface DeepReadOptions {
  pageSize?: number; // $top
  maxMessages?: number; // safety cap so a backfill can't run unbounded
  sinceIso?: string; // stop once messages predate this (archive lower bound)
}

// Injected fetcher: given the next link (or null for the first page) returns a
// GraphPage. The caller wires this to real Graph at deploy; tests pass a stub.
export type GraphPageFetcher = (
  nextLink: string | null,
) => Promise<GraphPage>;

export async function paginateGraphMessages(
  fetchPage: GraphPageFetcher,
  opts: DeepReadOptions = {},
): Promise<GraphMessage[]> {
  const maxMessages = opts.maxMessages ?? 2000;
  const sinceMs = opts.sinceIso ? Date.parse(opts.sinceIso) : null;
  const out: GraphMessage[] = [];
  let nextLink: string | null = null;
  let firstPass = true;

  while ((firstPass || nextLink) && out.length < maxMessages) {
    firstPass = false;
    const page = await fetchPage(nextLink);
    for (const msg of page.value) {
      if (sinceMs != null && msg.receivedDateTime) {
        if (Date.parse(msg.receivedDateTime) < sinceMs) {
          return out; // reached the archive floor — stop paging
        }
      }
      out.push(msg);
      if (out.length >= maxMessages) return out;
    }
    nextLink = page.nextLink;
  }
  return out;
}

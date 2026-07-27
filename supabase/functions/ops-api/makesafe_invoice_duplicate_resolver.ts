import {
  isVoidStatus,
  normRef,
  sameWorkRef,
  splitRefPo,
} from "./makesafe_send_pack.ts";

export type SesInvoiceMatchTier =
  | "obligation_binding"
  | "job_id"
  | "reference"
  | "reference_substring";

export type SesInvoiceAmbiguity =
  | "none"
  | "multi_live"
  | "sibling_po"
  | "void_only"
  | "mirror_xero_mismatch";

export interface SesInvoiceDuplicateRequest {
  job_id: string;
  external_ref?: string | null;
  obligation_revision_id?: string | null;
  attendance_cycle_ids?: string[];
}

export interface SesInvoiceIndexRow {
  id?: string;
  job_id: string | null;
  xero_invoice_id: string | null;
  invoice_number: string | null;
  status: string | null;
  reference: string | null;
  invoice_type?: string | null;
  invoice_obligation_revision_id?: string | null;
}

export interface SesInvoiceDuplicateResolution {
  job_id: string;
  match_tier: SesInvoiceMatchTier | null;
  ambiguity: SesInvoiceAmbiguity;
  live_invoices: SesInvoiceIndexRow[];
  allows_create: boolean;
  reason_codes: string[];
}

function stableInvoices(rows: SesInvoiceIndexRow[]): SesInvoiceIndexRow[] {
  return rows.slice().sort((left, right) =>
    String(left.xero_invoice_id || left.id || "").localeCompare(
      String(right.xero_invoice_id || right.id || ""),
    )
  );
}

function live(rows: SesInvoiceIndexRow[]): SesInvoiceIndexRow[] {
  return stableInvoices(
    rows.filter((row) =>
      String(row.invoice_type || "ACCREC").toUpperCase() === "ACCREC" &&
      !isVoidStatus(row.status)
    ),
  );
}

function resolveOne(
  request: SesInvoiceDuplicateRequest,
  rows: SesInvoiceIndexRow[],
): SesInvoiceDuplicateResolution {
  const all = stableInvoices(rows);
  const liveRows = live(all);
  const voidRows = all.filter((row) => isVoidStatus(row.status));

  const byObligation = request.obligation_revision_id
    ? liveRows.filter((row) =>
      row.invoice_obligation_revision_id === request.obligation_revision_id
    )
    : [];
  const byJob = liveRows.filter((row) => row.job_id === request.job_id);
  const ref = normRef(request.external_ref);
  const exact = ref
    ? liveRows.filter((row) =>
      normRef(row.reference) === ref &&
      sameWorkRef(request.external_ref, row.reference)
    )
    : [];
  const substring = ref.length >= 5
    ? liveRows.filter((row) => {
      const candidate = normRef(row.reference);
      return candidate.includes(ref) &&
        sameWorkRef(request.external_ref, row.reference);
    })
    : [];
  const siblingPo = ref.length >= 5 &&
    liveRows.some((row) => {
      const candidate = normRef(row.reference);
      const ourBase = splitRefPo(request.external_ref).base;
      const candidateBase = splitRefPo(row.reference).base;
      return (candidate.includes(ref) ||
        (!!ourBase && ourBase === candidateBase)) &&
        !sameWorkRef(request.external_ref, row.reference);
    });

  const tierRows: Array<[SesInvoiceMatchTier, SesInvoiceIndexRow[]]> = [
    ["obligation_binding", byObligation],
    ["job_id", byJob],
    ["reference", exact],
    ["reference_substring", substring],
  ];
  const match = tierRows.find(([, candidates]) => candidates.length > 0);
  if (match) {
    const unique = new Map<string, SesInvoiceIndexRow>();
    for (const row of match[1]) {
      unique.set(String(row.xero_invoice_id || row.id), row);
    }
    const hits = stableInvoices([...unique.values()]);
    const ambiguity: SesInvoiceAmbiguity = hits.length > 1
      ? "multi_live"
      : "none";
    return {
      job_id: request.job_id,
      match_tier: match[0],
      ambiguity,
      live_invoices: hits,
      allows_create: false,
      reason_codes: ambiguity === "multi_live"
        ? ["ambiguous_live_invoices", "blocked_duplicate_live"]
        : ["blocked_duplicate_live"],
    };
  }

  return {
    job_id: request.job_id,
    match_tier: null,
    ambiguity: siblingPo
      ? "sibling_po"
      : (voidRows.length > 0 ? "void_only" : "none"),
    live_invoices: [],
    allows_create: true,
    reason_codes: siblingPo
      ? ["different_po_sibling_does_not_block"]
      : (voidRows.length > 0 ? ["void_only_does_not_block"] : []),
  };
}

/**
 * Resolves a bounded batch against rows already fetched by indexed job/reference
 * queries. This function never asks for or scans the whole ACCREC estate.
 */
export function resolveSesInvoiceDuplicates(
  requests: SesInvoiceDuplicateRequest[],
  indexedRows: SesInvoiceIndexRow[],
): SesInvoiceDuplicateResolution[] {
  const requestJobs = new Set(requests.map((request) => request.job_id));
  const requestObligations = new Set(
    requests.map((request) => request.obligation_revision_id).filter(
      (value): value is string => !!value,
    ),
  );
  const requestRefs = requests.map((request) => normRef(request.external_ref))
    .filter((value) => value.length >= 5);
  const requestBases = requests.map((request) =>
    splitRefPo(request.external_ref).base
  ).filter((value) => value.length >= 5);
  const boundedRows = indexedRows.filter((row) => {
    if (row.job_id && requestJobs.has(row.job_id)) return true;
    if (
      row.invoice_obligation_revision_id &&
      requestObligations.has(row.invoice_obligation_revision_id)
    ) return true;
    const candidate = normRef(row.reference);
    const candidateBase = splitRefPo(row.reference).base;
    return requestRefs.some((reference) => candidate.includes(reference)) ||
      requestBases.some((base) => candidateBase === base);
  });
  return requests.map((request) => resolveOne(request, boundedRows));
}

export interface SesInvoiceDuplicateQueryClient {
  from(table: "xero_invoices"): {
    select(columns: string): {
      eq(column: string, value: string): {
        in(column: string, values: string[]): Promise<{
          data: SesInvoiceIndexRow[] | null;
          error: { message?: string } | null;
        }>;
      };
      in(column: string, values: string[]): Promise<{
        data: SesInvoiceIndexRow[] | null;
        error: { message?: string } | null;
      }>;
    };
  };
}

/**
 * First query is job_id indexed. Reference fallbacks are deliberately supplied
 * by the caller's indexed search adapter because PostgREST cannot express the
 * normalized expression index safely with arbitrary builder text.
 */
export async function resolveSesInvoiceDuplicatesByJob(
  client: SesInvoiceDuplicateQueryClient,
  orgId: string,
  requests: SesInvoiceDuplicateRequest[],
  referenceRows: SesInvoiceIndexRow[] = [],
): Promise<SesInvoiceDuplicateResolution[]> {
  const jobIds = [...new Set(requests.map((request) => request.job_id))];
  const response = await client.from("xero_invoices")
    .select(
      "id,job_id,xero_invoice_id,invoice_number,status,reference,invoice_type",
    )
    .eq("org_id", orgId)
    .in("job_id", jobIds);
  if (response.error) {
    throw new Error(
      `duplicate guard could not read the indexed invoice mirror: ${
        response.error.message || "unknown PostgREST error"
      }`,
    );
  }
  return resolveSesInvoiceDuplicates(
    requests,
    [...(response.data || []), ...referenceRows],
  );
}

import {
  isVoidStatus,
  normRef,
  poIndeterminateSiblingBlocks,
  referenceCandidateBlocks,
  sameWorkRefPoBase,
  splitRefPo,
  workRefRelation,
} from "./makesafe_send_pack.ts";

export type SesInvoiceMatchTier =
  | "obligation_binding"
  | "job_id"
  | "reference"
  | "reference_substring"
  | "reference_po_base";

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
  // One shared candidate predicate across every reference tier — see referenceCandidateBlocks.
  const blocks = (row: SesInvoiceIndexRow) =>
    referenceCandidateBlocks(
      request.external_ref,
      row.reference,
      request.job_id,
      row.job_id,
    );
  const exact = ref
    ? liveRows.filter((row) => normRef(row.reference) === ref && blocks(row))
    : [];
  const substring = ref.length >= 5
    ? liveRows.filter((row) =>
      normRef(row.reference).includes(ref) && blocks(row)
    )
    : [];
  // PO-insensitive claim-base tier — symmetric, so it holds whichever side carries the PO.
  const poBase = liveRows.filter((row) =>
    normRef(row.reference) !== "" &&
    sameWorkRefPoBase(
      request.external_ref,
      row.reference,
      request.job_id,
      row.job_id,
    )
  );
  // Rows sharing our claim base where exactly ONE side names a purchase order AND nothing attributes
  // that invoice to a different card. The evidence cannot separate them from our work, so they are
  // an ambiguity — and an ambiguity refuses.
  const indeterminate = ref
    ? liveRows.filter((row) =>
      workRefRelation(request.external_ref, row.reference) ===
        "po_indeterminate" &&
      poIndeterminateSiblingBlocks(request.job_id, row.job_id)
    )
    : [];

  const tierRows: Array<[SesInvoiceMatchTier, SesInvoiceIndexRow[]]> = [
    ["obligation_binding", byObligation],
    ["job_id", byJob],
    ["reference", exact],
    ["reference_substring", substring],
    ["reference_po_base", poBase],
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

  // No tier matched. A claim-base sibling whose PO evidence is one-sided is still an AMBIGUITY, and
  // an ambiguity refuses — that is the whole point of detecting it. This branch is normally
  // unreachable now (the `reference_po_base` tier claims the same rows first) and is deliberately
  // kept as the second line of defence: it still fires for a claim base shorter than the tier's
  // digit-safety floor, and it is what stops a future tier regression from reading as a permission.
  // Koondoola SWMS-261025 recorded exactly this ambiguity on 2026-08-05 and minted anyway.
  if (indeterminate.length > 0) {
    return {
      job_id: request.job_id,
      match_tier: null,
      ambiguity: "sibling_po",
      live_invoices: indeterminate,
      allows_create: false,
      reason_codes: [
        "po_indeterminate_sibling_blocks",
        "ambiguous_live_invoices",
      ],
    };
  }

  // A sibling that names a DIFFERENT purchase order on the same claim is not ambiguous at all: the
  // builder said so twice, in two purchase orders. It is separately invoiceable work and still does
  // not block (Marnin's rule, 2026-07-08).
  const distinctPoSibling = liveRows.some((row) =>
    workRefRelation(request.external_ref, row.reference) === "distinct_po"
  );
  return {
    job_id: request.job_id,
    match_tier: null,
    ambiguity: voidRows.length > 0 ? "void_only" : "none",
    live_invoices: [],
    allows_create: true,
    reason_codes: [
      ...(distinctPoSibling ? ["different_po_sibling_does_not_block"] : []),
      ...(voidRows.length > 0 ? ["void_only_does_not_block"] : []),
    ],
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
  // The >= 5 floor guards the SUBSTRING test, where a short token false-matches inside an unrelated
  // number. Claim-base membership is exact EQUALITY, so it carries no such risk and takes no floor:
  // dropping short bases here made a short-claim card invisible to the whole probe, which silently
  // made the `sibling_po` ambiguity below unreachable rather than safe.
  const requestRefs = requests.map((request) => normRef(request.external_ref))
    .filter((value) => value.length >= 5);
  const requestBases = requests.map((request) =>
    splitRefPo(request.external_ref).base
  ).filter((value) => value.length > 0);
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
      "id,job_id,xero_invoice_id,invoice_number,status,reference,invoice_type,invoice_obligation_revision_id",
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

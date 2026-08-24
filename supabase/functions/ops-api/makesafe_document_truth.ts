// deno-lint-ignore-file no-explicit-any
// Typed make-safe document truth shared by board presentation and SES review.
//
// A non-empty pack pointer is only a coordinate. It becomes a usable artifact
// when the exact job_documents row resolves as the expected document class.
// Keep the legacy untyped/general filename fallback aligned with the board's
// long-standing chip rules; a different typed row must never satisfy a pointer.

import { isSelfGeneratedMakesafeWorkOrder } from "./makesafe_builder_work_order_identity.ts";
import {
  canonicalSesFamilyFromCard,
  resolveSesFamilyMatrixRow,
  type SesBuilderKey,
} from "./ses_family_matrix.ts";

export type SesRequiredDocumentMap = Readonly<{
  report: boolean;
  invoice: boolean;
  swms: boolean;
}>;

export type SesRequiredDocumentsResolution =
  | Readonly<{
    required_documents_resolved: true;
    required_documents: SesRequiredDocumentMap;
    required_documents_unresolved_reason: null;
  }>
  | Readonly<{
    required_documents_resolved: false;
    required_documents: null;
    required_documents_unresolved_reason: string;
  }>;

export interface SesRequiredDocumentsCard {
  builder_key?: unknown;
  family?: unknown;
  job_number?: unknown;
  requesting_company_slug?: unknown;
  requesting_company_name?: unknown;
  requesting_company?: unknown;
  external_ref?: unknown;
  site_suburb?: unknown;
  strata?: unknown;
  own_template_requested?: unknown;
  pricing_disposition?: unknown;
  swms_required?: unknown;
}

export interface MakesafeDocumentFlags {
  has_wo: boolean;
  has_report_doc: boolean;
  has_invoice_doc: boolean;
  has_swms_doc: boolean;
}

function pointerText(value: unknown): string {
  return String(value ?? "").trim();
}

export function makesafeDocBooleans(
  docRows: any[] | null | undefined,
): MakesafeDocumentFlags {
  const rows = docRows || [];
  const isFallbackType = (type: string) => type === "" || type === "general";
  const nameOf = (document: any) =>
    String(document?.file_name || "").toLowerCase();
  const typeOf = (document: any) => String(document?.type || "").toLowerCase();
  // SWMS filename fallback must not catch the make-safe job-number prefix
  // `SWMS-NNNNN` that appears in most attached filenames.
  const swmsInName = (name: string) => /swms(?![-\s]?\d)/i.test(name);
  const has = (
    canonicalType: string,
    nameMatches: (name: string) => boolean,
  ) =>
    rows.some((document: any) => {
      const type = typeOf(document);
      if (type === canonicalType) return true;
      if (isFallbackType(type)) return nameMatches(nameOf(document));
      return false;
    });
  return {
    // Work orders stay type-only: a filename cannot self-issue job identity.
    has_wo: rows.some((document: any) =>
      typeOf(document) === "work_order" &&
      !isSelfGeneratedMakesafeWorkOrder(
        document?.file_name || document?.storage_url,
      )
    ),
    has_report_doc: has(
      "makesafe_report",
      (name) => name.includes("make safe report"),
    ),
    has_invoice_doc: has("invoice", (name) => name.includes("invoice")),
    has_swms_doc: has("swms", swmsInName),
  };
}

export interface MakesafePackDocumentPointerResolution {
  report_doc_resolved: boolean;
  invoice_doc_resolved: boolean;
  swms_doc_resolved: boolean;
}

export interface MakesafePackArtifactRequirements {
  requires_bound_report_doc: boolean;
  requires_bound_invoice_doc: boolean;
}

/**
 * Operator presentation requirements are deliberately narrower than stage
 * placement. Assessment is portal-only, and a no-charge release must not
 * invent an invoice that the SES money contract forbids creating.
 */
export function makesafePackArtifactRequirements(input: {
  ses_family?: unknown;
  pricing_disposition?: unknown;
}): MakesafePackArtifactRequirements {
  return {
    requires_bound_report_doc:
      pointerText(input.ses_family).toLowerCase() !== "assessment_quote",
    requires_bound_invoice_doc:
      pointerText(input.pricing_disposition).toLowerCase() !==
        "no_additional_charge",
  };
}

function requiredDocumentsBuilderKey(
  card: SesRequiredDocumentsCard,
): SesBuilderKey {
  const explicit = String(card.builder_key ?? "").trim().toUpperCase();
  if (
    ["MLB", "AJS", "AJBR", "WESTERN", "SYNTHETIC"].includes(explicit)
  ) {
    return explicit as SesBuilderKey;
  }
  const token = [
    card.requesting_company_slug,
    card.requesting_company_name,
    card.requesting_company,
    card.external_ref,
    card.job_number,
  ].map((value) => String(value ?? "").trim().toLowerCase()).join(" ");
  if (token.includes("synthetic-livefire")) return "SYNTHETIC";
  if (/\bajbr\b/.test(token)) return "AJBR";
  if (/\bajs?\b/.test(token) || token.includes("alliance joinery")) {
    return "AJS";
  }
  if (
    /\b(mlb|ml builders?|major loss builders?)\b/.test(token) ||
    token.includes("mlbuilders")
  ) {
    return "MLB";
  }
  if (
    /\b(wb|bw|bwcwa)\b/.test(token) ||
    token.includes("western build") || token.includes("builderwest")
  ) {
    return "WESTERN";
  }
  return "UNKNOWN";
}

/**
 * The one pack-artifact requirement derivation shared by board and inspection.
 *
 * Matrix resolution establishes family/builder authority. The artifact contract
 * then narrows raw family obligations: assessment is satisfied by its portal
 * triad rather than a bound report document, and no-additional-charge packs must
 * not invent an invoice document. This map says what the pack must bind; pointer
 * resolution, current-cycle report selection, Xero status and send routes remain
 * separate proof.
 */
export function deriveSesRequiredDocuments(
  card: SesRequiredDocumentsCard,
): SesRequiredDocumentsResolution {
  const builderKey = requiredDocumentsBuilderKey(card);
  const family = canonicalSesFamilyFromCard({
    makesafe_job_family: card.family,
    strata: card.strata,
    own_template_requested: card.own_template_requested,
  });
  const ownTemplateRequested = card.own_template_requested === true ||
    family === "own_template_roof";
  const resolved = resolveSesFamilyMatrixRow({
    builder_key: builderKey,
    family,
    strata: card.strata === true,
    own_template_requested: ownTemplateRequested,
    site_suburb: card.site_suburb,
  });
  if (!resolved.ok) {
    return {
      required_documents_resolved: false,
      required_documents: null,
      required_documents_unresolved_reason:
        `${resolved.failure.code}: ${resolved.failure.reason}`,
    };
  }

  const { row } = resolved;
  const matrixReportOwed = row.required_portal_roles.length > 0 ||
    row.report_route === "work_order_sender";
  const matrixInvoiceOwed = row.invoice_basis.length > 0;
  const temporaryFenceBasis = row.invoice_basis.includes("temporary_fence");
  const artifactRequirements = makesafePackArtifactRequirements({
    ses_family: row.family,
    pricing_disposition: card.pricing_disposition,
  });
  const swmsRequired = temporaryFenceBasis
    ? false
    : typeof card.swms_required === "boolean"
    ? card.swms_required
    : row.swms_policy === "always";
  return {
    required_documents_resolved: true,
    required_documents: {
      report: matrixReportOwed &&
        artifactRequirements.requires_bound_report_doc,
      invoice: matrixInvoiceOwed &&
        artifactRequirements.requires_bound_invoice_doc,
      swms: swmsRequired,
    },
    required_documents_unresolved_reason: null,
  };
}

export function makesafeReportDocumentTypesForFamily(
  family: unknown,
): readonly string[] {
  const value = pointerText(family).toLowerCase();
  if (value === "ordinary_roof_portal" || value === "own_template_roof") {
    return ["roof_report"];
  }
  return ["makesafe_report"];
}

/** Resolve each pack pointer against its exact typed/legacy document row. */
export function resolveMakesafePackDocumentPointers(
  pack:
    | {
      report_doc_id?: unknown;
      invoice_doc_id?: unknown;
      swms_doc_id?: unknown;
    }
    | null
    | undefined,
  docRows: any[] | null | undefined,
  options: {
    report_document_types?: readonly string[];
  } = {},
): MakesafePackDocumentPointerResolution {
  const rows = docRows || [];
  const pointedRow = (pointer: unknown): any | null => {
    const id = pointerText(pointer);
    return id
      ? rows.find((document) => pointerText(document?.id) === id) || null
      : null;
  };
  const retrievable = (document: any): boolean =>
    !!pointerText(document?.pdf_url || document?.storage_url);
  const typed = (
    document: any,
    canonicalTypes: readonly string[],
    legacyNameMatches: (name: string) => boolean,
  ): boolean => {
    if (!document || !retrievable(document)) return false;
    const type = String(document?.type || "").toLowerCase();
    if (canonicalTypes.includes(type)) return true;
    return (type === "" || type === "general") &&
      legacyNameMatches(String(document?.file_name || "").toLowerCase());
  };
  const report = pointedRow(pack?.report_doc_id);
  const invoice = pointedRow(pack?.invoice_doc_id);
  const swms = pointedRow(pack?.swms_doc_id);
  const reportTypes = options.report_document_types || ["makesafe_report"];
  const legacyReportNameMatches = (name: string): boolean =>
    (reportTypes.includes("roof_report") && name.includes("roof report")) ||
    (reportTypes.includes("makesafe_report") &&
      name.includes("make safe report"));
  return {
    report_doc_resolved: typed(
      report,
      reportTypes,
      legacyReportNameMatches,
    ),
    invoice_doc_resolved: typed(
      invoice,
      ["invoice"],
      (name) => name.includes("invoice"),
    ),
    swms_doc_resolved: typed(
      swms,
      ["swms"],
      (name) => /swms(?![-\s]?\d)/i.test(name),
    ),
  };
}

export const SES_FAMILY_MATRIX_VERSION =
  "ses-builder-family-matrix/2026-07-27.3";
export const SES_ASSESSMENT_RECIPE_VERSION =
  "assessment-triad-invoice-only/2026-07-27";

export type SesBuilderKey =
  | "MLB"
  | "AJS"
  | "AJBR"
  | "WESTERN"
  | "SYNTHETIC"
  | "UNKNOWN";

export type SesFamilyId =
  | "unknown"
  | "physical_makesafe"
  | "ordinary_roof_portal"
  | "own_template_roof"
  | "assessment_quote"
  | "temporary_fencing";

export type SesManifestJobType =
  | "physical_makesafe"
  | "roof_report"
  | "assessment_report_quote";

export type SesSwmsPolicy =
  | "always"
  | "hrcw_only"
  | "builder_waiver_unless_hrcw";

export type SesInvoiceBasis =
  | "ajs_labour_materials"
  | "standard_labour_materials"
  | "mlb_temporary_fence_hire"
  | "ajs_temporary_fence_labour_only"
  | "western_temporary_fence_hire"
  | "roof_storey_fixed"
  | "assessment_fixed";

export interface SesFamilyMatrixRow {
  builder_key: Exclude<SesBuilderKey, "UNKNOWN">;
  family: SesFamilyId;
  job_type: SesManifestJobType;
  subtype: string | null;
  report_only: boolean;
  report_delivery: "portal" | "own_document" | null;
  swms_policy: SesSwmsPolicy;
  swms_waiver_rule: string | null;
  invoice_basis: SesInvoiceBasis;
  routing_rule:
    | "mlb-perth-routing"
    | "mlb-south-west-routing"
    | "ajs-routing"
    | "western-routing"
    | "synthetic-internal-routing";
  invoice_to: string | null;
  report_route: "work_order_sender";
  photo_route: "work_order_sender" | "not_applicable";
  invoice_route: "matrix_invoice_mailbox";
  required_portal_roles: Array<
    "roof_report" | "assessment" | "photos" | "scope"
  >;
  named_na_rules: string[];
}

export interface SesFamilyMatrixFailure {
  code:
    | "ajs_misclassified_as_roof_report"
    | "builder_open_class"
    | "family_unknown";
  reason: string;
  recovery_action: string;
}

export type SesFamilyMatrixResolution =
  | { ok: true; row: SesFamilyMatrixRow }
  | { ok: false; failure: SesFamilyMatrixFailure };

const MLB_MAKESAFES = "makesafes@mlbuilders.com.au";
const AJS_WORK_ORDERS = "workorders@ajs.build";
const WESTERN_ACCOUNTS = "accounts@westernbuild.com.au";
const SYNTHETIC_INTERNAL_MAILBOX = "marnin@secureworkswa.com.au";

function physicalRow(
  builder_key: "MLB" | "AJS" | "AJBR" | "WESTERN",
): SesFamilyMatrixRow {
  const ajs = builder_key === "AJS" || builder_key === "AJBR";
  const western = builder_key === "WESTERN";
  return {
    builder_key,
    family: "physical_makesafe",
    job_type: "physical_makesafe",
    subtype: null,
    report_only: false,
    report_delivery: null,
    swms_policy: builder_key === "MLB"
      ? "always"
      : ajs
      ? "builder_waiver_unless_hrcw"
      : "hrcw_only",
    swms_waiver_rule: ajs ? "ajs-make-safes-do-not-normally-carry-swms" : null,
    invoice_basis: ajs ? "ajs_labour_materials" : "standard_labour_materials",
    routing_rule: ajs
      ? "ajs-routing"
      : western
      ? "western-routing"
      : "mlb-perth-routing",
    invoice_to: ajs
      ? AJS_WORK_ORDERS
      : western
      ? WESTERN_ACCOUNTS
      : MLB_MAKESAFES,
    report_route: "work_order_sender",
    photo_route: "work_order_sender",
    invoice_route: "matrix_invoice_mailbox",
    required_portal_roles: [],
    named_na_rules: [
      "physical-work-has-no-portal-deliverable",
      "not-a-roof-report",
      "not-an-assessment-report",
    ],
  };
}

function temporaryFenceRow(
  builder_key: "MLB" | "AJS" | "AJBR" | "WESTERN",
): SesFamilyMatrixRow {
  const base = physicalRow(builder_key);
  const ajs = builder_key === "AJS" || builder_key === "AJBR";
  return {
    ...base,
    family: "temporary_fencing",
    subtype: "temporary_fencing",
    invoice_basis: ajs
      ? "ajs_temporary_fence_labour_only"
      : builder_key === "WESTERN"
      ? "western_temporary_fence_hire"
      : "mlb_temporary_fence_hire",
  };
}

function mlbReportRow(
  family: "ordinary_roof_portal" | "own_template_roof" | "assessment_quote",
): SesFamilyMatrixRow {
  const assessment = family === "assessment_quote";
  const ownDocument = family === "own_template_roof";
  return {
    builder_key: "MLB",
    family,
    job_type: assessment ? "assessment_report_quote" : "roof_report",
    subtype: null,
    report_only: true,
    report_delivery: assessment
      ? "portal"
      : ownDocument
      ? "own_document"
      : "portal",
    swms_policy: "hrcw_only",
    swms_waiver_rule: "mlb-report-only-card-carries-no-swms",
    invoice_basis: assessment ? "assessment_fixed" : "roof_storey_fixed",
    routing_rule: "mlb-perth-routing",
    invoice_to: MLB_MAKESAFES,
    report_route: "work_order_sender",
    photo_route: "not_applicable",
    invoice_route: "matrix_invoice_mailbox",
    required_portal_roles: assessment
      ? ["assessment", "photos", "scope"]
      : ownDocument
      ? []
      : ["roof_report"],
    named_na_rules: assessment
      ? [
        "not-a-roof-report",
        "report-only-has-no-physical-reporting-evidence",
        "report-only-has-no-photo-email",
      ]
      : ownDocument
      ? [
        "roof-report-on-own-letterhead",
        "own-document-has-no-portal-deliverable",
        "not-an-assessment-report",
        "report-only-has-no-physical-reporting-evidence",
        "report-only-has-no-photo-email",
      ]
      : [
        "report-only-portal-is-the-report",
        "not-an-assessment-report",
        "report-only-has-no-physical-reporting-evidence",
        "report-only-has-no-photo-email",
      ],
  };
}

function syntheticRow(
  family:
    | "physical_makesafe"
    | "temporary_fencing"
    | "ordinary_roof_portal"
    | "assessment_quote",
): SesFamilyMatrixRow {
  const assessment = family === "assessment_quote";
  const roof = family === "ordinary_roof_portal";
  const temporaryFence = family === "temporary_fencing";
  const reportOnly = assessment || roof;
  return {
    builder_key: "SYNTHETIC",
    family,
    job_type: assessment
      ? "assessment_report_quote"
      : roof
      ? "roof_report"
      : "physical_makesafe",
    subtype: temporaryFence ? "temporary_fencing" : null,
    report_only: reportOnly,
    report_delivery: roof ? "portal" : null,
    swms_policy: "builder_waiver_unless_hrcw",
    swms_waiver_rule: "synthetic-livefire-is-internal-only-and-cannot-release",
    invoice_basis: assessment
      ? "assessment_fixed"
      : roof
      ? "roof_storey_fixed"
      : temporaryFence
      ? "mlb_temporary_fence_hire"
      : "standard_labour_materials",
    routing_rule: "synthetic-internal-routing",
    invoice_to: SYNTHETIC_INTERNAL_MAILBOX,
    report_route: "work_order_sender",
    photo_route: reportOnly ? "not_applicable" : "work_order_sender",
    invoice_route: "matrix_invoice_mailbox",
    required_portal_roles: assessment
      ? ["assessment", "photos", "scope"]
      : roof
      ? ["roof_report"]
      : [],
    named_na_rules: assessment
      ? [
        "not-a-roof-report",
        "report-only-has-no-physical-reporting-evidence",
        "report-only-has-no-photo-email",
        "synthetic-livefire-release-forbidden",
      ]
      : roof
      ? [
        "report-only-portal-is-the-report",
        "not-an-assessment-report",
        "report-only-has-no-physical-reporting-evidence",
        "report-only-has-no-photo-email",
        "synthetic-livefire-release-forbidden",
      ]
      : [
        "physical-work-has-no-portal-deliverable",
        "not-a-roof-report",
        "not-an-assessment-report",
        "synthetic-livefire-release-forbidden",
      ],
  };
}

export const SES_FAMILY_MATRIX: readonly SesFamilyMatrixRow[] = Object.freeze([
  physicalRow("MLB"),
  temporaryFenceRow("MLB"),
  mlbReportRow("ordinary_roof_portal"),
  mlbReportRow("own_template_roof"),
  mlbReportRow("assessment_quote"),
  physicalRow("AJS"),
  temporaryFenceRow("AJS"),
  physicalRow("AJBR"),
  temporaryFenceRow("AJBR"),
  physicalRow("WESTERN"),
  temporaryFenceRow("WESTERN"),
  syntheticRow("physical_makesafe"),
  syntheticRow("temporary_fencing"),
  syntheticRow("ordinary_roof_portal"),
  syntheticRow("assessment_quote"),
]);

const AJS_KEYS = new Set<SesBuilderKey>(["AJS", "AJBR"]);
const AJS_FORBIDDEN_REPORT_FAMILIES = new Set<SesFamilyId>([
  "ordinary_roof_portal",
  "own_template_roof",
  "assessment_quote",
]);

export function resolveSesFamilyMatrixRow(args: {
  builder_key: SesBuilderKey;
  family: SesFamilyId;
  strata?: boolean;
  own_template_requested?: boolean;
}): SesFamilyMatrixResolution {
  if (args.family === "unknown") {
    return {
      ok: false,
      failure: {
        code: "family_unknown",
        reason: "Card has no sealed SES family classification.",
        recovery_action:
          "Recover the family from canonical source authority before preparing the docket.",
      },
    };
  }
  if (
    AJS_KEYS.has(args.builder_key) &&
    AJS_FORBIDDEN_REPORT_FAMILIES.has(args.family)
  ) {
    return {
      ok: false,
      failure: {
        code: "ajs_misclassified_as_roof_report",
        reason:
          "Captain ruling 2026-07-27: anything AJS/AJBR sends is a make-safe; report-only roof and assessment families are closed.",
        recovery_action:
          "Reclassify from canonical source authority as physical_makesafe (or temporary_fencing when the work order explicitly carries that subtype).",
      },
    };
  }
  if (args.builder_key === "UNKNOWN") {
    return {
      ok: false,
      failure: {
        code: "builder_open_class",
        reason: "Builder has no sealed SES family-matrix row.",
        recovery_action:
          "Add an evidence-backed builder row and matrix revision; do not copy MLB defaults.",
      },
    };
  }
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === args.builder_key &&
    candidate.family === args.family
  );
  if (!row) {
    return {
      ok: false,
      failure: {
        code: "builder_open_class",
        reason:
          `${args.builder_key} has no sealed applicability row for ${args.family}.`,
        recovery_action:
          "Seal this builder-family applicability, routing, SWMS and pricing row before preparing the docket.",
      },
    };
  }
  if (
    row.family === "ordinary_roof_portal" &&
    (args.strata || args.own_template_requested)
  ) {
    return {
      ok: false,
      failure: {
        code: "family_unknown",
        reason:
          "A strata/own-template roof cannot use the ordinary Prime portal recipe.",
        recovery_action:
          "Use own_template_roof from the source-evidenced strata/own-template flags.",
      },
    };
  }
  if (
    row.family === "own_template_roof" &&
    !args.strata && !args.own_template_requested
  ) {
    return {
      ok: false,
      failure: {
        code: "family_unknown",
        reason:
          "Own-template roof requires source-evidenced strata=true or own_template_requested=true.",
        recovery_action:
          "Recover the source delivery-mode evidence or use ordinary_roof_portal.",
      },
    };
  }
  return { ok: true, row };
}

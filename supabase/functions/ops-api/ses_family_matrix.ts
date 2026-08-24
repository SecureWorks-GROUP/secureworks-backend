export const SES_FAMILY_MATRIX_VERSION =
  "ses-builder-family-matrix/2026-08-13.1";
export const SES_ASSESSMENT_RECIPE_VERSION =
  "assessment-triad-invoice-only/2026-07-27";
/** Captain 2026-08-02: repair and restoration match the physical pack path. */
export const SES_PHYSICAL_FAMILY_RECIPE_VERSION =
  "physical-labour-materials-pack/2026-08-04";

export const SES_EMERGENCY_SERVICE_FAMILIES = [
  "roof",
  "assessment",
  "makesafe",
  "restoration",
] as const;
export type SesEmergencyServiceFamily =
  (typeof SES_EMERGENCY_SERVICE_FAMILIES)[number];

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
  | "temporary_fencing"
  | "repair"
  | "restoration";

/**
 * The families that assemble on the physical labour/materials pack path: every
 * family whose AJS/AJBR row prices on `ajs_labour_materials`.
 * `isSesPhysicalShapedFamily` is the ONE predicate every consumer uses, so the
 * evidence side of a carve-out (the AJS existing-fence star pickets, derived in
 * `ses_assembler_input_adapter.ts`) can never be narrower than the pricing side
 * that consumes it — a narrower evidence gate under-bills the builder silently,
 * with no line and no blocker.
 * `temporary_fencing` is deliberately NOT here: it is a physical family with
 * its own hire/fence-labour basis, and the picket carve-out exists precisely to
 * separate a propped EXISTING fence from a temporary-fence kit.
 * `job_type` is not the discriminator — temporary fencing shares
 * `job_type: "physical_makesafe"` with this set.
 */
export const SES_PHYSICAL_SHAPED_FAMILIES = [
  "physical_makesafe",
  "repair",
  "restoration",
] as const;
export type SesPhysicalShapedFamily =
  (typeof SES_PHYSICAL_SHAPED_FAMILIES)[number];

export function isSesPhysicalShapedFamily(
  family: unknown,
): family is SesPhysicalShapedFamily {
  return (SES_PHYSICAL_SHAPED_FAMILIES as readonly string[]).includes(
    typeof family === "string" ? family : "",
  );
}

export type SesManifestJobType =
  | "physical_makesafe"
  | "roof_report"
  | "assessment_report_quote"
  | "restoration";

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
const MLB_BUNBURY = "bunbury@mlbuilders.com.au";
const AJS_WORK_ORDERS = "workorders@ajs.build";
const WESTERN_ACCOUNTS = "accounts@westernbuild.com.au";
const SYNTHETIC_INTERNAL_MAILBOX = "marnin@secureworkswa.com.au";

export const MLB_SOUTH_WEST_SUBURBS = Object.freeze(
  [
    "bunbury",
    "east bunbury",
    "south bunbury",
    "carey park",
    "withers",
    "college grove",
    "glen iris",
    "picton",
    "davenport",
    "usher",
    "pelican point",
    "busselton",
    "west busselton",
    "geographe",
    "vasse",
    "dunsborough",
    "quindalup",
    "abbey",
    "broadwater",
    "yallingup",
    "eaton",
    "australind",
    "dalyellup",
    "capel",
    "gelorup",
    "margaret river",
    "cowaramup",
    "gnarabup",
  ] as const,
);
const MLB_SOUTH_WEST_SUBURB_SET = new Set<string>(MLB_SOUTH_WEST_SUBURBS);

function canonicalSuburb(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/\s+/g, " ")
    : "";
}

function canonicalToken(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_")
    : "";
}

export function canonicalSesFamilyFromCard(args: {
  makesafe_job_family?: unknown;
  insurance_job_type?: unknown;
  strata?: unknown;
  own_template_requested?: unknown;
  report_delivery?: unknown;
}): SesFamilyId {
  const insuranceType = canonicalToken(args.insurance_job_type);
  if (
    insuranceType === "restoration" ||
    insuranceType === "restoration_work"
  ) {
    return "restoration";
  }
  const explicit = canonicalToken(args.makesafe_job_family);
  const ownTemplate = args.own_template_requested === true ||
    args.strata === true ||
    canonicalToken(args.report_delivery) === "own_document";
  switch (explicit) {
    case "restoration":
    case "restoration_work":
    case "insurance_restoration":
      return "restoration";
    case "repair":
      // Charter v1.1 (Ruling 15): repair is its own non-urgent family.
      // Pack recipe sealed 2026-08-04 on the Captain's 2026-08-02 ruling:
      // match the physical labour/materials system while keeping family id.
      return "repair";
    case "general_makesafe":
    case "physical_makesafe":
      return "physical_makesafe";
    case "temp_fence_makesafe":
    case "temporary_fencing":
    case "temp_fence":
      return "temporary_fencing";
    case "assessment_report_quote":
    case "assessment_report":
    case "assessment_quote":
    case "assessment":
      return "assessment_quote";
    case "own_template_roof":
      return "own_template_roof";
    case "ordinary_roof_portal":
    case "roof_report":
      return ownTemplate ? "own_template_roof" : "ordinary_roof_portal";
    default:
      return "unknown";
  }
}

/**
 * MLB identity used by the one shared SWMS requirement predicate. Company
 * slugs are preferable, but legacy cards may expose only the company name or
 * the MLB builder reference.
 */
export function isMakesafeMlbCompany(detail: any, job: any): boolean {
  const slug = String(
    detail?.requesting_company_slug || detail?.makesafe_companies?.slug ||
      job?.metadata?.requesting_company?.slug || "",
  ).toLowerCase();
  const name = String(
    detail?.requesting_company_name || detail?.makesafe_companies?.name ||
      job?.requesting_company_name ||
      job?.metadata?.requesting_company?.name || "",
  ).toLowerCase();
  const ref = String(
    detail?.external_ref || job?.external_ref || job?.metadata?.external_ref ||
      "",
  ).toUpperCase();
  return slug.includes("mlb") || slug.includes("ml-builders") ||
    slug.includes("major-loss") || name.includes("ml builders") ||
    name.includes("major loss") || /\bMLB[-\s]?\d/.test(ref);
}

/**
 * Captain lock: only an MLB physical MakeSafe requires SWMS for Docs Ready.
 * Roof/report-only, AJS/AJBR, repair, restoration and temporary-fence families
 * do not inherit the requirement from an artifact or a broad physical shape.
 * Unknown legacy MLB cards retain the fail-closed physical fallback until the
 * canonical family stamp is restored.
 */
export function requiresMakesafeSwms(detail: any, job: any): boolean {
  if (!isMakesafeMlbCompany(detail, job) || !!detail?.report_type) return false;

  const metadata = job?.metadata || {};
  const family = canonicalSesFamilyFromCard({
    makesafe_job_family: metadata.makesafe_job_family ?? job?.ses_family,
    insurance_job_type: metadata.insurance_job_type,
    own_template_requested: metadata.own_template_requested,
    strata: metadata.strata,
    report_delivery: metadata.report_delivery,
  });
  if (family === "unknown") return true;
  return sesFamilyRequiresSwms("MLB", family);
}

export function sesFamilyRequiresSwms(
  builderKey: SesBuilderKey,
  family: SesFamilyId,
): boolean {
  return builderKey === "MLB" && family === "physical_makesafe";
}

export function sesFamilyLabel(family: SesFamilyId): string {
  switch (family) {
    case "restoration":
      return "Restoration";
    case "repair":
      return "Repair";
    case "assessment_quote":
      return "Assessment / Quote Report";
    case "ordinary_roof_portal":
    case "own_template_roof":
      return "Roof Report";
    case "temporary_fencing":
      return "Temporary Fence MakeSafe";
    case "physical_makesafe":
      return "MakeSafe";
    default:
      return "Unknown";
  }
}

function physicalRow(
  builder_key: "MLB" | "AJS" | "AJBR" | "WESTERN",
  southWest = false,
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
    // Captain 2026-08-13: AJS/AJBR defaults to no SWMS. HRCW remains an
    // independent requirement in swmsDecision, so this waiver can never hide
    // genuinely high-risk work. Other physical builders keep the standing
    // always-required policy.
    swms_policy: ajs ? "builder_waiver_unless_hrcw" : "always",
    swms_waiver_rule: ajs ? "ajs-default-no-swms-unless-hrcw" : null,
    invoice_basis: ajs ? "ajs_labour_materials" : "standard_labour_materials",
    routing_rule: ajs
      ? "ajs-routing"
      : western
      ? "western-routing"
      : southWest
      ? "mlb-south-west-routing"
      : "mlb-perth-routing",
    invoice_to: ajs
      ? AJS_WORK_ORDERS
      : western
      ? WESTERN_ACCOUNTS
      : southWest
      ? MLB_BUNBURY
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
  southWest = false,
): SesFamilyMatrixRow {
  const base = physicalRow(builder_key, southWest);
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

/**
 * Repair and restoration pack recipes.
 *
 * Captain ruling 2026-08-02 (`data/decisions/2026-08-02-docs-ready-repair-restoration.md`):
 *   repair      — "match the whole existing system"
 *   restoration — "exactly the same as any other job, so it is a different family type"
 *
 * Same shape as temporary_fencing: keep family identity, assemble on the
 * physical labour/materials path (`job_type: physical_makesafe`), same SWMS
 * policy, same photo+report routes, no portal deliverable. Invoice basis is
 * labour/materials (not fence hire). The prepare path keys physical render /
 * photo / invoice work off `job_type === "physical_makesafe"`, so this is the
 * load-bearing choice that lets a sealed row produce a pack.
 */
function physicalShapedFamilyRow(
  family: "repair" | "restoration",
  builder_key: "MLB" | "AJS" | "AJBR" | "WESTERN",
  southWest = false,
): SesFamilyMatrixRow {
  const base = physicalRow(builder_key, southWest);
  return {
    ...base,
    family,
    named_na_rules: [
      "physical-work-has-no-portal-deliverable",
      "not-a-roof-report",
      "not-an-assessment-report",
      family === "repair"
        ? "repair-matches-physical-labour-materials-pack"
        : "restoration-matches-physical-labour-materials-pack",
    ],
  };
}

function mlbReportRow(
  family: "ordinary_roof_portal" | "own_template_roof" | "assessment_quote",
  southWest = false,
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
    routing_rule: southWest ? "mlb-south-west-routing" : "mlb-perth-routing",
    invoice_to: southWest ? MLB_BUNBURY : MLB_MAKESAFES,
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
    | "assessment_quote"
    | "repair"
    | "restoration",
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
        ...(family === "repair"
          ? ["repair-matches-physical-labour-materials-pack"]
          : family === "restoration"
          ? ["restoration-matches-physical-labour-materials-pack"]
          : []),
        "synthetic-livefire-release-forbidden",
      ],
  };
}

export const SES_FAMILY_MATRIX: readonly SesFamilyMatrixRow[] = Object.freeze([
  physicalRow("MLB"),
  physicalRow("MLB", true),
  temporaryFenceRow("MLB"),
  temporaryFenceRow("MLB", true),
  physicalShapedFamilyRow("repair", "MLB"),
  physicalShapedFamilyRow("repair", "MLB", true),
  physicalShapedFamilyRow("restoration", "MLB"),
  physicalShapedFamilyRow("restoration", "MLB", true),
  mlbReportRow("ordinary_roof_portal"),
  mlbReportRow("ordinary_roof_portal", true),
  mlbReportRow("own_template_roof"),
  mlbReportRow("own_template_roof", true),
  mlbReportRow("assessment_quote"),
  mlbReportRow("assessment_quote", true),
  physicalRow("AJS"),
  temporaryFenceRow("AJS"),
  physicalShapedFamilyRow("repair", "AJS"),
  physicalShapedFamilyRow("restoration", "AJS"),
  physicalRow("AJBR"),
  temporaryFenceRow("AJBR"),
  physicalShapedFamilyRow("repair", "AJBR"),
  physicalShapedFamilyRow("restoration", "AJBR"),
  physicalRow("WESTERN"),
  temporaryFenceRow("WESTERN"),
  physicalShapedFamilyRow("repair", "WESTERN"),
  physicalShapedFamilyRow("restoration", "WESTERN"),
  syntheticRow("physical_makesafe"),
  syntheticRow("temporary_fencing"),
  syntheticRow("repair"),
  syntheticRow("restoration"),
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
  site_suburb?: unknown;
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
  const southWest = args.builder_key === "MLB" &&
    MLB_SOUTH_WEST_SUBURB_SET.has(canonicalSuburb(args.site_suburb));
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === args.builder_key &&
    candidate.family === args.family &&
    (candidate.routing_rule === "mlb-south-west-routing") === southWest
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

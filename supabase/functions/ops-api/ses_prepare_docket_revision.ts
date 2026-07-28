import {
  artifactFromBytes,
  artifactFromText,
  canonicalSesJson,
  SES_ASSEMBLER_VERSION,
  SES_DOCKET_ENVELOPE_VERSION,
  SES_INPUT_CONTRACT_VERSION,
  SES_MANIFEST_V2_VERSION,
  type SesArtifact,
  type SesAssemblerInputV1,
  type SesBlocker,
  type SesDocketEnvelopeV3,
  type SesManifestV2,
  type SesNotApplicableState,
  type SesObligationState,
  type SesPortalCapture,
  type SesPreparedRevision,
  type SesPrepareRequest,
  type SesReadyState,
  type SesSha256,
  sesSha256,
  stableUuidFromSha256,
} from "./ses_docket_envelope.ts";
import {
  resolveSesFamilyMatrixRow,
  SES_ASSESSMENT_RECIPE_VERSION,
  SES_FAMILY_MATRIX_VERSION,
  type SesFamilyMatrixRow,
} from "./ses_family_matrix.ts";
import { makesafeReportFileName } from "./makesafe_report_render.ts";
import { roofReportPrice } from "./roof_report_template.ts";

export const SES_FIVE_MINUTES_MS = 300_000;
export { SES_ASSESSMENT_RECIPE_VERSION };

const MANIFEST_ITEMS = [
  "source_work_order_retrieval",
  "source_work_order_identity",
  "source_work_order_attachment",
  "instruction_deliverables",
  "lineage_review",
  "case_story_recovery",
  "exception_disposition",
  "hrcw_assessment",
  "swms_requirement",
  "swms_artifact",
  "builder_routing",
  "supporting_report_pdf",
  "supporting_invoice_pdf",
  "supporting_portal_links",
  "roof_report_link",
  "roof_report_capture",
  "assessment_report_link",
  "assessment_report_capture",
  "assessment_photos_link",
  "assessment_photos_capture",
  "assessment_scope_link",
  "assessment_scope_capture",
  "physical_reporting_evidence",
  "draft_builder_report_email",
  "draft_photo_evidence_email",
  "draft_invoice_bundle_email",
  "email_drafts_presented",
] as const;

type ManifestItem = (typeof MANIFEST_ITEMS)[number];

export interface SesRenderResult {
  file_name: string;
  media_type: "application/pdf";
  bytes: Uint8Array;
  render_hash?: string;
}

export interface SesSourceArtifact {
  source_pointer: string;
  file_name: string;
  media_type: string;
  bytes: Uint8Array;
}

export interface SesPhotoArtifact {
  photo_id: string;
  source_pointer: string;
  file_name: string;
  media_type: "image/jpeg" | "image/png";
  bytes: Uint8Array;
}

export interface SesPhotoProof {
  photo_id: string;
  source_pointer: string;
  file_name: string;
  media_type: "image/jpeg" | "image/png";
  content_hash: SesSha256;
  size_bytes: number;
}

async function rawPhotoSha256(bytes: Uint8Array): Promise<SesSha256> {
  const safeBytes = new Uint8Array(bytes.byteLength);
  safeBytes.set(bytes);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", safeBytes.buffer),
  );
  return `sha256:${Array.from(digest).map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
}

export interface SesPortalCaptureRequest {
  job_id: string;
  docket_id: string;
  builder_reference: string;
  role: "roof_report" | "assessment" | "photos" | "scope";
  url: string;
  idempotency_key: string;
}

export interface SesPersistPayload {
  revision: Omit<SesPreparedRevision, "timing" | "persisted" | "artifacts">;
  artifacts: SesArtifact[];
  idempotency_key: string;
  assembler_version: "ses-pack-assembler/v1";
  family_matrix_version: string;
  accepted_at: string;
  stage_durations_ms: Record<string, number>;
}

export interface SesPrepareDependencies {
  resolveInput: (
    selection: Exclude<SesPrepareRequest["selection"], { mode: "board_batch" }>,
  ) => Promise<SesAssemblerInputV1>;
  listBoardJobs?: (
    limit: number,
  ) => Promise<Array<{ mode: "job_id"; job_id: string }>>;
  resolveSourceArtifacts?: (
    input: SesAssemblerInputV1,
  ) => Promise<SesSourceArtifact[]>;
  resolvePhotoArtifacts?: (
    input: SesAssemblerInputV1,
  ) => Promise<SesPhotoArtifact[]>;
  resolvePhotoProofs?: (
    input: SesAssemblerInputV1,
  ) => Promise<SesPhotoProof[]>;
  capturePortal?: (
    request: SesPortalCaptureRequest,
  ) => Promise<SesPortalCapture>;
  renderPhysicalReport?: (
    input: SesAssemblerInputV1,
    photos?: SesPhotoArtifact[],
  ) => Promise<SesRenderResult>;
  renderOwnRoofReport?: (
    input: SesAssemblerInputV1,
  ) => Promise<SesRenderResult>;
  resolveBundledReportArtifact?: (
    input: SesAssemblerInputV1,
  ) => Promise<SesRenderResult | null>;
  resolveBundledPhotoArtifacts?: (
    input: SesAssemblerInputV1,
  ) => Promise<SesPhotoArtifact[]>;
  resolveSwmsArtifact?: (
    input: SesAssemblerInputV1,
  ) => Promise<SesRenderResult | null>;
  findCurrentRevision?: (
    jobId: string,
    inputContentHash: SesSha256,
  ) => Promise<SesPreparedRevision | null>;
  persist?: (payload: SesPersistPayload) => Promise<{ committed_at: string }>;
  now?: () => Date;
}

export interface SesPrepareResponse {
  action: "prepare_ses_docket_revision";
  assembler_version: "ses-pack-assembler/v1";
  dry_run: boolean;
  results: SesPreparedRevision[];
  timing_summary: {
    count: number;
    max_ms: number;
    p95_ms: number;
    all_within_five_minutes: boolean;
  };
}

function blocked(
  reason_code: string,
  reason: string,
  recovery_action: string,
  searches_attempted: string[] = ["canonical-input-envelope"],
  rejected_candidates: string[] = [],
  facts?: Record<string, unknown>,
): SesBlocker {
  return {
    state: "blocked",
    reason,
    reason_code,
    searches_attempted,
    rejected_candidates,
    recovery_action,
    ...(facts ? { facts } : {}),
  };
}

function ready(evidence: string): SesReadyState {
  return { state: "ready", evidence };
}

function notApplicable(rule: string): SesNotApplicableState {
  return { state: "not_applicable", rule };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && Number.isInteger(number) && number >= 0
    ? number
    : null;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.normalize("NFC")))].sort();
}

function inputBlockers(input: SesAssemblerInputV1): SesBlocker[] {
  const blockers: SesBlocker[] = [];
  if (input.classification.builder_key === "SYNTHETIC") {
    blockers.push(blocked(
      "synthetic_livefire_release_forbidden",
      "Synthetic live-fire dockets are evidence-only and can never be released, sent, signed off, or used to create an invoice.",
      "Retain the dry-run evidence and terminally account the synthetic fixture; there is no release recovery path.",
      ["synthetic-livefire-profile", "canonical-input-envelope"],
    ));
  }
  if (input.contract_version !== SES_INPUT_CONTRACT_VERSION) {
    blockers.push(
      blocked(
        "input_hash_conflict",
        `Unsupported assembler input contract ${input.contract_version}.`,
        `Supply ${SES_INPUT_CONTRACT_VERSION} from the canonical U1/U2 read model.`,
      ),
    );
  }
  const bundle = input.sibling_bundle_evidence;
  if (bundle && bundle.status !== "accepted") {
    const sibling = bundle.suspected_sibling_job_number || "(unknown sibling)";
    const invoice = bundle.suspected_invoice_number || "(unknown invoice)";
    const sharedFacts = {
      suspected_sibling_job_id: bundle.suspected_sibling_job_id,
      suspected_sibling_job_number: sibling,
      suspected_invoice_number: bundle.suspected_invoice_number,
      bundle_id: bundle.bundle_id,
      binding_revision_id: bundle.binding_revision_id,
      reverse_binding_revision_id: bundle.reverse_binding_revision_id,
      coverage_failures: bundle.coverage_failures,
    };
    if (bundle.status === "binding_missing") {
      blockers.push(blocked(
        "sibling_evidence_bundle_missing",
        `Card-local evidence is absent and suspected sibling ${sibling} (${invoice}) has no explicit bundle binding.`,
        `Create a durable, provenance-recorded binding in both directions between this card and ${sibling}; do not infer it from address or freeform notes.`,
        ["canonical-input-envelope", "sibling-bundle-binding-ledger"],
        [sibling],
        sharedFacts,
      ));
    } else if (bundle.status === "binding_not_bidirectional") {
      blockers.push(blocked(
        "sibling_evidence_bundle_not_bidirectional",
        `Sibling ${sibling} has only a one-way bundle reference, so its evidence cannot be borrowed.`,
        `Record the reverse binding under bundle ${bundle.bundle_id} with provenance, then re-run.`,
        ["canonical-input-envelope", "sibling-bundle-binding-ledger"],
        [sibling],
        sharedFacts,
      ));
    } else {
      blockers.push(blocked(
        "sibling_evidence_scope_not_covered",
        `The explicit bundle with ${sibling} does not positively prove this card's delivery and invoice scope.`,
        `Repair the exact ${invoice} line-item and delivery-artifact claim before sharing sibling evidence.`,
        [
          "canonical-input-envelope",
          "sibling-bundle-binding-ledger",
          "sibling-positive-scope-claim",
        ],
        [sibling, invoice],
        sharedFacts,
      ));
    }
  }
  if (!text(input.identity.source_instruction_id)) {
    blockers.push(
      blocked(
        "spine_missing_source",
        "Correlation spine has no source_instruction_id.",
        "Repair the U1 source accounting bind and re-run.",
      ),
    );
  }
  if (
    !text(input.identity.lineage_id) ||
    !text(input.identity.job_id) ||
    !text(input.identity.source_content_hash)
  ) {
    blockers.push(
      blocked(
        "spine_missing_lineage",
        "Correlation spine is missing lineage, job, or source content identity.",
        "Repair the U1 lineage/job authority bind and re-run.",
      ),
    );
  }
  const cycles = sortedUnique(input.attendance.attendance_cycle_ids || []);
  if (
    input.attendance.attribution !== "bound" ||
    !text(input.attendance.current_attendance_cycle_id) ||
    !cycles.includes(input.attendance.current_attendance_cycle_id)
  ) {
    blockers.push(
      blocked(
        "cycle_scope_ambiguous",
        "Current attendance cycle is not exactly bound inside the immutable cycle set.",
        "Bind the current U2/U3 attendance_cycle_id before assembling evidence.",
      ),
    );
  }
  if (
    input.classification.family_matrix_version !== SES_FAMILY_MATRIX_VERSION
  ) {
    blockers.push(
      blocked(
        "input_hash_conflict",
        `Input pins ${
          input.classification.family_matrix_version || "(blank)"
        } but assembler requires ${SES_FAMILY_MATRIX_VERSION}.`,
        "Refresh the U1/U2 assembler envelope against the current family matrix.",
      ),
    );
  }
  if (!text(input.source.builder_reference)) {
    blockers.push(
      blocked(
        "spine_missing_source",
        "Builder reference is absent from the canonical source instruction.",
        "Recover the WO/PO/external reference from the canonical source case.",
      ),
    );
  }
  if (input.classification.family === "unknown") {
    const card = text(input.identity.card_id) || text(input.identity.job_id);
    blockers.push(
      blocked(
        "family_unknown",
        `Card ${card || "(unknown)"} has no canonical family classification.`,
        "Recover the family classification from canonical source authority before preparing the docket.",
      ),
    );
  }
  if (input.classification.delivery_render_route === "unroutable") {
    blockers.push(
      blocked(
        "delivery_route_unroutable",
        input.classification.delivery_render_route_reason ||
          "The card has no sealed delivery/render route.",
        "Bind one source-backed portal or SecureWorks own-letterhead route for this builder-family relationship, then re-run.",
        [
          "canonical-input-envelope",
          ...input.classification.delivery_render_route_evidence,
        ],
        [],
        {
          builder_key: input.classification.builder_key,
          family: input.classification.family,
          delivery_render_route: input.classification.delivery_render_route,
          route_reason_code:
            input.classification.delivery_render_route_reason_code,
          route_evidence: input.classification.delivery_render_route_evidence,
        },
      ),
    );
  }
  if (!text(input.source.work_order_sender)) {
    blockers.push(
      blocked(
        "routing_evidence_missing",
        "The company routing table has no report recipient for this builder.",
        "Set the builder report recipient in makesafe_companies; do not substitute a guessed or unrelated address.",
      ),
    );
  }
  if (!input.source.attachment_pointers?.length) {
    blockers.push(
      blocked(
        "spine_missing_source",
        "The work order email has no work order attachment - ask the builder to send the work order.",
        "Recover the work order from the builder's source email, then prepare the card again.",
      ),
    );
  }
  if (!input.source.deliverables?.length) {
    blockers.push(
      blocked(
        "spine_missing_deliverables",
        "Source instruction has no typed deliverables.",
        "Complete deterministic instruction classification before pack preparation.",
      ),
    );
  }
  if (
    input.classification.family === "assessment_quote" &&
    input.classification.assessment_outbound_recipe_version !==
      SES_ASSESSMENT_RECIPE_VERSION
  ) {
    blockers.push(
      blocked(
        "input_hash_conflict",
        "The assessment card does not carry the sealed triad-and-invoice recipe.",
        "Refresh the assembler input from the current assessment family rule.",
      ),
    );
  }
  return blockers;
}

function swmsDecision(
  input: SesAssemblerInputV1,
  row: SesFamilyMatrixRow,
): {
  required: boolean;
  requirementEvidence: string;
  naRule: string | null;
} {
  if (row.report_only) {
    return {
      required: false,
      requirementEvidence:
        `rule:swms-not-required-under-named-builder-job-rule#${row.swms_waiver_rule}`,
      naRule: "report-only-has-no-physical-work",
    };
  }
  if (
    input.hrcw.hrcw ||
    input.hrcw.categories.length > 0 ||
    input.hrcw.source_hazard_terms.length > 0
  ) {
    return {
      required: true,
      requirementEvidence: "rule:hrcw-requires-swms",
      naRule: null,
    };
  }
  if (row.swms_policy === "always") {
    return {
      required: true,
      requirementEvidence: "rule:physical-work-requires-swms",
      naRule: null,
    };
  }
  if (row.swms_policy === "builder_waiver_unless_hrcw") {
    return {
      required: false,
      requirementEvidence:
        `rule:swms-not-required-under-named-builder-job-rule#${row.swms_waiver_rule}`,
      naRule: "swms-not-required-under-named-builder-job-rule",
    };
  }
  return {
    required: false,
    requirementEvidence:
      "rule:swms-not-required-under-named-builder-job-rule#western-explicit-hrcw-only",
    naRule: "swms-not-required-under-named-builder-job-rule",
  };
}

function lineItem(
  description: string,
  quantity: number,
  unitPriceExGst: number,
): Record<string, unknown> {
  return {
    description,
    quantity,
    unit_price_ex_gst: unitPriceExGst,
    amount_ex_gst: Math.round(quantity * unitPriceExGst * 100) / 100,
  };
}

function localInvoiceProposal(
  input: SesAssemblerInputV1,
  row: SesFamilyMatrixRow,
): {
  proposal: Record<string, unknown> | null;
  blocker: SesBlocker | null;
} {
  const facts = input.cycle_facts.hours_and_materials || {};
  const ref = input.source.builder_reference;
  if (!text(ref)) {
    return {
      proposal: null,
      blocker: blocked(
        "invoice_reference_missing",
        "A local invoice proposal requires a non-empty builder WO/PO reference.",
        "Recover the canonical builder reference before assembling any invoice line.",
      ),
    };
  }
  if (row.invoice_basis === "roof_storey_fixed") {
    const storey = facts.storeys ??
      input.cycle_facts.roof_report_fields?.storeys;
    try {
      const price = roofReportPrice(storey);
      return {
        proposal: {
          version: "ses-local-invoice-proposal/v1",
          builder_reference: ref,
          basis: row.invoice_basis,
          storeys: price.storey,
          line_items: [
            lineItem(
              `${ref} - ${price.storey_label} roof report`,
              1,
              price.ex_gst,
            ),
          ],
          subtotal_ex_gst: price.ex_gst,
          gst: price.inc_gst - price.ex_gst,
          total_inc_gst: price.inc_gst,
          xero_identity: null,
        },
        blocker: null,
      };
    } catch {
      return {
        proposal: null,
        blocker: blocked(
          "pricing_evidence_missing",
          "Roof report pricing requires an explicit single/double storey fact.",
          "Record the source-evidenced storey classification and re-run.",
        ),
      };
    }
  }
  if (row.invoice_basis === "assessment_fixed") {
    if (typeof facts.fence_only !== "boolean") {
      return {
        proposal: null,
        blocker: blocked(
          "pricing_evidence_missing",
          "Assessment pricing requires an explicit fence_only true/false fact.",
          "Record the typed assessment fence-only fact before selecting the $130 or $150 ex-GST price.",
        ),
      };
    }
    const fenceOnly = facts.fence_only;
    const ex = fenceOnly ? 130 : 150;
    return {
      proposal: {
        version: "ses-local-invoice-proposal/v1",
        builder_reference: ref,
        basis: row.invoice_basis,
        fence_only: fenceOnly,
        line_items: [
          lineItem(
            `${ref} - ${
              fenceOnly ? "Fence-only " : ""
            }assessment report and quote`,
            1,
            ex,
          ),
        ],
        subtotal_ex_gst: ex,
        gst: ex * 0.1,
        total_inc_gst: ex * 1.1,
        xero_identity: null,
      },
      blocker: null,
    };
  }

  const trades = nonNegativeInteger(facts.trades);
  const hoursPerTrade = positiveNumber(facts.hours_per_trade);
  const canonicalRate = row.invoice_basis === "ajs_labour_materials" ||
      row.invoice_basis === "ajs_temporary_fence_labour_only"
    ? 80
    : 85;
  const minimum = row.family === "temporary_fencing" && trades === 1
    ? 4
    : canonicalRate === 80
    ? 2
    : 3;
  if (
    trades === null ||
    trades < 1 ||
    hoursPerTrade === null ||
    hoursPerTrade < minimum
  ) {
    return {
      proposal: null,
      blocker: blocked(
        "pricing_evidence_missing",
        `Typed labour facts are incomplete or below the sealed ${minimum}-hour per-trade floor.`,
        "Record trades and evidenced billable hours per trade; do not infer them from prose.",
      ),
    };
  }
  const suppliedRate = facts.rate_ex_gst == null
    ? canonicalRate
    : positiveNumber(facts.rate_ex_gst);
  if (suppliedRate !== canonicalRate) {
    return {
      proposal: null,
      blocker: blocked(
        "pricing_evidence_missing",
        `Rate ${
          String(
            facts.rate_ex_gst,
          )
        } does not match the sealed $${canonicalRate} ex GST schedule.`,
        "Attach a line-specific audited rate override or use the canonical rate.",
      ),
    };
  }

  const lines: Array<Record<string, unknown>> = [
    lineItem(
      `${ref} - ${
        row.family === "temporary_fencing"
          ? "temporary fencing make-safe"
          : "make-safe attendance"
      } - ${trades} trade${trades === 1 ? "" : "s"} x ${hoursPerTrade} hours`,
      trades * hoursPerTrade,
      canonicalRate,
    ),
  ];
  if (row.family === "temporary_fencing") {
    const panelCount = nonNegativeInteger(facts.panel_count);
    const baseCount = nonNegativeInteger(facts.base_count);
    if (panelCount === null || panelCount < 1 || baseCount === null) {
      return {
        proposal: null,
        blocker: blocked(
          "pricing_evidence_missing",
          "Temporary fencing requires typed panel and base counts.",
          "Record panel_count and base_count from trade/source evidence.",
        ),
      };
    }
    if (
      row.invoice_basis === "mlb_temporary_fence_hire" ||
      row.invoice_basis === "western_temporary_fence_hire"
    ) {
      const pickets = nonNegativeInteger(facts.star_picket_count);
      if (pickets === null) {
        return {
          proposal: null,
          blocker: blocked(
            "pricing_evidence_missing",
            "Hire-card temporary fencing requires an explicit star-picket count, including zero.",
            "Record star_picket_count as a typed integer.",
          ),
        };
      }
      lines.push(
        lineItem(
          `${ref} - Temporary fencing retrieval, collection and loading allowance - 2 hours`,
          2,
          90,
        ),
        lineItem(
          `${ref} - Temporary fence hire: ${panelCount} panels x $5 per panel per week x 12 weeks`,
          12,
          panelCount * 5,
        ),
      );
      if (pickets > 0) {
        lines.push(
          lineItem(
            `${ref} - Star pickets supplied for temporary fencing make-safe`,
            pickets,
            13.5,
          ),
        );
      }
      lines.push(lineItem(`${ref} - Cable ties and small consumables`, 1, 25));
    }
  } else {
    const materials = Array.isArray(facts.materials) ? facts.materials : [];
    for (const raw of materials) {
      const material = raw && typeof raw === "object"
        ? (raw as Record<string, unknown>)
        : {};
      const description = text(material.description);
      const quantity = positiveNumber(material.quantity);
      const unitPrice = positiveNumber(material.unit_price_ex_gst);
      if (!description || quantity === null || unitPrice === null) {
        return {
          proposal: null,
          blocker: blocked(
            "pricing_evidence_missing",
            "A material proposal line lacks typed description, quantity or approved ex-GST unit price.",
            "Record material facts from source/trade evidence or remove the unsupported line.",
          ),
        };
      }
      lines.push(lineItem(`${ref} - ${description}`, quantity, unitPrice));
    }
  }
  const subtotal = Math.round(
    lines.reduce((sum, line) => sum + Number(line.amount_ex_gst || 0), 0) *
      100,
  ) / 100;
  return {
    proposal: {
      version: "ses-local-invoice-proposal/v1",
      builder_reference: ref,
      basis: row.invoice_basis,
      line_items: lines,
      subtotal_ex_gst: subtotal,
      gst: Math.round(subtotal * 10) / 100,
      total_inc_gst: Math.round(subtotal * 110) / 100,
      xero_identity: null,
    },
    blocker: null,
  };
}

function initialManifestItems(): Record<ManifestItem, SesObligationState> {
  return Object.fromEntries(
    MANIFEST_ITEMS.map((item) => [
      item,
      blocked(
        "recovery-not-run",
        "Evidence not recorded.",
        `Complete ${item} and record its evidence pointer.`,
      ),
    ]),
  ) as Record<ManifestItem, SesObligationState>;
}

const SPINE_MANIFEST_ITEMS = [
  "source_work_order_retrieval",
  "source_work_order_identity",
  "source_work_order_attachment",
  "instruction_deliverables",
  "lineage_review",
  "case_story_recovery",
  "exception_disposition",
  "hrcw_assessment",
  "swms_requirement",
] as const satisfies readonly ManifestItem[];

function routingBlocker(
  input: SesAssemblerInputV1,
  row: SesFamilyMatrixRow,
): SesBlocker | null {
  const missing: string[] = [];
  if (
    row.report_route === "work_order_sender" &&
    !input.source.work_order_sender
  ) {
    missing.push("makesafe_companies.report_recipient");
  }
  if (
    row.photo_route === "work_order_sender" &&
    !input.source.work_order_sender
  ) {
    missing.push("makesafe_companies.report_recipient");
  }
  if (row.invoice_route === "matrix_invoice_mailbox" && !row.invoice_to) {
    missing.push("sealed matrix invoice_to");
  }
  if (!missing.length) return null;
  return blocked(
    "routing_evidence_missing",
    `The sealed routing sources are incomplete: ${
      [...new Set(missing)].join(
        ", ",
      )
    }.`,
    "Complete the company routing table or seal the matrix row; never default an address.",
    ["makesafe_companies", `family-matrix:${SES_FAMILY_MATRIX_VERSION}`],
  );
}

function applySpineBlocker(manifest: SesManifestV2, blocker: SesBlocker): void {
  for (const item of SPINE_MANIFEST_ITEMS) {
    manifest.items[item] = blocker;
  }
  manifest.deliverables = manifest.deliverables.map((deliverable) => ({
    ...deliverable,
    completion: blocker,
  }));
}

function spineFactsComplete(input: SesAssemblerInputV1): boolean {
  return (
    !!text(input.identity.source_instruction_id) &&
    !!text(input.identity.lineage_id) &&
    /^sha256:[0-9a-f]{64}$/.test(text(input.identity.source_content_hash)) &&
    !!text(input.identity.job_id) &&
    !!text(input.source.builder_reference) &&
    input.source.attachment_pointers.length > 0 &&
    input.source.deliverables.length > 0 &&
    input.source.deliverables.every((deliverable) => !!text(deliverable.id))
  );
}

function markSpineEvidenceReady(
  manifest: SesManifestV2,
  input: SesAssemblerInputV1,
  swms: ReturnType<typeof swmsDecision>,
  sourcePaths: string[],
): void {
  manifest.items.source_work_order_retrieval = ready(
    `spine:source/${encodeURIComponent(input.identity.source_instruction_id)}`,
  );
  manifest.items.source_work_order_identity = ready(
    `spine:lineage/${encodeURIComponent(input.identity.lineage_id)}#job/${
      encodeURIComponent(
        input.identity.job_id,
      )
    }#hash/${input.identity.source_content_hash}#reference/${
      encodeURIComponent(
        input.source.builder_reference,
      )
    }`,
  );
  manifest.items.source_work_order_attachment = ready(
    `files:${sourcePaths.join(",")}`,
  );
  manifest.items.instruction_deliverables = ready(
    `spine:deliverables/${
      input.source.deliverables
        .map((deliverable) => encodeURIComponent(deliverable.id))
        .join(",")
    }`,
  );
  manifest.items.lineage_review = input.classification.lineage_kind === "none"
    ? notApplicable("no-related-docket-detected")
    : ready("file:case_story.json#lineage");
  manifest.items.case_story_recovery = ready("file:case_story.json");
  manifest.items.exception_disposition =
    input.classification.workflow === "active"
      ? notApplicable("ordinary-active-docket")
      : input.classification.workflow === "revision"
      ? notApplicable("ordinary-revision-docket")
      : blocked(
        "recovery-not-run",
        `${input.classification.workflow} requires a structured authority decision.`,
        "Record the workflow-compatible decision before review.",
      );
  manifest.items.hrcw_assessment = ready("file:case_story.json#hrcw");
  manifest.items.swms_requirement = ready(swms.requirementEvidence);
  manifest.deliverables = input.source.deliverables.map((deliverable) => ({
    ...deliverable,
    completion: ready(
      `spine:deliverable/${encodeURIComponent(deliverable.id)}`,
    ),
  }));
}

function hardStopManifest(
  input: SesAssemblerInputV1,
  applicabilityBlocker: SesBlocker,
): SesManifestV2 {
  const items = Object.fromEntries(
    MANIFEST_ITEMS.map((item) => [item, applicabilityBlocker]),
  ) as Record<ManifestItem, SesObligationState>;
  return {
    version: SES_MANIFEST_V2_VERSION,
    docket_id: input.identity.job_number || input.identity.job_id,
    classification: {
      workflow: input.classification.workflow,
      builder_key: input.classification.builder_key,
      family: input.classification.family,
      job_type: input.classification.family === "restoration"
        ? "restoration"
        : "unknown",
      recipe_selected: false,
      delivery_render_route: input.classification.delivery_render_route,
      delivery_render_route_reason_code:
        input.classification.delivery_render_route_reason_code,
      delivery_render_route_reason:
        input.classification.delivery_render_route_reason,
      delivery_render_route_evidence:
        input.classification.delivery_render_route_evidence,
      builder_reference: input.source.builder_reference,
      lineage: input.classification.lineage_kind,
    },
    routing: {
      builder: input.classification.builder_label,
      report_to: "",
      photo_to: "",
      invoice_to: "",
    },
    items,
    deliverables: input.source.deliverables.map((deliverable) => ({
      ...deliverable,
      completion: applicabilityBlocker,
    })),
  };
}

function manifestBase(
  input: SesAssemblerInputV1,
  row: SesFamilyMatrixRow,
  swms: ReturnType<typeof swmsDecision>,
): SesManifestV2 {
  const items = initialManifestItems();
  const routeFailure = routingBlocker(input, row);
  items.builder_routing = routeFailure ||
    ready(
      `company:${input.source.work_order_sender || "not-required"}#matrix:${
        row.invoice_to || "not-required"
      }#rule:${row.routing_rule}`,
    );
  items.supporting_invoice_pdf = blocked(
    "recovery-not-run",
    "Pre-Xero review carries a local proposal, never a Xero PDF.",
    "After Captain invoice-create approval, U5/U6 creates and binds the real invoice PDF.",
  );

  if (row.job_type !== "roof_report") {
    items.roof_report_link = notApplicable("not-a-roof-report");
    items.roof_report_capture = notApplicable("not-a-roof-report");
  }
  if (row.job_type !== "assessment_report_quote") {
    for (
      const item of [
        "assessment_report_link",
        "assessment_report_capture",
        "assessment_photos_link",
        "assessment_photos_capture",
        "assessment_scope_link",
        "assessment_scope_capture",
      ] as ManifestItem[]
    ) {
      items[item] = notApplicable("not-an-assessment-report");
    }
  }
  if (row.job_type !== "physical_makesafe") {
    items.physical_reporting_evidence = notApplicable(
      "report-only-has-no-physical-reporting-evidence",
    );
    items.draft_photo_evidence_email = notApplicable(
      "report-only-has-no-photo-email",
    );
  }
  if (row.job_type === "physical_makesafe") {
    items.supporting_portal_links = notApplicable(
      "physical-work-has-no-portal-deliverable",
    );
  }
  if (row.family === "ordinary_roof_portal") {
    items.supporting_report_pdf = notApplicable(
      "report-only-portal-is-the-report",
    );
    items.draft_builder_report_email = notApplicable("portal-is-the-report");
  }
  if (row.family === "assessment_quote") {
    items.supporting_report_pdf = notApplicable(
      "assessment-portal-is-the-report",
    );
    items.draft_builder_report_email = notApplicable(
      "assessment-prime-triad-is-the-report",
    );
  }
  if (row.family === "own_template_roof") {
    items.supporting_portal_links = notApplicable(
      "own-document-has-no-portal-deliverable",
    );
    items.roof_report_link = notApplicable("roof-report-on-own-letterhead");
    items.roof_report_capture = notApplicable("roof-report-on-own-letterhead");
  }
  if (!swms.required && swms.naRule) {
    items.swms_artifact = notApplicable(swms.naRule);
  }

  return {
    version: SES_MANIFEST_V2_VERSION,
    docket_id: input.identity.job_number || input.identity.job_id,
    classification: {
      workflow: input.classification.workflow,
      builder_key: row.builder_key,
      family: row.family,
      job_type: row.job_type,
      subtype: row.subtype,
      recipe_selected: true,
      delivery_render_route: input.classification.delivery_render_route,
      delivery_render_route_reason_code:
        input.classification.delivery_render_route_reason_code,
      delivery_render_route_reason:
        input.classification.delivery_render_route_reason,
      delivery_render_route_evidence:
        input.classification.delivery_render_route_evidence,
      ...(row.report_delivery ? { report_delivery: row.report_delivery } : {}),
      ...(row.family === "assessment_quote"
        ? {
          assessment_outbound_recipe_version: SES_ASSESSMENT_RECIPE_VERSION,
        }
        : {}),
      builder_reference: input.source.builder_reference,
      report_only: row.report_only,
      lineage: input.classification.lineage_kind,
      swms_required: swms.required,
      hrcw: input.hrcw.hrcw,
      hrcw_categories: [...input.hrcw.categories],
      source_hazard_terms: [...input.hrcw.source_hazard_terms],
      required_deliverable_ids: input.source.deliverables.map(
        (item) => item.id,
      ),
    },
    routing: {
      builder: input.classification.builder_label,
      report_to: row.report_route === "work_order_sender"
        ? input.source.work_order_sender || ""
        : "",
      photo_to: row.photo_route === "work_order_sender"
        ? input.source.work_order_sender || ""
        : "",
      invoice_to: row.invoice_to || "",
    },
    items,
    deliverables: input.source.deliverables.map((deliverable) => ({
      ...deliverable,
      completion: blocked(
        "recovery-not-run",
        "Deliverable identity has not been proven against the complete correlation spine.",
        "Recover the exact source, lineage, content hash, builder reference and source attachment.",
      ),
    })),
  };
}

function addBlocker(blockers: SesBlocker[], blocker: SesBlocker): SesBlocker {
  if (
    !blockers.some(
      (candidate) =>
        candidate.reason_code === blocker.reason_code &&
        candidate.reason === blocker.reason,
    )
  ) {
    blockers.push(blocker);
  }
  return blocker;
}

function portalRoleItems(
  role: "roof_report" | "assessment" | "photos" | "scope",
): [ManifestItem, ManifestItem] {
  if (role === "roof_report") {
    return ["roof_report_link", "roof_report_capture"];
  }
  if (role === "assessment") {
    return ["assessment_report_link", "assessment_report_capture"];
  }
  if (role === "photos") {
    return ["assessment_photos_link", "assessment_photos_capture"];
  }
  return ["assessment_scope_link", "assessment_scope_capture"];
}

function inputPortalRole(
  role: SesAssemblerInputV1["source"]["portal_links"][number]["role"],
): "roof_report" | "assessment" | "photos" | "scope" | "other" {
  if (role === "quote") return "scope";
  if (role === "builder_portal") return "other";
  return role;
}

function portalRoleCardLabel(
  role: "roof_report" | "assessment" | "photos" | "scope",
): string {
  if (role === "assessment") return "assessment";
  if (role === "photos") return "photos";
  if (role === "scope") return "quote/scope";
  return "roof report";
}

function isValidContentFingerprint(value: unknown): value is SesSha256 {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function captureBlocker(capture: SesPortalCapture): SesBlocker | null {
  const role = capture.role === "assessment"
    ? "assessment"
    : capture.role === "photos"
    ? "photos"
    : capture.role === "scope"
    ? "quote/scope"
    : "roof report";
  if (capture.status === "done") {
    if (!isValidContentFingerprint(capture.content_fingerprint)) {
      return blocked(
        "portal_capture_invalid",
        `The ${role} capture returned done without a valid content fingerprint.`,
        "Re-run the approved portal capture and retain a valid content fingerprint.",
        [`portal-capture:${capture.role}`],
      );
    }
    return null;
  }
  if (capture.status === "not_done") {
    return blocked(
      "portal_not_submitted",
      `The builder's ${role} form is not submitted and locked: ${
        capture.signal || "no locked/submitted banner"
      }.`,
      `Ask the trade to finish the ${role} form in Prime, then run the headless capture again.`,
      [`portal-capture:${capture.role}`],
    );
  }
  return blocked(
    "portal_unreachable",
    /expired|no longer active|no longer available/i.test(capture.signal || "")
      ? `The builder's ${role} link is expired - ask the builder to send a fresh ${role} link.`
      : `The builder's ${role} link could not be opened - ask the builder to send a working ${role} link.`,
    `Recover the ${role} link, then run the headless capture again.`,
    [`portal-capture:${capture.role}`],
  );
}

function draftEmail(args: {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  attachments: string[];
}): string {
  return [
    `To: ${args.to}`,
    `Cc: ${args.cc || ""}`,
    `Subject: ${args.subject}`,
    `Attachments: ${args.attachments.join(", ")}`,
    "",
    args.body,
  ].join("\n");
}

function buildEmailDrafts(
  input: SesAssemblerInputV1,
  row: SesFamilyMatrixRow,
  reportFile: string | null,
  swmsFile: string | null,
  photoFiles: string[],
  invoiceProposal: Record<string, unknown> | null,
): Record<string, string> {
  if (!invoiceProposal) {
    return {};
  }
  const ref = input.source.builder_reference;
  const address = [input.source.site_address, input.source.site_suburb]
    .filter(Boolean)
    .join(", ");
  const reportTo = input.source.work_order_sender || "";
  const invoiceTo = row.invoice_to || "";
  const invoiceAttachments = [
    "ARTIFACTS/invoice_proposal.json",
    ...(reportFile ? [reportFile] : []),
    ...(swmsFile ? [swmsFile] : []),
  ];
  if (row.family === "assessment_quote") {
    return {
      INVOICE_EMAIL_DRAFT: draftEmail({
        to: invoiceTo,
        cc: "finance@secureworkswa.com.au",
        subject: `${ref} - assessment report and quote invoice`,
        body:
          "Draft only. The assessment, photo schedule and quote have been completed and submitted through Prime. Please find our invoice attached. No SWMS, local report or separate photo pack applies to this assessment card.",
        attachments: ["ARTIFACTS/invoice_proposal.json"],
      }),
    };
  }
  if (row.family !== "ordinary_roof_portal" && !reportFile) {
    return {};
  }
  const invoice = draftEmail({
    to: invoiceTo,
    cc: "finance@secureworkswa.com.au",
    subject: `${ref} - invoice proposal`,
    body:
      "Draft only. This docket contains a local invoice proposal. No Xero object exists and no release is approved.",
    attachments: invoiceAttachments,
  });
  const drafts: Record<string, string> = { INVOICE_EMAIL_DRAFT: invoice };
  if (reportFile) {
    drafts.REPORT_EMAIL_DRAFT = draftEmail({
      to: reportTo,
      subject: `${ref} - ${row.family.replaceAll("_", " ")}`,
      body: `Draft only. Please find the prepared ${
        row.family.replaceAll(
          "_",
          " ",
        )
      } evidence for ${address || "the instructed property"}.`,
      attachments: [reportFile],
    });
  }
  if (row.photo_route === "work_order_sender" && photoFiles.length > 0) {
    drafts.PHOTO_EMAIL_DRAFT = draftEmail({
      to: reportTo,
      subject: `Photo Evidence - ${ref}`,
      body:
        "Draft only. The complete, ordered original photo set is listed on the docket.",
      attachments: photoFiles,
    });
  }
  return drafts;
}

function reviewHtml(
  input: SesAssemblerInputV1,
  family: string,
  blockers: SesBlocker[],
  drafts: Record<string, string>,
): string {
  const escape = (value: unknown) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${
    escape(
      input.source.builder_reference,
    )
  } SES docket</title></head>
<body data-assembler="${SES_ASSEMBLER_VERSION}">
<main><h1>${escape(input.source.builder_reference)}</h1>
<p>Family: ${escape(family)}</p>
<p>State: ${blockers.length ? "BLOCKED" : "PRE-XERO DOCS READY"}</p>
<section id="blockers"><h2>Blockers</h2><pre>${
    escape(
      canonicalSesJson(blockers),
    )
  }</pre></section>
<section id="email-drafts"><h2>Email drafts</h2>${
    Object.entries(drafts)
      .map(
        ([name, body]) =>
          `<article><h3>${escape(name)}</h3><pre>${
            escape(body)
          }</pre></article>`,
      )
      .join("")
  }</section>
</main></body></html>`;
}

function validatePreXero(
  manifest: SesManifestV2,
  proposal: Record<string, unknown> | null,
  artifacts: SesArtifact[],
  blockers: SesBlocker[],
): boolean {
  if (blockers.length || !proposal) return false;
  const required = MANIFEST_ITEMS.filter(
    (name) => name !== "supporting_invoice_pdf",
  );
  if (required.some((name) => manifest.items[name]?.state === "blocked")) {
    return false;
  }
  if (!artifacts.some((artifact) => artifact.role === "invoice_proposal")) {
    return false;
  }
  return true;
}

function responseSummary(results: SesPreparedRevision[]) {
  const values = results
    .map((result) => result.timing.duration_ms)
    .sort((a, b) => a - b);
  const index = values.length
    ? Math.max(0, Math.ceil(values.length * 0.95) - 1)
    : 0;
  return {
    count: values.length,
    max_ms: values.length ? values[values.length - 1] : 0,
    p95_ms: values.length ? values[index] : 0,
    all_within_five_minutes: results.every(
      (result) => result.timing.within_five_minutes,
    ),
  };
}

function validateRequest(request: SesPrepareRequest): void {
  if (request.assembler_version !== SES_ASSEMBLER_VERSION) {
    throw new TypeError(`assembler_version must be ${SES_ASSEMBLER_VERSION}`);
  }
  if (!text(request.idempotency_key)) {
    throw new TypeError("idempotency_key is required");
  }
  const mode = request.selection?.mode;
  if (mode === "job_id") {
    if (
      !text(request.selection.job_id) ||
      request.selection.job_number ||
      request.selection.limit
    ) {
      throw new TypeError("job_id selection requires only job_id");
    }
    return;
  }
  if (mode === "job_number") {
    if (
      !text(request.selection.job_number) ||
      request.selection.job_id ||
      request.selection.limit
    ) {
      throw new TypeError("job_number selection requires only job_number");
    }
    return;
  }
  if (mode === "board_batch") {
    const limit = Number(request.selection.limit);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      request.selection.job_id ||
      request.selection.job_number
    ) {
      throw new TypeError("board_batch requires limit between 1 and 50");
    }
    return;
  }
  throw new TypeError("selection.mode is invalid");
}

async function prepareOne(
  request: SesPrepareRequest,
  selection:
    | { mode: "job_id"; job_id: string }
    | {
      mode: "job_number";
      job_number: string;
    },
  deps: SesPrepareDependencies,
): Promise<SesPreparedRevision> {
  const now = deps.now || (() => new Date());
  const acceptedAt = now();
  const stagesMs: Record<string, number> = {};
  const degradedCapabilities: string[] = [];
  const measure = async <T>(
    stage: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const started = now().getTime();
    try {
      return await fn();
    } finally {
      stagesMs[stage] = Math.max(0, now().getTime() - started);
    }
  };

  stagesMs.T0 = 0;
  const input = await measure("T1", () => deps.resolveInput(selection));
  const blockers = inputBlockers(input);
  const inputContentHash = await sesSha256(input);
  if (!request.force_refresh && deps.findCurrentRevision) {
    const current = await deps.findCurrentRevision(
      input.identity.job_id,
      inputContentHash,
    );
    if (current) return current;
  }

  const matrix = resolveSesFamilyMatrixRow({
    builder_key: input.classification.builder_key,
    family: input.classification.family,
    strata: input.classification.strata,
    own_template_requested: input.classification.own_template_requested,
  });
  stagesMs.T2 = 0;
  let applicabilityBlocker: SesBlocker | null = null;
  if (!matrix.ok) {
    applicabilityBlocker = addBlocker(
      blockers,
      blocked(
        matrix.failure.code,
        matrix.failure.reason,
        matrix.failure.recovery_action,
        ["canonical-input-envelope", "sealed-family-matrix"],
        [],
        matrix.failure.code === "restoration_recipe_unsealed"
          ? {
            job_id: input.identity.job_id,
            job_number: input.identity.job_number,
            card_id: input.identity.card_id,
            builder_reference: input.source.builder_reference,
            site_address: input.source.site_address,
            site_suburb: input.source.site_suburb,
            builder_key: input.classification.builder_key,
            family: input.classification.family,
            subtype: input.classification.subtype,
            workflow: input.classification.workflow,
            source_instruction_id: input.identity.source_instruction_id,
            current_attendance_cycle_id:
              input.attendance.current_attendance_cycle_id,
            cycle_number: input.attendance.cycle_number,
          }
          : undefined,
      ),
    );
  }
  const row = matrix.ok ? matrix.row : null;
  if (
    matrix.ok &&
    (input.classification.report_only !== matrix.row.report_only ||
      input.classification.report_delivery !== matrix.row.report_delivery ||
      input.classification.subtype !== matrix.row.subtype ||
      (input.classification.family === "temporary_fencing" &&
        input.classification.subtype !== "temporary_fencing"))
  ) {
    addBlocker(
      blockers,
      blocked(
        "input_hash_conflict",
        "The input classification fields do not match the sealed builder-family matrix row.",
        "Refresh the versioned U1/U2 assembler envelope; do not repair classification inside U4.",
      ),
    );
  }
  if (!request.dry_run && !deps.persist) {
    degradedCapabilities.push("docket_persistence");
    addBlocker(
      blockers,
      blocked(
        "capability_board_fatal",
        "Draft revision persistence capability is unavailable.",
        "Resume with the append-only makesafe_docket_revisions persistence adapter.",
      ),
    );
  }

  const swms = row ? swmsDecision(input, row) : null;
  const manifest = row && swms
    ? manifestBase(input, row, swms)
    : hardStopManifest(input, applicabilityBlocker!);
  if (row) {
    const routeFailure = routingBlocker(input, row);
    if (
      routeFailure &&
      !blockers.some(
        (candidate) => candidate.reason_code === routeFailure.reason_code,
      )
    ) {
      addBlocker(blockers, routeFailure);
    }
  }
  const inputSpineBlocker = blockers.find(
    (candidate) =>
      candidate.reason_code === "spine_missing_lineage" ||
      candidate.reason_code === "spine_missing_source" ||
      candidate.reason_code === "spine_missing_deliverables",
  );
  if (row && inputSpineBlocker) {
    applySpineBlocker(manifest, inputSpineBlocker);
  }
  const artifacts: SesArtifact[] = [];
  const portalEvidence: SesPortalCapture[] = [];
  let reportFile: string | null = null;
  let swmsFile: string | null = null;
  const photoFiles: string[] = [];

  await measure("T3", async () => {
    if (!row || !swms) return;
    if (!deps.resolveSourceArtifacts) {
      const sourceBlocker = addBlocker(
        blockers,
        blocked(
          "spine_missing_source",
          "Source attachment recovery capability is unavailable.",
          "Resume with the canonical U1 case-source attachment adapter.",
        ),
      );
      manifest.items.source_work_order_retrieval = sourceBlocker;
      manifest.items.source_work_order_attachment = sourceBlocker;
      return;
    }
    const resolved = await deps.resolveSourceArtifacts(input);
    const expected = new Set(input.source.attachment_pointers);
    const recovered = new Set(
      resolved.map((artifact) => artifact.source_pointer),
    );
    const missing = [...expected].filter((pointer) => !recovered.has(pointer));
    let recoveryComplete = !missing.length &&
      resolved.length === expected.size && expected.size > 0;
    const sourcePaths: string[] = [];
    if (missing.length) {
      const sourceBlocker = addBlocker(
        blockers,
        blocked(
          "spine_missing_source",
          `Canonical source recovery did not return ${missing.length} referenced attachment(s).`,
          "Recover every designated source attachment from the exact U1 case-source ledger.",
          ["canonical-input-envelope", "case-source-attachment-ledger"],
          missing,
        ),
      );
      manifest.items.source_work_order_retrieval = sourceBlocker;
      manifest.items.source_work_order_attachment = sourceBlocker;
    }
    for (const source of resolved) {
      if (
        !expected.has(source.source_pointer) ||
        !text(source.file_name) ||
        source.file_name.includes("/") ||
        source.file_name.includes("..") ||
        !source.bytes.byteLength
      ) {
        recoveryComplete = false;
        const sourceBlocker = addBlocker(
          blockers,
          blocked(
            "spine_missing_source",
            "Recovered source artifact did not match a designated pointer or safe file name.",
            "Reject the artifact and re-read the exact U1 case-source attachment.",
            ["case-source-attachment-ledger"],
            [source.source_pointer],
          ),
        );
        manifest.items.source_work_order_retrieval = sourceBlocker;
        manifest.items.source_work_order_attachment = sourceBlocker;
        continue;
      }
      const sourcePath = `SOURCE/${source.file_name}`;
      sourcePaths.push(sourcePath);
      artifacts.push(
        await artifactFromBytes({
          role: "source_attachment",
          path: sourcePath,
          media_type: source.media_type,
          bytes: source.bytes,
          metadata: { source_pointer: source.source_pointer },
        }),
      );
    }
    if (
      recoveryComplete &&
      sourcePaths.length === expected.size &&
      new Set(sourcePaths).size === sourcePaths.length &&
      spineFactsComplete(input)
    ) {
      markSpineEvidenceReady(manifest, input, swms, sourcePaths.sort());
    }
  });

  await measure("T4", async () => {
    if (
      !row ||
      input.classification.delivery_render_route !== "builder_portal"
    ) return;
    for (const role of row.required_portal_roles) {
      const matches = input.source.portal_links.filter(
        (link) => inputPortalRole(link.role) === role,
      );
      const [linkItem, captureItem] = portalRoleItems(role);
      if (matches.length !== 1) {
        const code = matches.length
          ? "portal_wrong_reference"
          : "portal_link_absent";
        const itemBlocker = addBlocker(
          blockers,
          blocked(
            code,
            matches.length
              ? `Portal role ${role} has ${matches.length} candidates; exactly one is required.`
              : `The work order email contains no ${
                portalRoleCardLabel(
                  role,
                )
              } link - ask the builder to send it.`,
            `Recover and bind exactly one typed ${
              portalRoleCardLabel(
                role,
              )
            } link from the source instruction.`,
            ["canonical-input-envelope", `portal-role:${role}`],
            matches.map((link) => link.url),
          ),
        );
        manifest.items[linkItem] = itemBlocker;
        manifest.items[captureItem] = itemBlocker;
        continue;
      }
      const link = matches[0];
      manifest.items[linkItem] = ready(`url:${link.url}`);
      if (!deps.capturePortal) {
        degradedCapabilities.push("portal_capture");
        const itemBlocker = addBlocker(
          blockers,
          blocked(
            "capability_portal_degraded",
            "Headless portal capture capability is unavailable.",
            "Resume on the approved capture_portal_evidence runner; never infer portal state.",
            [`portal-role:${role}`],
          ),
        );
        manifest.items[captureItem] = itemBlocker;
        continue;
      }
      let capture: SesPortalCapture;
      try {
        capture = await deps.capturePortal({
          job_id: input.identity.job_id,
          docket_id: manifest.docket_id,
          builder_reference: input.source.builder_reference,
          role,
          url: link.url,
          idempotency_key: `${request.idempotency_key}:portal:${role}`,
        });
      } catch (error) {
        capture = {
          status: "unreachable",
          role,
          url: link.url,
          docket_id: manifest.docket_id,
          job_id: input.identity.job_id,
          builder_reference: input.source.builder_reference,
          captured_at: now().toISOString(),
          content_fingerprint: await sesSha256({
            role,
            url: link.url,
            error: error instanceof Error ? error.message : String(error),
          }),
          idempotency_key: `${request.idempotency_key}:portal:${role}`,
          signal: error instanceof Error ? error.message : String(error),
        };
      }
      const screenshotBytes = capture.screenshot_bytes;
      const { screenshot_bytes: _discardedScreenshotBytes, ...captureRecord } =
        capture;
      portalEvidence.push(captureRecord);
      if (
        capture.role !== role ||
        capture.url !== link.url ||
        capture.job_id !== input.identity.job_id ||
        capture.docket_id !== manifest.docket_id ||
        capture.builder_reference !== input.source.builder_reference
      ) {
        const itemBlocker = addBlocker(
          blockers,
          blocked(
            "portal_wrong_reference",
            `Portal capture for ${role} does not match this job, docket, builder reference and URL.`,
            "Reject the capture and re-run against the exact typed source link.",
            [`portal-capture:${role}`],
          ),
        );
        manifest.items[captureItem] = itemBlocker;
        continue;
      }
      const captureFailure = captureBlocker(capture);
      if (captureFailure) {
        manifest.items[captureItem] = addBlocker(blockers, captureFailure);
      } else if (!screenshotBytes?.byteLength) {
        manifest.items[captureItem] = addBlocker(
          blockers,
          blocked(
            "portal_unreachable",
            `Portal ${role} returned a submitted/locked signal without the required screenshot.`,
            "Re-run the approved portal capture and retain the tied screenshot.",
            [`portal-capture:${role}`],
          ),
        );
      } else {
        const evidencePath = `EVIDENCE/portal_${role}.json`;
        manifest.items[captureItem] = ready(`file:${evidencePath}`);
        artifacts.push(
          await artifactFromText({
            role: `portal_${role}`,
            path: evidencePath,
            media_type: "application/json",
            text: canonicalSesJson(captureRecord),
          }),
        );
        if (screenshotBytes) {
          artifacts.push(
            await artifactFromBytes({
              role: `portal_${role}_screenshot`,
              path: `EVIDENCE/portal_${role}.png`,
              media_type: "image/png",
              bytes: screenshotBytes,
            }),
          );
        }
      }
    }
    if (row.required_portal_roles.length) {
      manifest.items.supporting_portal_links = blockers.some(
          (candidate) =>
            candidate.reason_code.startsWith("portal_") ||
            candidate.reason_code === "capability_portal_degraded",
        )
        ? blocked(
          "capture-failure",
          "One or more required portal links/captures are not ready.",
          "Resolve the typed portal blocker and re-run.",
          row.required_portal_roles.map((role) => `portal-role:${role}`),
        )
        : ready("file:EVIDENCE/portal_evidence.json");
    }
  });

  await measure("T5", async () => {
    if (!row || !swms) return;
    if (row.job_type === "physical_makesafe") {
      const acceptedBundle =
        input.sibling_bundle_evidence?.status === "accepted"
          ? input.sibling_bundle_evidence
          : null;
      const hasLocalPhysicalEvidence = !!input.cycle_facts.trade_report &&
        input.cycle_facts.photos.length > 0;
      if (!hasLocalPhysicalEvidence && acceptedBundle) {
        const bundleProof = {
          version: "ses-sibling-bundle-evidence/v1",
          claiming_job_id: input.identity.job_id,
          ...acceptedBundle,
        };
        artifacts.push(
          await artifactFromText({
            role: "sibling_bundle_evidence",
            path: "PROOF/sibling_bundle_evidence.json",
            media_type: "application/json",
            text: canonicalSesJson(bundleProof),
            metadata: bundleProof,
          }),
        );
        const resolved = deps.resolveBundledReportArtifact
          ? await deps.resolveBundledReportArtifact(input)
          : null;
        if (!resolved) {
          const itemBlocker = addBlocker(
            blockers,
            blocked(
              "sibling_evidence_artifact_unrecoverable",
              `Bundle ${acceptedBundle.bundle_id} is valid, but sibling ${acceptedBundle.sibling.job_number}'s claimed report artifact could not be recovered.`,
              "Restore the exact claimed sibling report document; do not substitute an unclaimed file.",
              [
                "canonical-input-envelope",
                "sibling-bundle-binding-ledger",
                "sibling-positive-scope-claim",
              ],
              [acceptedBundle.coverage.report_document_id],
              {
                bundle_id: acceptedBundle.bundle_id,
                sibling_job_id: acceptedBundle.sibling.job_id,
                sibling_job_number: acceptedBundle.sibling.job_number,
                report_document_id: acceptedBundle.coverage.report_document_id,
              },
            ),
          );
          manifest.items.physical_reporting_evidence = itemBlocker;
          manifest.items.supporting_report_pdf = itemBlocker;
        } else {
          reportFile = `ARTIFACTS/${resolved.file_name}`;
          artifacts.push(
            await artifactFromBytes({
              role: "supporting_report_pdf",
              path: reportFile,
              media_type: resolved.media_type,
              bytes: resolved.bytes,
              metadata: {
                render_hash: resolved.render_hash || null,
                evidence_source: "explicit_sibling_bundle",
                bundle_id: acceptedBundle.bundle_id,
                sibling_job_id: acceptedBundle.sibling.job_id,
                binding_revision_id:
                  acceptedBundle.claiming_binding.revision_id,
                report_document_id: acceptedBundle.coverage.report_document_id,
              },
            }),
          );
          manifest.items.supporting_report_pdf = ready(`file:${reportFile}`);
          manifest.items.physical_reporting_evidence = ready(
            "file:PROOF/sibling_bundle_evidence.json",
          );
          const resolvedPhotos = deps.resolveBundledPhotoArtifacts
            ? await deps.resolveBundledPhotoArtifacts(input)
            : [];
          const resolvedPhoto = resolvedPhotos.length === 1
            ? resolvedPhotos[0]
            : null;
          const expectedPhotoHash = acceptedBundle.coverage.photo.content_hash;
          if (
            !resolvedPhoto ||
            !/^sha256:[0-9a-f]{64}$/.test(expectedPhotoHash)
          ) {
            const itemBlocker = addBlocker(
              blockers,
              blocked(
                "sibling_evidence_photo_artifact_unrecoverable",
                `Bundle ${acceptedBundle.bundle_id} is valid, but its exact sibling photo artifact could not be recovered or validated.`,
                "Restore the exact hashed sibling photo artifact with positive scope coverage; do not substitute an email attachment claim.",
                [
                  "canonical-input-envelope",
                  "sibling-bundle-binding-ledger",
                  "sibling-positive-scope-claim",
                  "sibling-photo-artifact",
                ],
                [acceptedBundle.coverage.photo.media_id],
                {
                  bundle_id: acceptedBundle.bundle_id,
                  sibling_job_id: acceptedBundle.sibling.job_id,
                  media_id: acceptedBundle.coverage.photo.media_id,
                  content_hash: expectedPhotoHash,
                },
              ),
            );
            manifest.items.physical_reporting_evidence = itemBlocker;
            manifest.items.supporting_report_pdf = itemBlocker;
          } else {
            const photoFile = `ARTIFACTS/photos/${resolvedPhoto.file_name}`;
            const photoArtifact = await artifactFromBytes({
              role: "sibling_photo_evidence",
              path: photoFile,
              media_type: resolvedPhoto.media_type,
              bytes: resolvedPhoto.bytes,
              metadata: {
                evidence_source: "explicit_sibling_bundle",
                bundle_id: acceptedBundle.bundle_id,
                sibling_job_id: acceptedBundle.sibling.job_id,
                media_id: acceptedBundle.coverage.photo.media_id,
                claimed_content_hash: expectedPhotoHash,
                scope_phrase: acceptedBundle.coverage.photo.scope_phrase,
              },
            });
            if (await rawPhotoSha256(resolvedPhoto.bytes) !== expectedPhotoHash) {
              const itemBlocker = addBlocker(
                blockers,
                blocked(
                  "sibling_evidence_photo_artifact_hash_mismatch",
                  "The recovered sibling photo bytes do not match the durable claimed content hash.",
                  "Recover the exact immutable sibling photo artifact and re-run.",
                  ["sibling-photo-artifact"],
                  [acceptedBundle.coverage.photo.media_id],
                  {
                    expected_content_hash: expectedPhotoHash,
                    actual_content_hash: await rawPhotoSha256(resolvedPhoto.bytes),
                  },
                ),
              );
              manifest.items.physical_reporting_evidence = itemBlocker;
              manifest.items.supporting_report_pdf = itemBlocker;
            } else {
              photoFiles.push(photoFile);
              artifacts.push(photoArtifact);
              artifacts.push(
                await artifactFromText({
                  role: "photo_selection",
                  path: "ARTIFACTS/PHOTO_SELECTION.md",
                  media_type: "text/markdown",
                  text: [
                    "Sibling photo evidence claim",
                    `Email: ${acceptedBundle.coverage.photo.email_post_id}`,
                    `Content SHA-256: ${acceptedBundle.coverage.photo.content_sha256}`,
                    `Media ID: ${acceptedBundle.coverage.photo.media_id}`,
                    `Content hash: ${expectedPhotoHash}`,
                    `Scope: ${acceptedBundle.coverage.photo.scope_phrase}`,
                  ].join("\n"),
                }),
              );
            }
          }
        }
      } else if (!hasLocalPhysicalEvidence) {
        const itemBlocker = addBlocker(
          blockers,
          blocked(
            "trade_evidence_missing",
            "Physical make-safe requires a current-cycle trade report and complete photo story.",
            "Submit/bind current-cycle trade evidence and re-run.",
          ),
        );
        manifest.items.physical_reporting_evidence = itemBlocker;
        manifest.items.supporting_report_pdf = itemBlocker;
      } else {
        let resolvedPhotos: SesPhotoArtifact[] = [];
        let photosComplete = false;
        if (!text(input.source.builder_reference)) {
          const itemBlocker = blockers.find(
            (candidate) =>
              candidate.reason_code === "spine_missing_source" &&
              candidate.reason ===
                "Builder reference is absent from the canonical source instruction.",
          ) ||
            addBlocker(
              blockers,
              blocked(
                "spine_missing_source",
                "Builder reference is absent from the canonical source instruction.",
                "Recover the WO/PO/external reference from the canonical source case.",
              ),
            );
          manifest.items.physical_reporting_evidence = itemBlocker;
          manifest.items.supporting_report_pdf = itemBlocker;
        } else if (!deps.renderPhysicalReport) {
          const itemBlocker = addBlocker(
            blockers,
            blocked(
              "trade_evidence_missing",
              "Physical report renderer capability is unavailable.",
              "Resume on the existing deterministic make-safe report renderer.",
            ),
          );
          manifest.items.physical_reporting_evidence = itemBlocker;
          manifest.items.supporting_report_pdf = itemBlocker;
        }

        const expectedPhotos = input.cycle_facts.photos
          .slice()
          .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        if (request.dry_run && !deps.resolvePhotoProofs) {
          degradedCapabilities.push("photo_proof_recovery");
          manifest.items.physical_reporting_evidence = addBlocker(
            blockers,
            blocked(
              "trade_evidence_missing",
              "Current-cycle photo proof recovery capability is unavailable.",
              "Resume with the U2/U3 cycle-scoped photo proof adapter.",
            ),
          );
        } else if (!request.dry_run && !deps.resolvePhotoArtifacts) {
          degradedCapabilities.push("photo_artifact_recovery");
          manifest.items.physical_reporting_evidence = addBlocker(
            blockers,
            blocked(
              "trade_evidence_missing",
              "Current-cycle photo artifact recovery capability is unavailable.",
              "Resume with the U2/U3 cycle-scoped photo storage adapter.",
            ),
          );
        } else if (request.dry_run) {
          const resolvedProofs = await deps.resolvePhotoProofs!(input);
          const matchedIndexes = new Set<number>();
          photosComplete = true;
          for (const [index, expected] of expectedPhotos.entries()) {
            const matches = resolvedProofs
              .map((proof, resolvedIndex) => ({
                proof,
                resolvedIndex,
              }))
              .filter(
                ({ proof }) =>
                  proof.photo_id === expected.id &&
                  proof.source_pointer === expected.path_or_key,
              );
            const resolved = matches.length === 1 ? matches[0] : null;
            if (
              !resolved ||
              matchedIndexes.has(resolved.resolvedIndex) ||
              !text(resolved.proof.file_name) ||
              resolved.proof.file_name.includes("/") ||
              resolved.proof.file_name.includes("..") ||
              !/^sha256:[0-9a-f]{64}$/.test(resolved.proof.content_hash) ||
              !Number.isSafeInteger(resolved.proof.size_bytes) ||
              resolved.proof.size_bytes <= 0
            ) {
              photosComplete = false;
              addBlocker(
                blockers,
                blocked(
                  "trade_evidence_missing",
                  `Photo ${expected.id} did not resolve to one safe, non-empty current-cycle proof.`,
                  "Recover the exact cycle-scoped photo metadata and content hash, then re-run.",
                  ["canonical-input-envelope", "cycle-photo-proof"],
                  [expected.path_or_key],
                ),
              );
              continue;
            }
            matchedIndexes.add(resolved.resolvedIndex);
            const storedPath = `ARTIFACTS/photos/${
              String(index + 1).padStart(
                3,
                "0",
              )
            }-${resolved.proof.file_name}`;
            photoFiles.push(storedPath);
            const proof = {
              photo_id: expected.id,
              source_pointer: expected.path_or_key,
              order: expected.order,
              caption: expected.caption || null,
              content_hash: resolved.proof.content_hash,
              size_bytes: resolved.proof.size_bytes,
              media_type: resolved.proof.media_type,
              intended_path: storedPath,
            };
            artifacts.push(
              await artifactFromText({
                role: "completion_photo_proof",
                path: `PROOF/photos/${
                  String(index + 1).padStart(
                    3,
                    "0",
                  )
                }.json`,
                media_type: "application/json",
                text: canonicalSesJson(proof),
                metadata: proof,
              }),
            );
          }
          if (
            matchedIndexes.size !== resolvedProofs.length ||
            photoFiles.length !== expectedPhotos.length
          ) {
            photosComplete = false;
            addBlocker(
              blockers,
              blocked(
                "trade_evidence_missing",
                "Resolved photo proofs do not exactly match the current-cycle photo set.",
                "Remove foreign/duplicate photos and recover a hash for every expected current-cycle photo.",
                ["canonical-input-envelope", "cycle-photo-proof"],
              ),
            );
          }
        } else {
          resolvedPhotos = await deps.resolvePhotoArtifacts!(input);
          const matchedIndexes = new Set<number>();
          photosComplete = true;
          for (const [index, expected] of expectedPhotos.entries()) {
            const matches = resolvedPhotos
              .map((photo, resolvedIndex) => ({
                photo,
                resolvedIndex,
              }))
              .filter(
                ({ photo }) =>
                  photo.photo_id === expected.id &&
                  photo.source_pointer === expected.path_or_key,
              );
            const resolved = matches.length === 1 ? matches[0] : null;
            if (
              !resolved ||
              matchedIndexes.has(resolved.resolvedIndex) ||
              !text(resolved.photo.file_name) ||
              resolved.photo.file_name.includes("/") ||
              resolved.photo.file_name.includes("..") ||
              !resolved.photo.bytes.byteLength
            ) {
              photosComplete = false;
              addBlocker(
                blockers,
                blocked(
                  "trade_evidence_missing",
                  `Photo ${expected.id} did not resolve to one safe, non-empty current-cycle artifact.`,
                  "Recover the exact cycle-scoped photo bytes and re-run.",
                  ["canonical-input-envelope", "cycle-photo-storage"],
                  [expected.path_or_key],
                ),
              );
              continue;
            }
            matchedIndexes.add(resolved.resolvedIndex);
            const storedPath = `ARTIFACTS/photos/${
              String(index + 1).padStart(
                3,
                "0",
              )
            }-${resolved.photo.file_name}`;
            photoFiles.push(storedPath);
            artifacts.push(
              await artifactFromBytes({
                role: "completion_photo",
                path: storedPath,
                media_type: resolved.photo.media_type,
                bytes: resolved.photo.bytes,
                metadata: {
                  photo_id: expected.id,
                  source_pointer: expected.path_or_key,
                  order: expected.order,
                  caption: expected.caption || null,
                },
              }),
            );
          }
          if (
            matchedIndexes.size !== resolvedPhotos.length ||
            photoFiles.length !== expectedPhotos.length
          ) {
            photosComplete = false;
            addBlocker(
              blockers,
              blocked(
                "trade_evidence_missing",
                "Resolved photo artifacts do not exactly match the current-cycle photo set.",
                "Remove foreign/duplicate photos and recover every expected current-cycle photo.",
                ["canonical-input-envelope", "cycle-photo-storage"],
              ),
            );
          }
          if (
            photosComplete &&
            manifest.items.supporting_report_pdf.state === "ready"
          ) {
            manifest.items.physical_reporting_evidence = ready(
              "file:ARTIFACTS/PHOTO_SELECTION.md",
            );
          }
        }
        if (
          request.dry_run &&
          text(input.source.builder_reference) &&
          deps.renderPhysicalReport &&
          photosComplete
        ) {
          reportFile = `ARTIFACTS/${
            makesafeReportFileName(
              input.source.builder_reference,
              input.source.site_address || "Address not recorded",
            )
          }`;
          const plan = {
            mode: "async_pack_build",
            intended_path: reportFile,
            photo_count: photoFiles.length,
            photo_proof_paths: artifacts
              .filter((artifact) => artifact.role === "completion_photo_proof")
              .map((artifact) => artifact.path),
          };
          artifacts.push(
            await artifactFromText({
              role: "supporting_report_plan",
              path: "PROOF/supporting_report_plan.json",
              media_type: "application/json",
              text: canonicalSesJson(plan),
              metadata: plan,
            }),
          );
          manifest.items.supporting_report_pdf = ready(
            `planned:${reportFile}#async-pack-build`,
          );
          manifest.items.physical_reporting_evidence = ready(
            "file:ARTIFACTS/PHOTO_SELECTION.md",
          );
        } else if (
          !request.dry_run &&
          text(input.source.builder_reference) &&
          deps.renderPhysicalReport &&
          photosComplete
        ) {
          const rendered = await deps.renderPhysicalReport(
            input,
            resolvedPhotos,
          );
          reportFile = `ARTIFACTS/${rendered.file_name}`;
          artifacts.push(
            await artifactFromBytes({
              role: "supporting_report_pdf",
              path: reportFile,
              media_type: rendered.media_type,
              bytes: rendered.bytes,
              metadata: { render_hash: rendered.render_hash || null },
            }),
          );
          manifest.items.supporting_report_pdf = ready(`file:${reportFile}`);
          manifest.items.physical_reporting_evidence = ready(
            "file:ARTIFACTS/PHOTO_SELECTION.md",
          );
        }
      }
    } else if (
      row.family === "own_template_roof" &&
      input.classification.delivery_render_route ===
        "secureworks_own_letterhead"
    ) {
      if (!input.cycle_facts.roof_report_fields || !deps.renderOwnRoofReport) {
        const itemBlocker = addBlocker(
          blockers,
          blocked(
            "trade_evidence_missing",
            "Own-template roof requires submitted trade-authored fields and the existing roof renderer.",
            "Submit the current-cycle roof template and resume its deterministic renderer.",
          ),
        );
        manifest.items.supporting_report_pdf = itemBlocker;
      } else {
        const rendered = await deps.renderOwnRoofReport(input);
        reportFile = `ARTIFACTS/${rendered.file_name}`;
        artifacts.push(
          await artifactFromBytes({
            role: "supporting_report_pdf",
            path: reportFile,
            media_type: rendered.media_type,
            bytes: rendered.bytes,
            metadata: { render_hash: rendered.render_hash || null },
          }),
        );
        manifest.items.supporting_report_pdf = ready(`file:${reportFile}`);
      }
    }
    if (swms.required) {
      const resolved = deps.resolveSwmsArtifact
        ? await deps.resolveSwmsArtifact(input)
        : null;
      if (!resolved) {
        const itemBlocker = addBlocker(
          blockers,
          blocked(
            "hrcw_swms_missing",
            "The matrix/HRCW decision requires a real SWMS artifact.",
            "Render or recover the SWMS through the existing SWMS engine and re-run.",
          ),
        );
        manifest.items.swms_artifact = itemBlocker;
      } else {
        swmsFile = `ARTIFACTS/${resolved.file_name}`;
        artifacts.push(
          await artifactFromBytes({
            role: "swms_artifact",
            path: swmsFile,
            media_type: resolved.media_type,
            bytes: resolved.bytes,
            metadata: { render_hash: resolved.render_hash || null },
          }),
        );
        manifest.items.swms_artifact = ready(`file:${swmsFile}`);
      }
    }
    if (row.job_type === "physical_makesafe") {
      artifacts.push(
        await artifactFromText({
          role: "photo_selection",
          path: "ARTIFACTS/PHOTO_SELECTION.md",
          media_type: "text/markdown",
          text: input.cycle_facts.photos
            .slice()
            .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
            .map(
              (photo, index) =>
                `${index + 1}. ${
                  photoFiles[index] || `MISSING:${photo.path_or_key}`
                } - ${photo.caption || "Not provided"}`,
            )
            .join("\n"),
        }),
      );
    }
  });

  const priced = row
    ? await measure(
      "T6",
      () => Promise.resolve(localInvoiceProposal(input, row)),
    )
    : { proposal: null, blocker: null };
  if (!row) stagesMs.T6 = 0;
  if (priced.blocker) addBlocker(blockers, priced.blocker);
  if (priced.proposal) {
    artifacts.push(
      await artifactFromText({
        role: "invoice_proposal",
        path: "ARTIFACTS/invoice_proposal.json",
        media_type: "application/json",
        text: canonicalSesJson(priced.proposal),
      }),
    );
  }

  stagesMs.T7 = 0;
  const drafts = row
    ? blockers.length === 0
      ? buildEmailDrafts(
        input,
        row,
        reportFile,
        swmsFile,
        photoFiles,
        priced.proposal,
      )
      : {}
    : {};
  if (drafts.REPORT_EMAIL_DRAFT) {
    manifest.items.draft_builder_report_email = ready(
      "file:DRAFTS/REPORT_EMAIL_DRAFT.txt",
    );
  }
  if (drafts.INVOICE_EMAIL_DRAFT) {
    if (drafts.PHOTO_EMAIL_DRAFT) {
      manifest.items.draft_photo_evidence_email = ready(
        "file:DRAFTS/PHOTO_EMAIL_DRAFT.txt",
      );
    }
    manifest.items.draft_invoice_bundle_email = ready(
      "file:DRAFTS/INVOICE_EMAIL_DRAFT.txt",
    );
  }
  if (Object.keys(drafts).length) {
    manifest.items.email_drafts_presented = ready(
      "review:review.html#email-drafts",
    );
  } else if (blockers.length) {
    manifest.items.email_drafts_presented = blockers[0];
  }
  stagesMs.T8 = 0;
  for (const [name, body] of Object.entries(drafts)) {
    artifacts.push(
      await artifactFromText({
        role: name.toLowerCase(),
        path: `DRAFTS/${name}.txt`,
        media_type: "text/plain",
        text: body,
      }),
    );
  }
  if (portalEvidence.length) {
    artifacts.push(
      await artifactFromText({
        role: "portal_evidence",
        path: "EVIDENCE/portal_evidence.json",
        media_type: "application/json",
        text: canonicalSesJson(portalEvidence),
      }),
    );
  }

  const reviewSpec: Record<string, unknown> = {
    version: "ses-docket-review/v1",
    property_id: input.identity.property_id,
    address: [input.source.site_address, input.source.site_suburb]
      .filter(Boolean)
      .join(", "),
    cards: [
      {
        job_id: input.identity.job_id,
        family: row?.family || input.classification.family,
        builder_reference: input.source.builder_reference,
        portal_proof: portalEvidence,
        artifact_paths: artifacts.map((artifact) => artifact.path).sort(),
        blocker_codes: blockers.map((item) => item.reason_code),
        waiting_on: blockers.map((item) => item.reason),
      },
    ],
  };
  const releasePayload: Record<string, unknown> = {
    version: "ses-inert-release-proposal/v1",
    job_id: input.identity.job_id,
    invoice_create_approved: false,
    client_send_approved: false,
    send_email: false,
    send_sms: false,
    create_invoice: false,
    authorise_invoice: false,
    close_job: false,
    portal_evidence: portalEvidence,
  };
  const review = reviewHtml(
    input,
    row?.family || input.classification.family,
    blockers,
    drafts,
  );
  artifacts.push(
    await artifactFromText({
      role: "review_spec",
      path: "review_spec.json",
      media_type: "application/json",
      text: canonicalSesJson(reviewSpec),
    }),
    await artifactFromText({
      role: "review_html",
      path: "review.html",
      media_type: "text/html",
      text: review,
    }),
    await artifactFromText({
      role: "release_payload",
      path: "release_payload.json",
      media_type: "application/json",
      text: canonicalSesJson(releasePayload),
    }),
  );
  if (row) {
    artifacts.push(
      await artifactFromText({
        role: "case_story",
        path: "case_story.json",
        media_type: "application/json",
        text: canonicalSesJson({
          version: "secureworks.makesafe.case-story/assembler-spine-v1",
          source_instruction_id: input.identity.source_instruction_id,
          lineage_id: input.identity.lineage_id,
          case_id: input.identity.case_id,
          deliverables: input.source.deliverables,
          lineage: input.classification.lineage_kind,
          hrcw: input.hrcw,
          searches_attempted: ["canonical-input-envelope"],
        }),
      }),
    );
  }
  stagesMs.T9 = 0;

  const revisionIdentityHash = await sesSha256(
    {
      assembler_version: request.assembler_version,
      family_matrix_version: SES_FAMILY_MATRIX_VERSION,
      idempotency_key: request.idempotency_key,
      input_content_hash: inputContentHash,
    },
    "SecureWorks:ses-docket-revision-id:v1\n",
  );
  const docketRevisionId = stableUuidFromSha256(revisionIdentityHash);
  const stableOutput = {
    docket_revision_id: docketRevisionId,
    manifest,
    invoice_proposal: priced.proposal,
    email_drafts: drafts,
    portal_evidence: portalEvidence,
    review_spec: reviewSpec,
    release_payload: releasePayload,
    artifact_hashes: artifacts
      .map((artifact) => ({
        role: artifact.role,
        path: artifact.path,
        content_hash: artifact.content_hash,
        size_bytes: artifact.size_bytes,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    blockers,
  };
  const outputContentHash = await sesSha256(
    stableOutput,
    "SecureWorks:ses-docket-output:v1\n",
  );
  const preXeroDocsReady = validatePreXero(
    manifest,
    priced.proposal,
    artifacts,
    blockers,
  );
  const envelope: SesDocketEnvelopeV3 = {
    version: SES_DOCKET_ENVELOPE_VERSION,
    v2: manifest,
    spine: {
      source_instruction_id: input.identity.source_instruction_id,
      lineage_id: input.identity.lineage_id,
      job_id: input.identity.job_id,
      card_id: input.identity.card_id,
      property_id: input.identity.property_id,
      attendance_cycle_ids: sortedUnique(input.attendance.attendance_cycle_ids),
      current_attendance_cycle_id: input.attendance.current_attendance_cycle_id,
      readiness_revision: input.readiness.readiness_revision,
      docket_revision_id: docketRevisionId,
    },
    pre_xero_docs_ready: preXeroDocsReady,
    local_invoice_proposal: priced.proposal
      ? { state: "ready", evidence: "file:ARTIFACTS/invoice_proposal.json" }
      : {
        state: "blocked",
        evidence: `blocker:${
          priced.blocker?.reason_code ||
          applicabilityBlocker?.reason_code ||
          "pricing_evidence_missing"
        }`,
      },
    invoice_create_approved: false,
    client_send_approved: false,
    family_matrix_version: SES_FAMILY_MATRIX_VERSION,
    assembler_version: SES_ASSEMBLER_VERSION,
    input_content_hash: inputContentHash,
    output_content_hash: outputContentHash,
  };
  artifacts.push(
    await artifactFromText({
      role: "docket_manifest",
      path: "docket_manifest.json",
      media_type: "application/json",
      text: canonicalSesJson(manifest),
    }),
    await artifactFromText({
      role: "assembler_envelope",
      path: "ASSEMBLER_ENVELOPE.json",
      media_type: "application/json",
      text: canonicalSesJson(envelope),
    }),
    await artifactFromText({
      role: "capability",
      path: "CAPABILITY.json",
      media_type: "application/json",
      text: canonicalSesJson({
        recipe_selection: row ? "sealed" : "blocked",
        delivery_render_route: input.classification.delivery_render_route,
        delivery_render_route_reason_code:
          input.classification.delivery_render_route_reason_code,
        delivery_render_route_reason:
          input.classification.delivery_render_route_reason,
        portal_capture: !row
          ? "not_evaluated"
          : row.required_portal_roles.length
          ? deps.capturePortal ? "available" : "degraded"
          : "not_required",
        source_attachment_recovery: !row
          ? "not_evaluated"
          : deps.resolveSourceArtifacts
          ? "available"
          : "unavailable",
        photo_artifact_recovery: !row
          ? "not_evaluated"
          : row.job_type === "physical_makesafe"
          ? request.dry_run
            ? deps.resolvePhotoProofs ? "proof_only" : "unavailable"
            : deps.resolvePhotoArtifacts
            ? "available"
            : "unavailable"
          : "not_required",
        physical_renderer: !row
          ? "not_evaluated"
          : request.dry_run && row.job_type === "physical_makesafe"
          ? deps.renderPhysicalReport ? "deferred_to_async_pack" : "unavailable"
          : deps.renderPhysicalReport
          ? "available"
          : "unavailable",
        own_roof_renderer: !row
          ? "not_evaluated"
          : deps.renderOwnRoofReport
          ? "available"
          : "unavailable",
        swms_provider: !row
          ? "not_evaluated"
          : deps.resolveSwmsArtifact
          ? "available"
          : "unavailable",
        xero_mutation: "structurally_absent",
        send: "structurally_absent",
      }),
    }),
  );
  stagesMs.T10 = 0;

  const baseRevision: Omit<
    SesPreparedRevision,
    "timing" | "persisted" | "artifacts"
  > = {
    state: preXeroDocsReady ? "ready" : "blocked",
    docket_revision_id: docketRevisionId,
    input_content_hash: inputContentHash,
    output_content_hash: outputContentHash,
    envelope,
    blockers,
    portal_evidence: portalEvidence,
    invoice_proposal: priced.proposal,
    email_drafts: drafts,
    review_spec: reviewSpec,
    release_payload: releasePayload,
  };
  let persisted = false;
  let committedAt = now().toISOString();
  if (!request.dry_run) {
    if (deps.persist) {
      const persistedResult = await measure("T11", () =>
        deps.persist!({
          revision: baseRevision,
          artifacts,
          idempotency_key: request.idempotency_key,
          assembler_version: request.assembler_version,
          family_matrix_version: SES_FAMILY_MATRIX_VERSION,
          accepted_at: acceptedAt.toISOString(),
          stage_durations_ms: stagesMs,
        }));
      committedAt = persistedResult.committed_at;
      persisted = true;
    } else {
      stagesMs.T11 = 0;
    }
  } else {
    stagesMs.T11 = 0;
  }
  stagesMs.T12 = 0;
  const finishedAt = now();
  const durationMs = Math.max(0, finishedAt.getTime() - acceptedAt.getTime());
  const timing = {
    job_id: input.identity.job_id,
    accepted_at: acceptedAt.toISOString(),
    committed_at: committedAt,
    duration_ms: durationMs,
    stages_ms: stagesMs,
    retries: {},
    degraded_capabilities: degradedCapabilities,
    within_five_minutes: durationMs <= SES_FIVE_MINUTES_MS,
  };
  if (!timing.within_five_minutes) {
    console.error("ses_docket_revision_sla_breach", timing);
  }
  artifacts.push(
    await artifactFromText({
      role: "timing",
      path: "TIMING.json",
      media_type: "application/json",
      text: canonicalSesJson(timing),
    }),
  );
  const hashLines = artifacts
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((artifact) => `${artifact.content_hash.slice(7)}  ${artifact.path}`)
    .join("\n");
  artifacts.push(
    await artifactFromText({
      role: "hashes",
      path: "hashes.sha256",
      media_type: "text/plain",
      text: `${hashLines}\n`,
    }),
  );
  return {
    ...baseRevision,
    state: envelope.pre_xero_docs_ready && !blockers.length
      ? "ready"
      : "blocked",
    artifacts,
    timing,
    persisted,
  };
}

async function prepareSesDocketRevision(
  request: SesPrepareRequest,
  deps: SesPrepareDependencies,
): Promise<SesPrepareResponse> {
  validateRequest(request);
  let selections: Array<
    | { mode: "job_id"; job_id: string }
    | {
      mode: "job_number";
      job_number: string;
    }
  >;
  if (request.selection.mode === "board_batch") {
    if (!deps.listBoardJobs) {
      throw new TypeError(
        "board_batch requires the canonical U2 queue adapter",
      );
    }
    selections = await deps.listBoardJobs(request.selection.limit as number);
  } else if (request.selection.mode === "job_id") {
    selections = [
      {
        mode: "job_id",
        job_id: request.selection.job_id as string,
      },
    ];
  } else {
    selections = [
      {
        mode: "job_number",
        job_number: request.selection.job_number as string,
      },
    ];
  }
  const results = await Promise.all(
    selections.map((selection, index) =>
      prepareOne(
        {
          ...request,
          selection,
          idempotency_key: selections.length > 1
            ? `${request.idempotency_key}:job:${index}`
            : request.idempotency_key,
        },
        selection,
        deps,
      )
    ),
  );
  return {
    action: "prepare_ses_docket_revision",
    assembler_version: SES_ASSEMBLER_VERSION,
    dry_run: request.dry_run,
    results,
    timing_summary: responseSummary(results),
  };
}

export const prepare_ses_docket_revision = prepareSesDocketRevision;

import { sesSha256, stableUuidFromSha256 } from "./ses_docket_envelope.ts";
import type { SesPricingDisposition } from "./makesafe_invoice_obligation.ts";
import { type SesRefusal, sesRefusal } from "./ses_reporting_refusals.ts";
import { SES_ASSESSMENT_RECIPE_VERSION } from "./ses_family_matrix.ts";

export const SES_REVIEW_SECTION_ORDER = [
  "job_story",
  "status",
  "insurance_work_order",
  "family_evidence",
  "swms",
  "money",
  "email_drafts",
  "crew_and_trade_visits",
  "decision_controls",
] as const;

export type SesRouteKind = "report" | "photo" | "invoice";
export const SES_ROUTE_ORDER: SesRouteKind[] = ["report", "photo", "invoice"];

export interface SesReviewRoute {
  route_kind: SesRouteKind;
  recipients: string[];
  cc?: string[];
  subject: string;
  body: string;
  attachment_hashes: string[];
  ready: boolean;
}

const SES_EMAIL_ADDRESS_RE = /^[^\s@<>,;:]+@[^\s@<>,;:]+$/;

export function invalidSesRouteRecipients(
  route: Pick<SesReviewRoute, "recipients" | "cc">,
): string[] {
  return [...(route.recipients || []), ...(route.cc || [])].filter((value) =>
    !SES_EMAIL_ADDRESS_RE.test(String(value || "").trim())
  );
}

export function assertSesRouteRecipients(
  route: Pick<SesReviewRoute, "recipients" | "cc">,
): void {
  const invalid = invalidSesRouteRecipients(route);
  if (invalid.length > 0) {
    throw new TypeError("release route contains a non-email recipient");
  }
}

export interface SesCleanInput {
  pre_xero_docs_ready: boolean;
  readiness_ready: boolean;
  readiness_blockers: SesRefusal[];
  pricing_disposition: SesPricingDisposition;
  line_overrides_audited: boolean;
  duplicate_allows_create: boolean;
  invoice_already_bound: boolean;
  duplicate_ambiguity: string;
  money_blocker_codes: string[];
  post_release_disposition_outstanding: boolean;
  family: string;
  family_matrix_version: string | null;
  assessment_recipe_version: string | null;
  portal_required: boolean;
  portal_capture_status: "done" | "not_done" | "unreachable" | "not_applicable";
  own_document_exemption: boolean;
  physical_media_complete: boolean;
  completed_work_photo_proven: boolean;
  obligation_revision_count: number;
  routes: SesReviewRoute[];
  type_check_hold: boolean;
  story_unverified: boolean;
  trade_report_submitted: boolean;
  roof_report_required: boolean;
  roof_report_filled: boolean;
  report_only: boolean;
}

export interface SesCleanCheck {
  id: `C${number}`;
  passed: boolean;
  fact: string;
}

export interface SesMechanicalCleanResult {
  clean: boolean;
  checks: SesCleanCheck[];
  blockers: SesRefusal[];
  approval_band: "shaun_clean" | "captain_only" | "decision_blocked";
}

function check(
  id: SesCleanCheck["id"],
  passed: boolean,
  fact: string,
): SesCleanCheck {
  return { id, passed, fact };
}

function missingRouteRefusals(
  routes: SesReviewRoute[],
  family: string,
): SesRefusal[] {
  const byKind = new Map(routes.map((route) => [route.route_kind, route]));
  const refusals: SesRefusal[] = [];
  const requiredRoutes = family === "assessment_quote"
    ? (["invoice"] as SesRouteKind[])
    : SES_ROUTE_ORDER;
  for (const kind of requiredRoutes) {
    const route = byKind.get(kind);
    if (!route || !route.ready || !route.subject.trim() || !route.body.trim()) {
      refusals.push(
        sesRefusal(
          "route_draft_missing",
          `Prepare the current ${kind} email draft and bind it to this docket revision.`,
          { evidence: { route_kind: kind } },
        ),
      );
      continue;
    }
    if (route.recipients.length === 0) {
      refusals.push(
        sesRefusal(
          "canonical_recipient_missing",
          `Recover the canonical builder mailbox for the ${kind} route.`,
          { evidence: { route_kind: kind } },
        ),
      );
    }
  }
  return refusals;
}

export function evaluateSesMechanicalClean(
  input: SesCleanInput,
): SesMechanicalCleanResult {
  const pricingClean = input.pricing_disposition === "priced_from_canon" ||
    input.pricing_disposition === "no_additional_charge" ||
    (input.pricing_disposition === "priced_with_line_override" &&
      input.line_overrides_audited);
  const moneyBlocked = input.money_blocker_codes.some((code) =>
    [
      "money_review_required",
      "billing_disposition_required",
      "company_ambiguous",
      "blocked_parked_rule",
    ].includes(code)
  );
  const portalClean = !input.portal_required ||
    input.own_document_exemption ||
    input.portal_capture_status === "done";
  const physical = input.family === "physical_makesafe" ||
    input.family === "temporary_fencing";
  const routeRefusals = missingRouteRefusals(input.routes, input.family);
  const checks: SesCleanCheck[] = [
    check(
      "C1",
      input.pre_xero_docs_ready || input.invoice_already_bound,
      "The current family docket is commercially ready.",
    ),
    // C2 names missing facts, not the historical readiness.ready flag.
    // That flag stays false with empty blockers after the 2026-08-03 drop of
    // the unsatisfiable readiness precondition (approval/obligation/release
    // no longer assert it). Requiring the flag here recreated a false hold:
    // Docs Ready / APPROVE stayed dark even when every named readiness
    // blocker was gone and a live Xero DRAFT was already bound.
    check(
      "C2",
      input.readiness_blockers.length === 0,
      "No named readiness blockers remain on the current revision.",
    ),
    check(
      "C3",
      pricingClean,
      "Pricing is settled by canon or audited override.",
    ),
    check(
      "C4",
      input.pricing_disposition === "no_additional_charge" ||
        input.invoice_already_bound || input.duplicate_allows_create,
      "The duplicate probe is consistent with the requested money action.",
    ),
    check("C5", !moneyBlocked, "No unresolved money hold remains."),
    check(
      "C6",
      !input.post_release_disposition_outstanding,
      "No post-release billing disposition is outstanding.",
    ),
    check(
      "C7",
      !!input.family_matrix_version &&
        (input.family !== "assessment_quote" ||
          input.assessment_recipe_version ===
            SES_ASSESSMENT_RECIPE_VERSION),
      "The family matrix and required assessment recipe are versioned.",
    ),
    check("C8", portalClean, "Required portal truth is captured."),
    check(
      "C9",
      !physical ||
        (input.physical_media_complete && input.completed_work_photo_proven),
      "Physical work has the full media floor and completed-work proof.",
    ),
    check(
      "C10",
      input.obligation_revision_count === 1 &&
        input.duplicate_ambiguity !== "multi_live",
      "Exactly one non-ambiguous obligation revision owns this work.",
    ),
    check(
      "C11",
      routeRefusals.length === 0,
      "Every route required by this family has canonical recipients and a draft.",
    ),
    check(
      "C12",
      !input.type_check_hold && !input.story_unverified,
      "No type-check or unverified-story hold remains.",
    ),
  ];

  const blockers: SesRefusal[] = [
    ...input.readiness_blockers,
    ...routeRefusals,
  ];
  if (!input.trade_report_submitted) {
    blockers.push(
      sesRefusal(
        "no_trade_report_submitted",
        "Ask the assigned trade to submit the current Visit report before review.",
      ),
    );
  }
  if (
    input.portal_required &&
    input.portal_capture_status === "unreachable" &&
    !input.own_document_exemption
  ) {
    blockers.push(
      sesRefusal(
        "portal_link_dead",
        "Recover a working portal link and capture the completed builder report.",
      ),
    );
  }
  if (input.roof_report_required && !input.roof_report_filled) {
    blockers.push(
      sesRefusal(
        "roof_report_not_filled",
        "Complete and render the SecureWorks roof report before review.",
      ),
    );
  }
  if (
    input.family === "assessment_quote" &&
    input.assessment_recipe_version !== SES_ASSESSMENT_RECIPE_VERSION
  ) {
    blockers.push(
      sesRefusal(
        "assessment_recipe_parked",
        "Wait for the Captain to settle the assessment outbound recipe, then prepare a new docket revision.",
        { decision_key: "assessment-outbound-recipe" },
      ),
    );
  }
  if (input.report_only && input.family !== "assessment_quote") {
    blockers.push(
      sesRefusal(
        "report_only_email_applicability_parked",
        "Wait for the Captain to decide the report-only email route applicability, then prepare a new release revision.",
        { decision_key: "report-only-email-applicability" },
      ),
    );
  }
  if (
    input.post_release_disposition_outstanding &&
    !blockers.some((blocker) =>
      blocker.code === "post_release_disposition_missing"
    )
  ) {
    blockers.push(
      sesRefusal(
        "post_release_disposition_missing",
        "Record the human billing disposition for the later attendance.",
        { decision_key: "post-release-reattend-disposition" },
      ),
    );
  }

  const decisionBlocked = blockers.some((blocker) => !!blocker.decision_key);
  const clean = checks.every((item) => item.passed) && blockers.length === 0;
  return {
    clean,
    checks,
    blockers,
    approval_band: decisionBlocked
      ? "decision_blocked"
      : (clean ? "shaun_clean" : "captain_only"),
  };
}

export interface SesCockpitDocket {
  job_id: string;
  job_number: string | null;
  docket_revision_id: string;
  readiness_revision: string;
  dependency_generation: number;
  invoice_obligation_revision_id: string | null;
  attendance_cycle_ids: string[];
  xero_binding: {
    xero_invoice_id: string;
    invoice_number: string;
    status: string;
    total?: number | null;
    pdf_content_hash?: string;
  } | null;
  local_invoice_proposal: Record<string, unknown> | null;
  work_order: Record<string, unknown> | null;
  family_evidence: Record<string, unknown>;
  swms: Record<string, unknown>;
  routes: SesReviewRoute[];
  crew_and_trade_visits: unknown;
  clean_input: SesCleanInput;
}

export interface SesCockpitView {
  schema: "secureworks.makesafe.ses-review-cockpit/v1";
  section_order: typeof SES_REVIEW_SECTION_ORDER;
  status:
    | "PRE_XERO_DOCS_READY"
    | "INVOICE_CREATE_READY"
    | "SEND_READY"
    | "HOLD";
  stale: boolean;
  verdict: SesMechanicalCleanResult;
  sections: Record<string, unknown>;
  controls: {
    approve_invoice: {
      enabled: boolean;
      label: "APPROVE INVOICE";
      plan: string;
    };
    send_it: {
      enabled: boolean;
      label: "SEND IT";
      plan: string;
    };
    captain_only: boolean;
  };
}

export function buildSesCockpitView(
  docket: SesCockpitDocket,
  displayedBinding?: {
    readiness_revision: string;
    dependency_generation: number;
  },
): SesCockpitView {
  const verdict = evaluateSesMechanicalClean(docket.clean_input);
  const stale = !!displayedBinding &&
    (displayedBinding.readiness_revision !== docket.readiness_revision ||
      displayedBinding.dependency_generation !== docket.dependency_generation);
  const xeroAuthorised = docket.xero_binding?.status === "AUTHORISED";
  const noAdditionalCharge =
    docket.clean_input.pricing_disposition === "no_additional_charge";
  const hardDecisionBlock = verdict.approval_band === "decision_blocked";
  // Option B: APPROVE INVOICE is permission to make an existing DRAFT real
  // (authorise/release), not permission to mint. Mint is create_ses_invoice_draft.
  const xeroIsDraft =
    String(docket.xero_binding?.status || "").toUpperCase() ===
      "DRAFT";
  const approveInvoice = !stale && !hardDecisionBlock &&
    !noAdditionalCharge &&
    verdict.checks.filter((item) => item.id !== "C11").every((item) =>
      item.passed
    ) &&
    !!docket.invoice_obligation_revision_id &&
    !!docket.xero_binding &&
    xeroIsDraft;
  const sendIt = !stale && verdict.clean &&
    (xeroAuthorised || noAdditionalCharge);
  const status: SesCockpitView["status"] = stale || verdict.blockers.length > 0
    ? "HOLD"
    : (sendIt
      ? "SEND_READY"
      : (approveInvoice ? "INVOICE_CREATE_READY" : "PRE_XERO_DOCS_READY"));
  return {
    schema: "secureworks.makesafe.ses-review-cockpit/v1",
    section_order: SES_REVIEW_SECTION_ORDER,
    status,
    stale,
    verdict,
    sections: {
      job_story: {
        job_id: docket.job_id,
        job_number: docket.job_number,
        attendance_cycle_ids: docket.attendance_cycle_ids,
      },
      status: {
        status,
        stale,
        reasons: verdict.blockers.map((blocker) => blocker.fact),
      },
      insurance_work_order: docket.work_order || {
        state: "missing",
        fact: "The insurance work order is missing from this docket.",
      },
      family_evidence: docket.family_evidence,
      swms: docket.swms,
      money: {
        // When a live Xero draft/invoice is bound, surface that identity as the
        // bill. The local proposal stays available as internal pre-Xero state
        // but must not be presented alone as though it were the invoice.
        bound_invoice: docket.xero_binding
          ? {
            xero_invoice_id: docket.xero_binding.xero_invoice_id,
            invoice_number: docket.xero_binding.invoice_number,
            status: docket.xero_binding.status,
            total: docket.xero_binding.total ?? null,
          }
          : null,
        xero: docket.xero_binding,
        local_invoice_proposal: docket.local_invoice_proposal,
      },
      email_drafts: docket.routes,
      crew_and_trade_visits: docket.crew_and_trade_visits,
      decision_controls: {
        approve_invoice: approveInvoice,
        send_it: sendIt,
      },
    },
    controls: {
      approve_invoice: {
        enabled: approveInvoice,
        label: "APPROVE INVOICE",
        plan:
          "Approve the existing Xero DRAFT for this exact obligation revision; authorise only if this approval explicitly includes authorise; then attach the real Xero PDF as a new docket revision.",
      },
      send_it: {
        enabled: sendIt,
        label: "SEND IT",
        plan:
          "Send the approved report, photo, and invoice routes for this exact release revision, then write route proofs and closeout.",
      },
      captain_only: !verdict.clean,
    },
  };
}

export interface SesReleaseMember {
  job_id: string;
  docket_revision_id: string;
  invoice_obligation_revision_id: string | null;
  attendance_cycle_ids: string[];
  readiness_revision: string;
  dependency_generation: number;
}

export interface SesReleaseRevisionPlan {
  release: Record<string, unknown>;
  members: Array<Record<string, unknown>>;
  routes: Array<Record<string, unknown>>;
}

export async function buildSesReleaseRevision(args: {
  org_id: string;
  members: SesReleaseMember[];
  routes: SesReviewRoute[];
  created_by: string;
}): Promise<SesReleaseRevisionPlan> {
  if (args.members.length === 0) {
    throw new TypeError("release members required");
  }
  const routeByKind = new Map(
    args.routes.map((route) => [route.route_kind, route]),
  );
  const orderedRoutes = SES_ROUTE_ORDER.map((kind) => routeByKind.get(kind));
  if (orderedRoutes.some((route) => !route)) {
    throw new TypeError("report, photo, and invoice routes are all required");
  }
  const members = args.members.map((member, ordinal) => ({
    ordinal,
    job_id: member.job_id,
    docket_revision_id: member.docket_revision_id,
    invoice_obligation_revision_id: member.invoice_obligation_revision_id,
    attendance_cycle_ids: [...new Set(member.attendance_cycle_ids)].sort(),
  }));
  const routes: Array<Record<string, unknown>> = [];
  for (let ordinal = 0; ordinal < orderedRoutes.length; ordinal++) {
    const route = orderedRoutes[ordinal]!;
    assertSesRouteRecipients(route);
    const bodyHash = await sesSha256(
      route.body,
      "SecureWorks:ses-release-route-body:v1\n",
    );
    const envelope = {
      route_kind: route.route_kind,
      recipients: route.recipients.map((value) => value.toLowerCase()).sort(),
      cc: (route.cc || []).map((value) => value.toLowerCase()).sort(),
      subject: route.subject,
      body_hash: bodyHash,
      attachment_hashes: route.attachment_hashes,
    };
    routes.push({
      ordinal,
      ...envelope,
      body: route.body,
      envelope_hash: await sesSha256(
        envelope,
        "SecureWorks:ses-release-route-envelope:v1\n",
      ),
      required: true,
    });
  }
  const releaseContent = {
    docket_revision_ids: members.map((member) => member.docket_revision_id),
    obligation_revision_ids: members.map((member) =>
      member.invoice_obligation_revision_id
    ),
    route_kinds: routes.map((route) => route.route_kind),
    routes: routes.map((route) => ({
      recipients: route.recipients,
      cc: route.cc,
      subject: route.subject,
      body_hash: route.body_hash,
      attachment_hashes: route.attachment_hashes,
      envelope_hash: route.envelope_hash,
    })),
  };
  const contentHash = await sesSha256(
    releaseContent,
    "SecureWorks:ses-release-revision:v1\n",
  );
  return {
    release: {
      id: stableUuidFromSha256(contentHash),
      org_id: args.org_id,
      content_hash: contentHash,
      dependency_generation: Math.max(
        ...args.members.map((member) => member.dependency_generation),
      ),
      readiness_bindings: args.members.map((member) => ({
        job_id: member.job_id,
        readiness_revision: member.readiness_revision,
        dependency_generation: member.dependency_generation,
      })),
      created_by: args.created_by,
    },
    members,
    routes,
  };
}

export type SesApprovalAuth =
  | {
    mode: "jwt";
    user_id: string;
    role: string;
    operator_class: "shaun_clean" | "captain" | "admin_owner" | null;
  }
  | { mode: "api_key" | "routine"; user_id?: null };

export function canRecordSesApproval(
  auth: SesApprovalAuth,
  clean: SesMechanicalCleanResult,
): { allowed: boolean; captain_override: boolean; refusal?: string } {
  if (auth.mode !== "jwt") {
    return {
      allowed: false,
      captain_override: false,
      refusal:
        "Human approval requires an identified SES operator session; API keys and automation keys cannot approve.",
    };
  }
  const adminOwner = auth.role === "admin" || auth.role === "owner" ||
    auth.operator_class === "admin_owner";
  const captain = auth.operator_class === "captain" || adminOwner;
  if (clean.approval_band === "decision_blocked") {
    return {
      allowed: false,
      captain_override: false,
      refusal:
        "A required explicit decision is still missing, so no invoice or release approval can be recorded.",
    };
  }
  if (clean.clean && (auth.operator_class === "shaun_clean" || captain)) {
    return { allowed: true, captain_override: false };
  }
  if (!clean.clean && captain) {
    return { allowed: true, captain_override: true };
  }
  return {
    allowed: false,
    captain_override: false,
    refusal:
      "This docket is not mechanically clean, so Captain approval is required.",
  };
}

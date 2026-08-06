// Read-only: pulls each card's LIVE cockpit, reconstructs the clean input from
// the live facts it publishes, and runs the PATCHED evaluator over it.
import {
  buildSesReleaseRevision,
  evaluateSesMechanicalClean,
  requiredSesRouteKinds,
  type SesCleanInput,
} from "../../supabase/functions/ops-api/ses_review_cockpit.ts";

const URL_BASE = Deno.env.get("SW_SUPABASE_URL")!;
const KEY = Deno.env.get("SW_API_KEY")!;

const CARDS = [
  {
    job: "088dee02-91d0-4539-8c9c-6014c9ebf06e",
    label: "SWMS-261114 White Gum Valley",
  },
  {
    job: "967cdb6e-e57e-46ea-89d8-14e8afbc2ada",
    label: "SWMS-261081 Mindarie",
  },
];

for (const card of CARDS) {
  const res = await fetch(
    `${URL_BASE}/functions/v1/ops-api?action=query_ses_review_cockpit&job_id=${card.job}`,
    { headers: { "x-api-key": KEY } },
  );
  const live = await res.json();
  const routes = (live.sections.email_drafts ?? []).map((d: any) => ({
    route_kind: d.route_kind,
    recipients: d.recipients ?? [],
    subject: d.subject ?? "",
    body: d.body ?? "",
    attachment_hashes: d.attachment_hashes ?? [],
    ready: d.ready === true,
  }));
  // Every non-C11 check passes live, and the only two blockers were the two the
  // ruling addresses — so the input below reproduces the live verdict exactly
  // when report_route_applicable is left at its old (strict) value.
  const base: SesCleanInput = {
    pre_xero_docs_ready: true,
    readiness_ready: true,
    readiness_blockers: [],
    money_blocker_codes: [],
    pricing_disposition: "priced_from_canon",
    pricing_evidence_complete: true,
    duplicate_probe_consistent: true,
    money_hold_open: false,
    post_release_disposition_outstanding: false,
    invoice_already_bound: true,
    family: "ordinary_roof_portal",
    family_matrix_version: "matrix@sealed",
    assessment_recipe_version: null,
    portal_required: true,
    portal_capture_status: "done",
    own_document_exemption: false,
    physical_media_complete: true,
    completed_work_photo_proven: true,
    obligation_revision_count: 1,
    routes,
    photo_route_applicable: false,
    type_check_hold: false,
    story_unverified: false,
    trade_report_submitted: true,
    roof_report_required: false,
    roof_report_filled: false,
    report_only: true,
    builder_key: "MLB",
  };

  const before = evaluateSesMechanicalClean({
    ...base,
    report_route_applicable: true,
  });
  const after = evaluateSesMechanicalClean({
    ...base,
    report_route_applicable: false,
  });

  console.log(`\n=== ${card.label} ===`);
  console.log(
    "live status/band  :",
    live.status,
    "/",
    live.verdict.approval_band,
  );
  console.log(
    "live blockers     :",
    live.verdict.blockers.map((b: any) => b.code).join(", "),
  );
  console.log(
    "live routes       :",
    routes.map((r: any) => r.route_kind).join(", "),
  );
  console.log(
    "live xero status  :",
    live.sections.money?.xero?.status,
    live.sections.money?.xero?.invoice_number,
  );
  console.log("--- patched evaluator over those live facts ---");
  console.log(
    "required routes   :",
    requiredSesRouteKinds("ordinary_roof_portal", false, "MLB", false).join(
      ", ",
    ),
  );
  console.log(
    "strict (old)      : blockers =",
    before.blockers.map((b) => b.code).join(", ") || "(none)",
    "| band",
    before.approval_band,
  );
  console.log(
    "ruled  (new)      : blockers =",
    after.blockers.map((b) => b.code).join(", ") || "(none)",
    "| clean",
    after.clean,
    "| band",
    after.approval_band,
  );
  console.log(
    "failed checks     :",
    after.checks.filter((c) => !c.passed).map((c) => c.id).join(", ") ||
      "(none)",
  );
  const approveInvoice = after.approval_band !== "decision_blocked" &&
    after.checks.filter((c) => c.id !== "C11").every((c) => c.passed);
  console.log("APPROVE INVOICE   :", approveInvoice ? "ENABLED" : "disabled");
  console.log(
    "SEND IT           :",
    after.clean && live.sections.money?.xero?.status === "AUTHORISED"
      ? "ENABLED"
      : `disabled until invoice AUTHORISED (now ${live.sections.money?.xero?.status})`,
  );

  // SENDABLE: the release the Captain would build after authorising. Pure
  // construction over the live routes — no write, no send, no Graph call.
  try {
    const plan = await buildSesReleaseRevision({
      org_id: "org-verify",
      members: [{
        job_id: card.job,
        docket_revision_id: "verify",
        invoice_obligation_revision_id: "verify",
        attendance_cycle_ids: ["verify"],
        readiness_revision: "sha256:" + "a".repeat(64),
        dependency_generation: 1,
      }],
      routes,
      created_by: "verify",
      builder_key: "MLB",
      family: "ordinary_roof_portal",
      photo_route_applicable: false,
      report_route_applicable: false,
    });
    console.log(
      "SENDABLE (release):",
      "BUILDS -",
      plan.routes.length,
      "route(s):",
      plan.routes.map((r: any) => r.route_kind).join(", "),
    );
  } catch (error) {
    console.log("SENDABLE (release):", "REFUSED -", (error as Error).message);
  }
  // Control: the same live routes under the OLD strict shape.
  try {
    await buildSesReleaseRevision({
      org_id: "org-verify",
      members: [{
        job_id: card.job,
        docket_revision_id: "verify",
        invoice_obligation_revision_id: "verify",
        attendance_cycle_ids: ["verify"],
        readiness_revision: "sha256:" + "a".repeat(64),
        dependency_generation: 1,
      }],
      routes,
      created_by: "verify",
      builder_key: "MLB",
    });
    console.log("  control (strict) :", "BUILDS (unexpected)");
  } catch (error) {
    console.log("  control (strict) :", "REFUSED -", (error as Error).message);
  }
}

// deno-lint-ignore-file no-import-prefix require-await
/**
 * T8 (Harden SES v1, AC7): APPROVE INVOICE must refuse a stale review. The
 * caller echoes the exact inspected docket revision id, invoice obligation
 * revision id and docket output/content hash; the action compares them against
 * the server-current docket BEFORE recording approval and refuses drift. The
 * human-JWT-only gate is untouched — an api_key / routine caller still cannot
 * approve, even with exactly-matching coordinates.
 */
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  approveSesInvoiceRevisionAction,
  SesActionError,
  sesInvoiceApprovalCoordinateDrift,
} from "./ses_reporting_actions.ts";
import type { SesSupabaseClient } from "./ses_reporting_actions.ts";
import type { SesCleanInput, SesCockpitDocket } from "./ses_review_cockpit.ts";

const OUTPUT_HASH =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// ── Pure drift helper ──

Deno.test("T8 drift: an exact echo of all three coordinates is not drift", () => {
  const verdict = sesInvoiceApprovalCoordinateDrift(
    {
      docket_revision_id: "d1",
      invoice_obligation_revision_id: "o1",
      output_content_hash: OUTPUT_HASH,
    },
    {
      docket_revision_id: "d1",
      invoice_obligation_revision_id: "o1",
      output_content_hash: OUTPUT_HASH,
    },
  );
  assertEquals(verdict.drifted, false);
  assertEquals(verdict.fields, []);
});

Deno.test("T8 drift: each mismatched coordinate is named", () => {
  const base = {
    docket_revision_id: "d1",
    invoice_obligation_revision_id: "o1",
    output_content_hash: OUTPUT_HASH,
  };
  assertEquals(
    sesInvoiceApprovalCoordinateDrift(
      { ...base, docket_revision_id: "d2" },
      base,
    )
      .fields,
    ["docket_revision_id"],
  );
  assertEquals(
    sesInvoiceApprovalCoordinateDrift(
      { ...base, invoice_obligation_revision_id: "o2" },
      base,
    ).fields,
    ["invoice_obligation_revision_id"],
  );
  assertEquals(
    sesInvoiceApprovalCoordinateDrift(
      { ...base, output_content_hash: "sha256:deadbeef" },
      base,
    ).fields,
    ["output_content_hash"],
  );
});

Deno.test("T8 drift: an absent echoed field never manufactures a false drift", () => {
  const actual = {
    docket_revision_id: "d1",
    invoice_obligation_revision_id: "o1",
    output_content_hash: OUTPUT_HASH,
  };
  // Only the docket revision is echoed; the missing fields are not compared.
  assertEquals(
    sesInvoiceApprovalCoordinateDrift({ docket_revision_id: "d1" }, actual)
      .drifted,
    false,
  );
  // A null echo is treated as not-supplied, not as an empty-string mismatch.
  assertEquals(
    sesInvoiceApprovalCoordinateDrift(
      { docket_revision_id: null, output_content_hash: OUTPUT_HASH },
      actual,
    ).drifted,
    false,
  );
});

// ── Action-level echo enforcement (injected docket loader) ──

function cleanInput(): SesCleanInput {
  return {
    pre_xero_docs_ready: true,
    readiness_ready: true,
    readiness_blockers: [],
    pricing_disposition: "priced_from_canon",
    line_overrides_audited: false,
    duplicate_allows_create: true,
    invoice_already_bound: false,
    duplicate_ambiguity: "none",
    money_blocker_codes: [],
    post_release_disposition_outstanding: false,
    family: "assessment_quote",
    family_matrix_version: "v1",
    assessment_recipe_version: "v1",
    portal_required: false,
    portal_capture_status: "not_applicable",
    own_document_exemption: true,
    physical_media_complete: true,
    completed_work_photo_proven: true,
    obligation_revision_count: 1,
    routes: [],
    photo_route_applicable: false,
    report_route_applicable: false,
    type_check_hold: false,
    story_unverified: false,
    trade_report_submitted: true,
    roof_report_required: false,
    roof_report_filled: false,
    report_only: false,
    builder_key: "MLB",
  };
}

function docket(): SesCockpitDocket {
  return {
    job_id: "job-1",
    job_number: "SWMS-1",
    docket_revision_id: "d1",
    docket_output_content_hash: OUTPUT_HASH,
    readiness_revision:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    dependency_generation: 1,
    invoice_obligation_revision_id: "o1",
    attendance_cycle_ids: ["cycle-1"],
    xero_binding: null,
    xero_invoice_pdf_available: false,
    existing_card_money: null,
    local_invoice_proposal: null,
    work_order: null,
    family_evidence: {},
    swms: {},
    routes: [],
    caveats: [],
    crew_and_trade_visits: { assignments: [], visit_reports: [] },
    clean_input: cleanInput(),
    release_send_progress: { kind: "none" },
  };
}

function rpcSpyClient(): { client: SesSupabaseClient; rpcCalls: string[] } {
  const rpcCalls: string[] = [];
  const client = {
    from() {
      throw new Error("no table read expected on the drift path");
    },
    rpc(name: string) {
      rpcCalls.push(name);
      return Promise.resolve({ data: { id: "approval-1" }, error: null });
    },
  } as unknown as SesSupabaseClient;
  return { client, rpcCalls };
}

Deno.test("T8 action refuses drifted echoed coordinates BEFORE any approval write", async () => {
  const { client, rpcCalls } = rpcSpyClient();
  const error = await assertRejects(
    () =>
      approveSesInvoiceRevisionAction(
        client,
        { mode: "jwt", user: { id: "u1", email: "captain@x", role: "admin" } },
        {
          org_id: "org-1",
          job_id: "job-1",
          includes_authorise: true,
          // Drifted: the operator inspected an OLDER docket revision.
          expected_docket_revision_id: "d0-stale",
          expected_invoice_obligation_revision_id: "o1",
          expected_output_content_hash: OUTPUT_HASH,
        },
        { loadDocket: async () => docket() },
      ),
    SesActionError,
  );
  assertEquals((error as SesActionError).status, 409);
  assertEquals(
    ((error as SesActionError).refusal as { code?: string }).code,
    "stale_review",
  );
  // The refusal fired before the approval RPC — nothing was recorded.
  assertEquals(rpcCalls, []);
});

Deno.test("T8 action refuses a drifted output content hash", async () => {
  const { client } = rpcSpyClient();
  const error = await assertRejects(
    () =>
      approveSesInvoiceRevisionAction(
        client,
        { mode: "jwt", user: { id: "u1", email: "captain@x", role: "admin" } },
        {
          org_id: "org-1",
          job_id: "job-1",
          includes_authorise: true,
          expected_docket_revision_id: "d1",
          expected_invoice_obligation_revision_id: "o1",
          expected_output_content_hash: "sha256:stalehash",
        },
        { loadDocket: async () => docket() },
      ),
    SesActionError,
  );
  assertEquals(
    ((error as SesActionError).refusal as { code?: string }).code,
    "stale_review",
  );
});

Deno.test("T8 action accepts an exact-match echo — then the human-JWT gate refuses an api_key caller", async () => {
  const { client, rpcCalls } = rpcSpyClient();
  const error = await assertRejects(
    () =>
      approveSesInvoiceRevisionAction(
        client,
        // A server helper key, not a human session.
        { mode: "api_key", user: null },
        {
          org_id: "org-1",
          job_id: "job-1",
          includes_authorise: true,
          // Exact match — so the echo gate does NOT fire; the auth gate does.
          expected_docket_revision_id: "d1",
          expected_invoice_obligation_revision_id: "o1",
          expected_output_content_hash: OUTPUT_HASH,
        },
        { loadDocket: async () => docket() },
      ),
    SesActionError,
  );
  assertEquals((error as SesActionError).status, 403);
  // It is NOT a stale_review — the exact-match echo passed the drift gate.
  assert(
    ((error as SesActionError).refusal as { code?: string }).code !==
      "stale_review",
  );
  assertEquals(rpcCalls, []);
});

Deno.test("T8 action refuses the routine automation key even with an exact-match echo", async () => {
  const { client } = rpcSpyClient();
  const error = await assertRejects(
    () =>
      approveSesInvoiceRevisionAction(
        client,
        { mode: "routine", user: null },
        {
          org_id: "org-1",
          job_id: "job-1",
          includes_authorise: true,
          expected_docket_revision_id: "d1",
          expected_invoice_obligation_revision_id: "o1",
          expected_output_content_hash: OUTPUT_HASH,
        },
        { loadDocket: async () => docket() },
      ),
    SesActionError,
  );
  assertEquals((error as SesActionError).status, 403);
});

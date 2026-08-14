// deno-lint-ignore-file no-import-prefix require-await
/**
 * T12 (Harden SES v1, AC2): the shared inspect read returns ONE identical truth
 * for both front doors — the literal main-pack pointer ids (report_doc_id most of
 * all, which the board payload hides and no other read exposes), the exact
 * current docket revision + hash, the invoice/recipe context the Maverick
 * five-card manifest needs, the frozen release manifest identity, delivery
 * proofs and the approval/audit state.
 */
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assembleSesPackInspection,
  inspectSesPackAction,
} from "./ses_inspect_pack.ts";
import {
  SesActionError,
  type SesSupabaseClient,
} from "./ses_reporting_actions.ts";
import type { SesCockpitDocket } from "./ses_review_cockpit.ts";

const RELEASE_HASH =
  "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const BODY_HASH =
  "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const ENVELOPE_HASH =
  "sha256:3333333333333333333333333333333333333333333333333333333333333333";
const PROOF_HASH =
  "sha256:4444444444444444444444444444444444444444444444444444444444444444";
const OUTPUT_HASH =
  "sha256:5555555555555555555555555555555555555555555555555555555555555555";

function assembleInput(overrides: Record<string, unknown> = {}) {
  return {
    job_id: "job-1",
    job_number: "SWMS-261021",
    docket: {
      docket_revision_id: "docket-rev-1",
      output_content_hash: OUTPUT_HASH,
      invoice_obligation_revision_id: "obl-1",
      readiness_revision:
        "sha256:6666666666666666666666666666666666666666666666666666666666666666",
      dependency_generation: 7,
    },
    xero_binding: {
      xero_invoice_id: "xero-1",
      invoice_number: "INV-1115",
      status: "DRAFT",
      total: 464.75,
    },
    xero_invoice_pdf_available: true,
    local_invoice_proposal: {
      reference: "MLB-27037",
      total_inc_gst: 464.75,
    },
    docket_routes: [
      {
        route_kind: "invoice",
        recipients: ["makesafes@builder.example"],
        cc: ["finance@builder.example"],
        subject: "Invoice for SWMS-261021",
        attachment_hashes: [BODY_HASH],
        ready: true,
      },
    ],
    release_send_progress: { kind: "none" as const },
    pack_row: {
      status: "pending",
      report_doc_id: "report-doc-abc",
      invoice_doc_id: "invoice-doc-xyz",
      swms_doc_id: "swms-doc-123",
      sent_at: null,
      send_started_at: null,
    },
    release_row: null,
    member_rows: [],
    route_rows: [],
    proof_rows: [],
    approval_rows: [],
    review_row: null,
    audit_rows: [],
    ...overrides,
  };
}

Deno.test("T12 assembler surfaces the literal SET report_doc_id + invoice + recipe", () => {
  const result = assembleSesPackInspection(assembleInput());
  assertEquals(result.schema, "secureworks.makesafe.ses-pack-inspection/v1");
  // The whole reason this read exists: expose the literal report_doc_id.
  assertEquals(result.pack.report_doc_id, "report-doc-abc");
  assertEquals(result.pack.invoice_doc_id, "invoice-doc-xyz");
  assertEquals(result.pack.swms_doc_id, "swms-doc-123");
  assertEquals(result.pack.exists, true);
  // Exact docket coordinates a door echoes back at APPROVE.
  assertEquals(result.docket.docket_revision_id, "docket-rev-1");
  assertEquals(result.docket.output_content_hash, OUTPUT_HASH);
  assertEquals(result.docket.invoice_obligation_revision_id, "obl-1");
  // Invoice status / reference / doc — the manifest's approve/send inputs.
  assertEquals(result.invoice.doc_id, "invoice-doc-xyz");
  assertEquals(result.invoice.status, "DRAFT");
  assertEquals(result.invoice.number, "INV-1115");
  assertEquals(result.invoice.reference, "MLB-27037");
  assertEquals(result.invoice.total, 464.75);
  assertEquals(result.invoice.pdf_available, true);
  // Send-recipe context.
  assertEquals(result.send_recipe.length, 1);
  assertEquals(result.send_recipe[0].route_kind, "invoice");
  assertEquals(result.send_recipe[0].recipients, ["makesafes@builder.example"]);
  assertEquals(result.send_recipe[0].attachment_count, 1);
});

Deno.test("T12 assembler surfaces the literal NULL report_doc_id (unbound card)", () => {
  const result = assembleSesPackInspection(
    assembleInput({
      pack_row: {
        status: "pending",
        report_doc_id: null,
        invoice_doc_id: null,
        swms_doc_id: "swms-doc-123",
        sent_at: null,
        send_started_at: null,
      },
    }),
  );
  // The five-card bind gap: a typed report attached but NO bound pointer.
  assertEquals(result.pack.report_doc_id, null);
  assertEquals(result.pack.invoice_doc_id, null);
  assertEquals(result.pack.exists, true);
});

Deno.test("T12 assembler reports pack.exists=false when there is no main pack", () => {
  const result = assembleSesPackInspection(assembleInput({ pack_row: null }));
  assertEquals(result.pack.exists, false);
  assertEquals(result.pack.report_doc_id, null);
  assertEquals(result.pack.invoice_doc_id, null);
  assertEquals(result.pack.swms_doc_id, null);
});

Deno.test("T12 assembler surfaces the frozen release manifest identity + proofs + audit", () => {
  const result = assembleSesPackInspection(
    assembleInput({
      release_row: {
        id: "release-1",
        content_hash: RELEASE_HASH,
        state: "approved",
      },
      member_rows: [
        {
          job_id: "job-1",
          docket_revision_id: "docket-rev-1",
          invoice_obligation_revision_id: "obl-1",
          ordinal: 0,
        },
      ],
      route_rows: [
        {
          route_kind: "invoice",
          ordinal: 0,
          required: true,
          recipients: ["makesafes@builder.example"],
          cc: ["finance@builder.example"],
          subject: "Invoice for SWMS-261021",
          body_hash: BODY_HASH,
          attachment_hashes: [BODY_HASH],
          envelope_hash: ENVELOPE_HASH,
        },
      ],
      proof_rows: [
        {
          route_kind: "invoice",
          proof_hash: PROOF_HASH,
          proven_at: "2026-08-14T00:00:00Z",
          external_message_id: "msg-1",
        },
      ],
      approval_rows: [
        {
          action: "invoice",
          decision: "approved",
          docket_revision_id: "docket-rev-1",
          invoice_obligation_revision_id: "obl-1",
          release_revision_id: null,
          approval_content_hash: OUTPUT_HASH,
          includes_authorise: true,
          decided_by: "captain@example",
          decided_at: "2026-08-14T00:00:00Z",
        },
      ],
    }),
  );
  assertExists(result.release);
  assertEquals(result.release?.release_revision_id, "release-1");
  assertEquals(result.release?.content_hash, RELEASE_HASH);
  assertEquals(result.release?.state, "approved");
  assertEquals(result.release?.routes[0].recipients, [
    "makesafes@builder.example",
  ]);
  assertEquals(result.release?.routes[0].body_hash, BODY_HASH);
  assertEquals(result.release?.routes[0].attachment_hashes, [BODY_HASH]);
  assertEquals(result.route_proofs.length, 1);
  assertEquals(result.route_proofs[0].proof_hash, PROOF_HASH);
  assertEquals(result.approvals.length, 1);
  assertEquals(result.approvals[0].action, "invoice");
  assertEquals(result.approvals[0].includes_authorise, true);
});

// ── Reader-wiring integration: a synthetic prepared pack on a fake client ──

function fakeDocket(
  overrides: Partial<SesCockpitDocket> = {},
): SesCockpitDocket {
  return {
    job_id: "job-1",
    job_number: "SWMS-261021",
    docket_revision_id: "docket-rev-1",
    docket_output_content_hash: OUTPUT_HASH,
    readiness_revision:
      "sha256:6666666666666666666666666666666666666666666666666666666666666666",
    dependency_generation: 7,
    invoice_obligation_revision_id: "obl-1",
    attendance_cycle_ids: ["cycle-1"],
    xero_binding: {
      xero_invoice_id: "xero-1",
      invoice_number: "INV-1115",
      status: "DRAFT",
      total: 464.75,
    },
    xero_invoice_pdf_available: true,
    local_invoice_proposal: { reference: "MLB-27037", total_inc_gst: 464.75 },
    work_order: null,
    family_evidence: {},
    swms: {},
    routes: [
      {
        route_kind: "invoice",
        recipients: ["makesafes@builder.example"],
        cc: [],
        subject: "Invoice for SWMS-261021",
        body: "body",
        attachment_hashes: [BODY_HASH],
        ready: true,
      },
    ],
    caveats: [],
    crew_and_trade_visits: { assignments: [], visit_reports: [] },
    // Not read by inspect; a minimal placeholder keeps the shape valid.
    clean_input: {} as SesCockpitDocket["clean_input"],
    release_send_progress: {
      kind: "partially_released",
      release_revision_id: "release-1",
      release_state: "dispatching",
      proved_route_kinds: [],
      required_route_kinds: ["invoice"],
      missing_route_kinds: ["invoice"],
    },
    ...overrides,
  } as SesCockpitDocket;
}

type TableRows = (filters: Record<string, unknown>) => {
  data: unknown;
  error: unknown;
};

function fakeClient(tables: Record<string, TableRows>): SesSupabaseClient {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const resolve = (single: boolean) => {
        const handler = tables[table];
        if (!handler) {
          return { data: single ? null : [], error: null };
        }
        const result = handler(filters);
        if (single) {
          const rows = Array.isArray(result.data) ? result.data : result.data;
          return {
            data: Array.isArray(rows) ? (rows[0] ?? null) : rows,
            error: result.error,
          };
        }
        return { data: result.data ?? [], error: result.error };
      };
      const builder: Record<string, unknown> = {
        select() {
          return builder;
        },
        eq(col: string, val: unknown) {
          filters[col] = val;
          return builder;
        },
        order() {
          return builder;
        },
        maybeSingle() {
          return Promise.resolve(resolve(true));
        },
        then(
          onFulfilled: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) {
          return Promise.resolve(resolve(false)).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  } as unknown as SesSupabaseClient;
}

async function expectSesActionError(
  action: () => Promise<unknown>,
): Promise<SesActionError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof SesActionError) return error;
    throw error;
  }
  throw new Error("expected SesActionError");
}

function releaseInspectClient(
  memberRows: Array<Record<string, unknown>>,
  releaseRow: Record<string, unknown> | null = {
    id: "release-1",
    content_hash: RELEASE_HASH,
    state: "approved",
  },
): SesSupabaseClient {
  return fakeClient({
    makesafe_report_packs: () => ({ data: null, error: null }),
    makesafe_release_revisions: () => ({ data: releaseRow, error: null }),
    makesafe_release_revision_members: () => ({
      data: memberRows,
      error: null,
    }),
    makesafe_release_revision_routes: () => ({ data: [], error: null }),
    ses_release_route_proofs: () => ({ data: [], error: null }),
  });
}

Deno.test("T12 inspect action assembles a prepared pack from the canonical readers", async () => {
  const client = fakeClient({
    makesafe_report_packs: () => ({
      data: {
        status: "pending",
        report_doc_id: "report-doc-abc",
        invoice_doc_id: "invoice-doc-xyz",
        swms_doc_id: "swms-doc-123",
        sent_at: null,
        send_started_at: null,
      },
      error: null,
    }),
    makesafe_release_revisions: () => ({
      data: { id: "release-1", content_hash: RELEASE_HASH, state: "approved" },
      error: null,
    }),
    makesafe_release_revision_members: () => ({
      data: [{
        job_id: "job-1",
        docket_revision_id: "docket-rev-1",
        invoice_obligation_revision_id: "obl-1",
        ordinal: 0,
      }],
      error: null,
    }),
    makesafe_release_revision_routes: () => ({
      data: [{
        route_kind: "invoice",
        ordinal: 0,
        required: true,
        recipients: ["makesafes@builder.example"],
        cc: [],
        subject: "Invoice for SWMS-261021",
        body_hash: BODY_HASH,
        attachment_hashes: [BODY_HASH],
        envelope_hash: ENVELOPE_HASH,
      }],
      error: null,
    }),
    ses_release_route_proofs: () => ({
      data: [{
        route_kind: "invoice",
        proof_hash: PROOF_HASH,
        proven_at: "2026-08-14T00:00:00Z",
        external_message_id: "msg-1",
      }],
      error: null,
    }),
    makesafe_revision_approvals_current_v2: () => ({
      data: [{
        action: "release",
        decision: "approved",
        docket_revision_id: "docket-rev-1",
        invoice_obligation_revision_id: "obl-1",
        release_revision_id: "release-1",
        approval_content_hash: RELEASE_HASH,
        includes_authorise: false,
        decided_by: "captain@example",
        decided_at: "2026-08-14T00:00:00Z",
      }],
      error: null,
    }),
  });

  const result = await inspectSesPackAction(client, "job-1", null, {
    loadDocket: async () => fakeDocket(),
  });

  assertEquals(result.job_id, "job-1");
  assertEquals(result.pack.report_doc_id, "report-doc-abc");
  assertEquals(result.docket.output_content_hash, OUTPUT_HASH);
  assertEquals(result.invoice.reference, "MLB-27037");
  // The release id was resolved from release_send_progress (no override passed).
  assertEquals(result.release?.release_revision_id, "release-1");
  assertEquals(result.release?.content_hash, RELEASE_HASH);
  assertEquals(result.route_proofs.length, 1);
  assertEquals(result.approvals.length, 1);
  assertEquals(result.release_send_progress.kind, "partially_released");
});

Deno.test("T12 inspect action surfaces a NULL report_doc_id on an unbound prepared card", async () => {
  const client = fakeClient({
    makesafe_report_packs: () => ({
      data: {
        status: "pending",
        report_doc_id: null,
        invoice_doc_id: null,
        swms_doc_id: null,
        sent_at: null,
        send_started_at: null,
      },
      error: null,
    }),
    makesafe_revision_approvals_current_v2: () => ({ data: [], error: null }),
  });

  const result = await inspectSesPackAction(client, "job-1", null, {
    loadDocket: async () =>
      fakeDocket({ release_send_progress: { kind: "none" } }),
  });

  assertEquals(result.pack.report_doc_id, null);
  assertEquals(result.pack.exists, true);
  assertEquals(result.release, null);
  assertEquals(result.release_send_progress.kind, "none");
});

Deno.test("T12 inspect action refuses a missing release override", async () => {
  const error = await expectSesActionError(() =>
    inspectSesPackAction(
      releaseInspectClient([], null),
      "job-1",
      "release-missing",
      { loadDocket: async () => fakeDocket() },
    )
  );
  const refusal = error.refusal as {
    code?: string;
    evidence?: Record<string, unknown>;
  };
  assertEquals(error.status, 409);
  assertEquals(refusal.code, "stale_review");
  assertEquals(refusal.evidence?.reason, "release_revision_missing");
});

Deno.test("T12 inspect action refuses a foreign release override", async () => {
  const error = await expectSesActionError(() =>
    inspectSesPackAction(
      releaseInspectClient([{
        job_id: "job-foreign",
        docket_revision_id: "docket-foreign",
        invoice_obligation_revision_id: "obl-foreign",
        ordinal: 0,
      }]),
      "job-1",
      "release-1",
      { loadDocket: async () => fakeDocket() },
    )
  );
  const refusal = error.refusal as {
    code?: string;
    evidence?: Record<string, unknown>;
  };
  assertEquals(error.status, 409);
  assertEquals(refusal.code, "stale_review");
  assertEquals(refusal.evidence?.reason, "release_job_membership_mismatch");
});

Deno.test("T12 inspect action refuses stale release member coordinates", async () => {
  for (
    const member of [
      {
        job_id: "job-1",
        docket_revision_id: "docket-stale",
        invoice_obligation_revision_id: "obl-1",
        ordinal: 0,
      },
      {
        job_id: "job-1",
        docket_revision_id: "docket-rev-1",
        invoice_obligation_revision_id: "obl-stale",
        ordinal: 0,
      },
    ]
  ) {
    const error = await expectSesActionError(() =>
      inspectSesPackAction(
        releaseInspectClient([member]),
        "job-1",
        "release-1",
        { loadDocket: async () => fakeDocket() },
      )
    );
    const refusal = error.refusal as {
      code?: string;
      evidence?: Record<string, unknown>;
    };
    assertEquals(error.status, 409);
    assertEquals(refusal.code, "stale_review");
    assertEquals(refusal.evidence?.reason, "release_member_coordinates_stale");
  }
});

Deno.test("T12 inspect action returns canonical docket signoff and ordered audit parity", async () => {
  const reviewRow = {
    org_id: "org-1",
    job_id: "job-1",
    docket_revision_id: "docket-rev-1",
    docket_output_content_hash: OUTPUT_HASH,
    assembler_version: "assembler-v1",
    family_matrix_version: "family-v1",
    docket_stage: "pre_xero",
    docket_committed_at: "2026-08-14T00:00:00Z",
    review_event_id: "review-2",
    review_event_sequence: 2,
    review_state: "signed_off",
    event_kind: "signed_off",
    actor_user_id: "captain-1",
    actor_identity: "captain@example",
    reason: null,
    signed_off_at: "2026-08-14T00:02:00Z",
    review_state_changed_at: "2026-08-14T00:02:00Z",
    invalidated_signoff_event_id: null,
  };
  const preparedEvent = {
    id: "review-1",
    event_sequence: 1,
    review_state: "needs_review",
    event_kind: "prepared",
    actor_user_id: null,
    actor_identity: "system",
    reason: null,
    signed_off_at: null,
    created_at: "2026-08-14T00:01:00Z",
    docket_output_content_hash: OUTPUT_HASH,
    assembler_version: "assembler-v1",
    family_matrix_version: "family-v1",
    invalidated_signoff_event_id: null,
  };
  const signoffEvent = {
    id: "review-2",
    event_sequence: 2,
    review_state: "signed_off",
    event_kind: "signed_off",
    actor_user_id: "captain-1",
    actor_identity: "captain@example",
    reason: null,
    signed_off_at: "2026-08-14T00:02:00Z",
    created_at: "2026-08-14T00:02:00Z",
    docket_output_content_hash: OUTPUT_HASH,
    assembler_version: "assembler-v1",
    family_matrix_version: "family-v1",
    invalidated_signoff_event_id: null,
  };
  const client = fakeClient({
    makesafe_report_packs: () => ({ data: null, error: null }),
    makesafe_revision_approvals_current_v2: () => ({
      data: [],
      error: null,
    }),
    ses_docket_review_current: () => ({ data: reviewRow, error: null }),
    // Deliberately reversed: the T12 contract guarantees canonical event order.
    ses_docket_review_events: () => ({
      data: [signoffEvent, preparedEvent],
      error: null,
    }),
  });

  const result = await inspectSesPackAction(client, "job-1", null, {
    loadDocket: async () =>
      fakeDocket({ release_send_progress: { kind: "none" } }),
  });

  assertEquals(result.review?.review_state, "signed_off");
  assertEquals(result.review?.review_event_id, "review-2");
  assertEquals(result.review?.docket_revision_id, "docket-rev-1");
  assertEquals(
    result.audit_trail.map((event) => [
      event.event_sequence,
      event.event_kind,
      event.review_state,
    ]),
    [
      [1, "prepared", "needs_review"],
      [2, "signed_off", "signed_off"],
    ],
  );
  assertEquals(result.audit_trail[1].actor_identity, "captain@example");
});

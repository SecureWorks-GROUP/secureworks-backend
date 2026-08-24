// deno-lint-ignore-file no-explicit-any no-import-prefix
/**
 * Jolimont SWMS-261289 class — pack.sent_at stamp from proved SES release routes.
 */
import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  planMakesafePackSentFromRouteProofs,
  stampMakesafePackSentFromRouteProofs,
} from "./makesafe_pack_sent_from_route_proofs.ts";
import { assembleSesPackInspection } from "./ses_inspect_pack.ts";

const JOB = "7c3e19db-6a32-45ed-abce-602388fb8576";
const RELEASE = "df2eaa0a-480d-50c6-af81-9e18c5c9c956";
const PROOFS = [
  {
    route_kind: "report_invoice",
    proven_at: "2026-08-24T06:10:28.273Z",
    external_message_id: "msg-1",
  },
  {
    route_kind: "photo",
    proven_at: "2026-08-24T06:10:44.411Z",
    external_message_id: "msg-2",
  },
];

Deno.test("plan: drafted pack + released progress + proved routes is stampable", () => {
  const plan = planMakesafePackSentFromRouteProofs({
    job_id: JOB,
    pack: { id: "pack-1", job_id: JOB, pack_kind: "main", status: "drafted", sent_at: null },
    proofs: PROOFS,
    release_progress: {
      kind: "released",
      release_revision_id: RELEASE,
      required_route_kinds: ["photo", "report_invoice"],
      proved_route_kinds: ["photo", "report_invoice"],
    },
  });
  assertEquals(plan.stampable, true);
  assertEquals(plan.proven_at, "2026-08-24T06:10:28.273Z");
  assertEquals(plan.refusal_code, null);
});

Deno.test("plan: already-sent pack is not restamped", () => {
  const plan = planMakesafePackSentFromRouteProofs({
    job_id: JOB,
    pack: {
      id: "pack-1",
      status: "sent",
      sent_at: "2026-08-24T06:10:28.273Z",
    },
    proofs: PROOFS,
    release_progress: {
      kind: "released",
      required_route_kinds: ["photo", "report_invoice"],
      proved_route_kinds: ["photo", "report_invoice"],
    },
  });
  assertEquals(plan.stampable, false);
  assertEquals(plan.refusal_code, "already_sent");
});

Deno.test("plan: missing required route proof refuses", () => {
  const plan = planMakesafePackSentFromRouteProofs({
    job_id: JOB,
    pack: { id: "pack-1", status: "drafted", sent_at: null },
    proofs: [PROOFS[0]],
    release_progress: {
      kind: "released",
      required_route_kinds: ["photo", "report_invoice"],
      proved_route_kinds: ["report_invoice"],
    },
  });
  assertEquals(plan.stampable, false);
  assertEquals(plan.refusal_code, "required_routes_unproved");
});

Deno.test("plan: no proofs refuses", () => {
  const plan = planMakesafePackSentFromRouteProofs({
    job_id: JOB,
    pack: { id: "pack-1", status: "drafted", sent_at: null },
    proofs: [],
    release_progress: {
      kind: "released",
      required_route_kinds: [],
      proved_route_kinds: [],
    },
  });
  assertEquals(plan.stampable, false);
  assertEquals(plan.refusal_code, "no_proof");
});

Deno.test("stamp dry_run would_stamp without writing", async () => {
  const updates: any[] = [];
  const client = {
    from(table: string) {
      const api: any = {
        select: () => api,
        eq: () => api,
        is: () => api,
        maybeSingle: async () => ({
          data: table === "makesafe_report_packs"
            ? { id: "pack-1", job_id: JOB, pack_kind: "main", status: "drafted", sent_at: null }
            : null,
          error: null,
        }),
        update(patch: any) {
          updates.push(patch);
          return {
            eq: () => ({
              eq: () => ({
                is: () => ({
                  select: async () => ({ data: [{ id: "pack-1", status: "sent" }], error: null }),
                }),
              }),
            }),
          };
        },
        insert: async () => ({ error: null }),
      };
      return api;
    },
  };
  const outcome = await stampMakesafePackSentFromRouteProofs(client, JOB, PROOFS, {
    releaseRevisionId: RELEASE,
    dryRun: true,
    releaseProgress: {
      kind: "released",
      required_route_kinds: ["photo", "report_invoice"],
      proved_route_kinds: ["photo", "report_invoice"],
    },
  });
  assertEquals(outcome.outcome, "would_stamp");
  assertEquals(outcome.after_status, "sent");
  assertEquals(updates.length, 0);
});

Deno.test("inspect overlays drafted pack as sent when release is fully proved", () => {
  const inspection = assembleSesPackInspection({
    job_id: JOB,
    job_number: "SWMS-261289",
    docket: {
      docket_revision_id: "d1",
      output_content_hash: "sha256:" + "a".repeat(64),
      invoice_obligation_revision_id: null,
      readiness_revision: "sha256:" + "b".repeat(64),
      dependency_generation: 1,
    },
    xero_binding: {
      xero_invoice_id: "x1",
      invoice_number: "INV-1309",
      status: "AUTHORISED",
      total: 313.5,
    },
    xero_invoice_pdf_available: true,
    local_invoice_proposal: null,
    docket_routes: [],
    release_send_progress: {
      kind: "released",
      release_revision_id: RELEASE,
      release_state: "released",
      proved_route_kinds: ["photo", "report_invoice"],
      required_route_kinds: ["photo", "report_invoice"],
    },
    pack_row: {
      status: "drafted",
      report_doc_id: "r1",
      invoice_doc_id: "i1",
      swms_doc_id: null,
      sent_at: null,
      send_started_at: null,
    },
    release_row: { id: RELEASE, content_hash: "sha256:c", state: "released" },
    member_rows: [{ job_id: JOB, docket_revision_id: "d1", ordinal: 0 }],
    route_rows: [],
    proof_rows: PROOFS,
    approval_rows: [],
    review_row: null,
    audit_rows: [],
  });
  assertEquals(inspection.pack.status, "sent");
  assertEquals(inspection.pack.sent_at, "2026-08-24T06:10:28.273Z");
});

Deno.test("inspect keeps drafted when release is not released", () => {
  const inspection = assembleSesPackInspection({
    job_id: JOB,
    job_number: "SWMS-261289",
    docket: {
      docket_revision_id: "d1",
      output_content_hash: "sha256:" + "a".repeat(64),
      invoice_obligation_revision_id: null,
      readiness_revision: "sha256:" + "b".repeat(64),
      dependency_generation: 1,
    },
    xero_binding: null as any,
    local_invoice_proposal: null,
    docket_routes: [],
    release_send_progress: { kind: "none" },
    pack_row: {
      status: "drafted",
      report_doc_id: "r1",
      invoice_doc_id: "i1",
      swms_doc_id: null,
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
  });
  assertEquals(inspection.pack.status, "drafted");
  assertEquals(inspection.pack.sent_at, null);
});

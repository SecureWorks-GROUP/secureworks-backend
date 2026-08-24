// deno-lint-ignore-file no-explicit-any no-import-prefix
/**
 * Jolimont SWMS-261289 class — pack.sent_at stamp from proved SES release routes.
 *
 * Hostile regressions F1–F4 (PR 756 review): empty required, defaulted
 * released/[], caller-asserted proved kinds, and already_sent substatus advance
 * must never let a never-emailed card gain sent_at / look complete.
 */
import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  mayAdvanceSubstatusFromPackStamp,
  planMakesafePackSentFromRouteProofs,
  repairMakesafePackSentFromRouteProofsAction,
  stampMakesafePackSentFromRouteProofs,
} from "./makesafe_pack_sent_from_route_proofs.ts";
import { assembleSesPackInspection } from "./ses_inspect_pack.ts";

const JOB = "7c3e19db-6a32-45ed-abce-602388fb8576";
const RELEASE = "df2eaa0a-480d-50c6-af81-9e18c5c9c956";
const RELEASE_FOREIGN = "ffffffff-1111-2222-3333-444444444444";
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

Deno.test("plan: no proofs with non-empty required refuses no_proof", () => {
  const plan = planMakesafePackSentFromRouteProofs({
    job_id: JOB,
    pack: { id: "pack-1", status: "drafted", sent_at: null },
    proofs: [],
    release_progress: {
      kind: "released",
      required_route_kinds: ["photo", "report_invoice"],
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

// ---------------------------------------------------------------------------
// F1 — empty required_route_kinds must never bypass the release-state gate
// ---------------------------------------------------------------------------

Deno.test("F1: empty required_route_kinds refuses even when release is released", () => {
  const plan = planMakesafePackSentFromRouteProofs({
    job_id: JOB,
    pack: { id: "pack-1", status: "drafted", sent_at: null },
    proofs: PROOFS,
    release_progress: {
      kind: "released",
      release_revision_id: RELEASE,
      required_route_kinds: [],
      proved_route_kinds: ["photo", "report_invoice"],
    },
  });
  assertEquals(plan.stampable, false);
  assertEquals(plan.refusal_code, "required_routes_empty");
});

Deno.test("F1: empty required + non-released also refuses (release gate not skipped)", () => {
  const plan = planMakesafePackSentFromRouteProofs({
    job_id: JOB,
    pack: { id: "pack-1", status: "drafted", sent_at: null },
    proofs: PROOFS,
    release_progress: {
      kind: "dispatching",
      release_revision_id: RELEASE,
      required_route_kinds: [],
      proved_route_kinds: ["photo"],
    },
  });
  assertEquals(plan.stampable, false);
  // Empty required fails first; either way the card must not stamp.
  assertEquals(
    ["required_routes_empty", "release_not_released"].includes(
      String(plan.refusal_code),
    ),
    true,
  );
});

Deno.test("F1: non-released with full required set refuses release_not_released", () => {
  const plan = planMakesafePackSentFromRouteProofs({
    job_id: JOB,
    pack: { id: "pack-1", status: "drafted", sent_at: null },
    proofs: PROOFS,
    release_progress: {
      kind: "dispatching",
      release_revision_id: RELEASE,
      required_route_kinds: ["photo", "report_invoice"],
    },
  });
  assertEquals(plan.stampable, false);
  assertEquals(plan.refusal_code, "release_not_released");
});

// ---------------------------------------------------------------------------
// F2 — stamp() must not default kind=released or required=[]
// ---------------------------------------------------------------------------

Deno.test("F2: stamp without releaseProgress refuses (no released/[] defaults)", async () => {
  const updates: any[] = [];
  const client = {
    from(_table: string) {
      const api: any = {
        select: () => api,
        eq: () => api,
        is: () => api,
        maybeSingle: async () => ({
          data: {
            id: "pack-1",
            job_id: JOB,
            pack_kind: "main",
            status: "drafted",
            sent_at: null,
          },
          error: null,
        }),
        update(patch: any) {
          updates.push(patch);
          return {
            eq: () => ({
              eq: () => ({
                is: () => ({
                  select: async () => ({
                    data: [{ id: "pack-1", status: "sent" }],
                    error: null,
                  }),
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
  // Proofs-only call used to invent kind:"released" + required:[] and stamp.
  const outcome = await stampMakesafePackSentFromRouteProofs(client, JOB, PROOFS, {
    releaseRevisionId: RELEASE,
  });
  assertEquals(outcome.stampable, false);
  assertEquals(outcome.outcome, "no_proof");
  assertEquals(
    ["required_routes_empty", "release_progress_required"].includes(
      String(outcome.refusal_code),
    ),
    true,
  );
  assertEquals(updates.length, 0);
});

Deno.test("F2: stamp with kind but missing required refuses required_routes_empty", async () => {
  const client = {
    from(_table: string) {
      const api: any = {
        select: () => api,
        eq: () => api,
        maybeSingle: async () => ({
          data: {
            id: "pack-1",
            job_id: JOB,
            pack_kind: "main",
            status: "drafted",
            sent_at: null,
          },
          error: null,
        }),
      };
      return api;
    },
  };
  const outcome = await stampMakesafePackSentFromRouteProofs(client, JOB, PROOFS, {
    releaseRevisionId: RELEASE,
    releaseProgress: { kind: "released" },
  });
  assertEquals(outcome.stampable, false);
  assertEquals(outcome.refusal_code, "required_routes_empty");
  assertEquals(outcome.outcome, "no_proof");
});

// ---------------------------------------------------------------------------
// F3 — completeness trusts proof rows, never caller-asserted proved kinds
// ---------------------------------------------------------------------------

Deno.test("F3: caller-asserted proved_route_kinds cannot cover missing proof rows", () => {
  const plan = planMakesafePackSentFromRouteProofs({
    job_id: JOB,
    pack: { id: "pack-1", status: "drafted", sent_at: null },
    // Only report_invoice is actually proved on a row.
    proofs: [PROOFS[0]],
    release_progress: {
      kind: "released",
      release_revision_id: RELEASE,
      required_route_kinds: ["photo", "report_invoice"],
      // Lie: claim photo is proved too.
      proved_route_kinds: ["photo", "report_invoice"],
    },
  });
  assertEquals(plan.stampable, false);
  assertEquals(plan.refusal_code, "required_routes_unproved");
  assertEquals(plan.proved_route_kinds, ["report_invoice"]);
});

Deno.test("F3: proof row without parseable proven_at does not count as proved", () => {
  const plan = planMakesafePackSentFromRouteProofs({
    job_id: JOB,
    pack: { id: "pack-1", status: "drafted", sent_at: null },
    proofs: [
      PROOFS[0],
      { route_kind: "photo", proven_at: null, external_message_id: "msg-2" },
    ],
    release_progress: {
      kind: "released",
      required_route_kinds: ["photo", "report_invoice"],
      proved_route_kinds: ["photo", "report_invoice"],
    },
  });
  assertEquals(plan.stampable, false);
  assertEquals(plan.refusal_code, "required_routes_unproved");
  assertEquals(plan.proved_route_kinds, ["report_invoice"]);
});

// ---------------------------------------------------------------------------
// F4 — already_sent must not advance substatus
// ---------------------------------------------------------------------------

Deno.test("F4: already_sent must not advance substatus", () => {
  assertEquals(
    mayAdvanceSubstatusFromPackStamp({ outcome: "already_sent", dry_run: false }),
    false,
  );
  assertEquals(
    mayAdvanceSubstatusFromPackStamp({ outcome: "already_sent", dry_run: true }),
    false,
  );
  assertEquals(
    mayAdvanceSubstatusFromPackStamp({ outcome: "no_proof", dry_run: false }),
    false,
  );
  assertEquals(
    mayAdvanceSubstatusFromPackStamp({ outcome: "would_stamp", dry_run: false }),
    false,
  );
});

Deno.test("F4: only stamped (or dry-run would_stamp) may advance substatus", () => {
  assertEquals(
    mayAdvanceSubstatusFromPackStamp({ outcome: "stamped", dry_run: false }),
    true,
  );
  assertEquals(
    mayAdvanceSubstatusFromPackStamp({ outcome: "would_stamp", dry_run: true }),
    true,
  );
});

// ---------------------------------------------------------------------------
// Membership bind — foreign release_revision_id must not stamp this job
// ---------------------------------------------------------------------------

Deno.test("repair: foreign release_revision_id refuses release_job_mismatch", async () => {
  const client = {
    from(table: string) {
      const api: any = {
        select: () => api,
        eq: () => api,
        in: () => api,
        order: () => api,
        maybeSingle: async () => ({ data: null, error: null }),
        then: undefined,
      };
      // Make the chain thenable for await client.from(...).select...eq...order()
      const terminal = {
        ...api,
        then(
          resolve: (v: any) => any,
          reject?: (e: any) => any,
        ) {
          if (table === "makesafe_release_revision_members") {
            return Promise.resolve({
              data: [{ release_revision_id: RELEASE }],
              error: null,
            }).then(resolve, reject);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        },
      };
      return {
        select: () => ({
          eq: () => ({
            order: () => terminal,
            maybeSingle: async () => ({ data: null, error: null }),
          }),
          in: () => ({
            order: () => terminal,
          }),
        }),
      };
    },
  };

  let code: string | null = null;
  try {
    await repairMakesafePackSentFromRouteProofsAction(client, {
      job_id: JOB,
      release_revision_id: RELEASE_FOREIGN,
      dry_run: true,
    });
  } catch (err: any) {
    code = err?.code || null;
  }
  assertEquals(code, "release_job_mismatch");
});

Deno.test("repair: never falls back to a non-released revision", async () => {
  const client = {
    from(table: string) {
      const membersTerminal = {
        then(
          resolve: (v: any) => any,
          reject?: (e: any) => any,
        ) {
          return Promise.resolve({
            data: [{ release_revision_id: RELEASE }],
            error: null,
          }).then(resolve, reject);
        },
      };
      const releasesTerminal = {
        then(
          resolve: (v: any) => any,
          reject?: (e: any) => any,
        ) {
          return Promise.resolve({
            // Only a dispatching revision — must refuse, not fall back.
            data: [{ id: RELEASE, state: "dispatching", updated_at: "2026-08-24T00:00:00Z" }],
            error: null,
          }).then(resolve, reject);
        },
      };
      return {
        select: () => ({
          eq: (_col: string, _val: string) => ({
            order: () => membersTerminal,
            maybeSingle: async () => ({ data: null, error: null }),
          }),
          in: () => ({
            order: () => releasesTerminal,
          }),
        }),
      };
    },
  };

  let code: string | null = null;
  try {
    await repairMakesafePackSentFromRouteProofsAction(client, {
      job_id: JOB,
      dry_run: true,
    });
  } catch (err: any) {
    code = err?.code || null;
  }
  assertEquals(code, "release_not_released");
});

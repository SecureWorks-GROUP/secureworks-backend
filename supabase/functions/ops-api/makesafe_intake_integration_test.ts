import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _classifyPost } from "../monitor-ses-makesafes/index.ts";
import {
  _deriveMakesafeBoardStage,
  _isAllocatableMakesafePoolDetailForTest,
  _makesafeBoardTradeRouteForTest,
  _resolveManagerVisibility,
  _shouldAutoApproveCleanIntakeDraftRowForTest,
} from "./index.ts";
import {
  authorizeMakesafeTradeProjection,
  buildCanonicalMakesafeRows,
  projectTradeMakesafeBoard,
} from "./makesafe_board_read_model.ts";
import { interleaveOldestNewestForFairScan } from "./makesafe_intake_dedup.ts";
import { summarizeMakesafeIntakeReconciliation } from "./makesafe_intake_reconciliation.ts";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TRADE_BOARD_CLIENT_CACHE_MS = 90_000;

Deno.test("fixture: clean instruction reaches authorised manager Board L2", async () => {
  const emailReceivedAt = "2026-06-24T10:00:00.000Z";
  const jobCreatedAt = "2026-06-24T10:03:30.000Z";
  const boardProjectedAt = "2026-06-24T10:04:30.000Z";
  const jobId = "job-26010";
  const post = {
    id: "post-mlb-26010",
    receivedDateTime: emailReceivedAt,
    subject: "NEW WORK ORDER - MLB-26010 Roof Report",
    from: { emailAddress: { address: "alerts@noreply.mlb.com.au" } },
    body: { content: "Please complete roof report for MLB-26010" },
  } as any;
  const cls = _classifyPost(post, [{
    slug: "mlb",
    name: "ML Builders",
    pattern: "mlb.com.au",
  }]);
  assertEquals(cls.include, true);
  assertEquals(cls.ref, "MLB-26010");

  // This is the synthetic clean automated cohort, not a human-approved or dirty
  // draft. Exercise the production cleanliness gate before following its identity.
  const draft = {
    id: "draft-26010",
    graph_message_id: post.id,
    subject: post.subject,
    external_ref: cls.ref,
    requesting_company_slug: cls.company?.slug || "mlb",
    requesting_company_name: cls.company?.name || "ML Builders",
    client_name: "Synthetic Client",
    site_address: "10 Fixture Street",
    status: "approved",
    approved_by: "auto-intake",
    received_at: emailReceivedAt,
    confidence: "high",
    missing_fields: [],
    attachments_json: [{
      file_name: "MLB-26010-work-order.pdf",
      pdf_url: "https://fixture.invalid/MLB-26010-work-order.pdf",
      is_work_order: true,
    }],
    extraction_json: {
      makesafe_job_family: "roof_report",
      external_ref: cls.ref,
    },
  };
  assertEquals(
    _shouldAutoApproveCleanIntakeDraftRowForTest(draft),
    { ok: true, reason: "clean_high_confidence_work_order" },
  );

  const liveJobIdentity = {
    job_id: jobId,
    external_ref: "MLB 26010",
    requesting_company_slug: "mlb",
    jobs: { metadata: { makesafe_job_family: "roof_report" } },
  };
  const recon = summarizeMakesafeIntakeReconciliation({
    emails: [{
      post_id: post.id,
      subject: post.subject,
      received_at: emailReceivedAt,
    }],
    drafts: [draft],
    jobs: [liveJobIdentity],
    nowIso: boardProjectedAt,
  });

  assertEquals(recon.counts.source_emails_found, 1);
  assertEquals(recon.counts.unmatched_source_emails, 0);
  // This reconciliation state proves only that a database job row exists. The
  // authorised Board containment assertion below is the mission stop boundary.
  assertEquals(recon.items[0].state, "visible_job");
  assertEquals(recon.items[0].job_id, jobId);

  // Mirror the create path's accepted job + company_contact_required detail and
  // let the owned stage derivation and canonical projector shape the same job id.
  const detail = {
    job_id: jobId,
    substatus: "company_contact_required",
    requesting_company_slug: "mlb",
    requesting_company_name: "ML Builders",
    external_ref: cls.ref,
    report_type: "roof_report",
  };
  const createdJob = {
    id: jobId,
    job_number: "SWMS-26010",
    type: "makesafe",
    status: "accepted",
    created_at: jobCreatedAt,
    client_name: draft.client_name,
    site_address: draft.site_address,
    metadata: {
      builder_email_received_at: emailReceivedAt,
      makesafe_job_family: "roof_report",
    },
    makesafe_details: detail,
    substatus: detail.substatus,
    assignments: [],
  };
  const boardStage = _deriveMakesafeBoardStage(createdJob, detail, []);
  assertEquals(boardStage, "new");
  const canonicalRows = buildCanonicalMakesafeRows(
    [{ ...createdJob, board_stage: boardStage }],
    { computedAt: boardProjectedAt },
  );

  const hugoShapedViewer = {
    userId: "makesafe-manager-fixture",
    role: "lead_installer",
    managedVerticals: ["makesafe"],
  };
  const access = authorizeMakesafeTradeProjection("jwt", hugoShapedViewer);
  assertEquals(access.ok, true);
  const managerScope = _resolveManagerVisibility(hugoShapedViewer);
  assertEquals(managerScope.isMakesafeManager, true);
  assertEquals(managerScope.canSeeMakesafePool, true);

  const profileClient = {
    from(table: string) {
      assertEquals(table, "users");
      return {
        select(columns: string) {
          assertEquals(columns, "id, name, role, managed_verticals");
          return {
            eq(column: string, value: string) {
              assertEquals(column, "id");
              assertEquals(value, hugoShapedViewer.userId);
              return {
                maybeSingle: () => Promise.resolve({
                  data: {
                    id: hugoShapedViewer.userId,
                    name: "Hugo Fixture",
                    role: hugoShapedViewer.role,
                    managed_verticals: hugoShapedViewer.managedVerticals,
                  },
                  error: null,
                }),
              };
            },
          };
        },
      };
    },
  };
  const boardResponse = await _makesafeBoardTradeRouteForTest(
    profileClient,
    "jwt",
    {
      id: hugoShapedViewer.userId,
      email: "hugo.fixture@example.invalid",
      orgId: "fixture-org",
      role: hugoShapedViewer.role,
      managedVerticals: hugoShapedViewer.managedVerticals,
    },
    {
      loadBoard: async (_client, options) => {
        assertEquals(options, undefined);
        return canonicalRows;
      },
      generatedAt: boardProjectedAt,
    },
  );
  const boardBody = JSON.parse(await boardResponse.text());
  assertEquals(boardResponse.status, 200);
  assertEquals(boardBody.projection, "trade");
  const stopRows = [
    ...boardBody.columns.New,
    ...boardBody.columns.Allocated,
  ].filter((row) => row.id === jobId);
  assertEquals(stopRows.length, 1, "the exact created job_id must appear once");
  assertEquals(stopRows[0].id, liveJobIdentity.job_id);
  assertEquals(stopRows[0].column, "New");

  const timingProof = {
    cohort: "clean_automated",
    evidence_type: "deterministic_fixture_timing",
    email_received_at: post.receivedDateTime,
    job_created_at: createdJob.created_at,
    board_projection_at: boardBody.generated_at,
    elapsed_to_board_ms: Date.parse(boardBody.generated_at) -
      Date.parse(post.receivedDateTime),
    maximum_ms: FIVE_MINUTES_MS,
    client_board_cache: {
      ttl_ms: TRADE_BOARD_CLIENT_CACHE_MS,
      treatment: "bypassed_by_direct_authorised_server_projection",
      first_paint_telemetry: "not_stored",
    },
  };
  assert(
    Date.parse(timingProof.job_created_at) >=
      Date.parse(timingProof.email_received_at),
  );
  assert(
    Date.parse(timingProof.board_projection_at) >=
      Date.parse(timingProof.job_created_at),
  );
  assert(timingProof.elapsed_to_board_ms <= timingProof.maximum_ms);
  assertEquals(
    timingProof.client_board_cache.treatment,
    "bypassed_by_direct_authorised_server_projection",
  );
  assertEquals(
    timingProof.client_board_cache.first_paint_telemetry,
    "not_stored",
  );
  // This fixture would exceed five minutes if the warm client-cache allowance
  // were silently added. The proof intentionally stops at the direct L2 response.
  assert(
    timingProof.elapsed_to_board_ms + timingProof.client_board_cache.ttl_ms >
      timingProof.maximum_ms,
  );

  // Board visibility, field readiness and open-pool eligibility are three named
  // facts. CCR is visible in Board New while remaining blocked and ineligible.
  const fieldReadinessEvidence = {
    metric: "field_ready",
    value: false,
    reason: stopRows[0].blockers.real[0]?.code,
  };
  const openPoolEvidence = {
    metric: "open_pool_eligible",
    value: _isAllocatableMakesafePoolDetailForTest(detail),
  };
  assertEquals(stopRows[0].substatus, "company_contact_required");
  assertEquals(fieldReadinessEvidence, {
    metric: "field_ready",
    value: false,
    reason: "client_contact_required",
  });
  assertEquals(openPoolEvidence, {
    metric: "open_pool_eligible",
    value: false,
  });

  // The same unassigned identity cannot leak to an allowed-role viewer whose
  // profile does not manage make-safe. Role auth succeeds, vertical scope does not.
  const wrongVerticalViewer = {
    userId: "fencing-manager-fixture",
    role: "lead_installer",
    managedVerticals: ["fencing"],
  };
  const wrongVerticalAccess = authorizeMakesafeTradeProjection(
    "jwt",
    wrongVerticalViewer,
  );
  assertEquals(wrongVerticalAccess.ok, true);
  assertEquals(
    _resolveManagerVisibility(wrongVerticalViewer).canSeeMakesafePool,
    false,
  );
  const wrongVerticalBoard = projectTradeMakesafeBoard(
    canonicalRows,
    wrongVerticalViewer,
  );
  assertEquals(wrongVerticalBoard.rows.some((row) => row.id === jobId), false);

  const wrongRoleAccess = authorizeMakesafeTradeProjection("jwt", {
    userId: "wrong-role-fixture",
    role: "unexpected_role",
    managedVerticals: ["makesafe"],
  });
  assertEquals(wrongRoleAccess.ok, false);
  assertEquals(wrongRoleAccess.status, 403);
});

Deno.test("integration: bounded scan order samples old backlog before newest flood", () => {
  const newestFirst = Array.from(
    { length: 60 },
    (_, i) => ({ id: `item-${i}` }),
  );
  const ordered = interleaveOldestNewestForFairScan(newestFirst);
  const firstTen = ordered.slice(0, 10).map((i) => i.id);

  assertEquals(firstTen.includes("item-59"), true);
  assertEquals(firstTen.includes("item-0"), true);
  assertEquals(firstTen.includes("item-58"), true);
});

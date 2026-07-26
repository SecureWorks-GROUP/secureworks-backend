// deno-lint-ignore-file no-import-prefix no-explicit-any require-await
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _classifyPost } from "../monitor-ses-makesafes/index.ts";
import {
  _deriveMakesafeBoardStage,
  _isAllocatableMakesafePoolDetailForTest,
  _makesafeBoardActionForTest,
  _makesafeBoardTradeRouteForTest,
  _resolveManagerVisibility,
  _shouldAutoApproveCleanIntakeDraftRowForTest,
} from "./index.ts";
import { interleaveOldestNewestForFairScan } from "./makesafe_intake_dedup.ts";
import { summarizeMakesafeIntakeReconciliation } from "./makesafe_intake_reconciliation.ts";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TRADE_BOARD_CLIENT_CACHE_MS = 90_000;

type CallRecord = {
  table: string;
  select?: string;
  eqs: Array<{ column: string; value: unknown }>;
};

/**
 * Join-capable PostgREST fixture. Nested filters such as `.eq('jobs.type',
 * 'makesafe')` match the embedded path key on the row (same convention as the
 * allocated-scope page-order audit stub). Mission proofs must observe a real
 * `jobs` table read — there is no loadBoard injection on the production route.
 */
function makeCanonicalBoardFixtureClient(
  profiles: Record<string, any>,
  rowsByTable: Record<string, any[]>,
) {
  const calls: CallRecord[] = [];
  function builder(table: string) {
    const rows =
      (table === "users" ? Object.values(profiles) : rowsByTable[table] || [])
        .slice();
    const predicates: Array<(row: any) => boolean> = [];
    const call: CallRecord = { table, eqs: [] };
    calls.push(call);
    const query: any = {
      select: (columns?: string) => {
        if (columns) call.select = columns;
        return query;
      },
      eq: (column: string, value: any) => {
        call.eqs.push({ column, value });
        predicates.push((row) => {
          if (Object.prototype.hasOwnProperty.call(row ?? {}, column)) {
            return row?.[column] === value;
          }
          // Nested PostgREST path (e.g. jobs.type) when the fixture plants the
          // joined relation as an object.
          if (column.includes(".")) {
            const parts = column.split(".");
            let cursor: any = row;
            for (const part of parts) {
              cursor = cursor?.[part];
            }
            return cursor === value;
          }
          return row?.[column] === value;
        });
        return query;
      },
      neq: (column: string, value: any) => {
        predicates.push((row) => row?.[column] !== value);
        return query;
      },
      not: (column: string, operator: string, value: string) => {
        if (operator === "in") {
          const excluded = value.slice(1, -1).split(",").map((item) =>
            item.replaceAll('"', "")
          );
          predicates.push((row) => !excluded.includes(String(row?.[column])));
        }
        return query;
      },
      gte: (column: string, value: any) => {
        predicates.push((row) => String(row?.[column] || "") >= String(value));
        return query;
      },
      in: (column: string, values: any[]) => {
        predicates.push((row) => values.includes(row?.[column]));
        return query;
      },
      order: () => query,
      range: async (from: number, to: number) => ({
        data: rows.filter((row) =>
          predicates.every((predicate) => predicate(row))
        )
          .slice(from, to + 1),
        error: null,
      }),
      maybeSingle: async () => ({
        data:
          rows.filter((row) =>
            predicates.every((predicate) => predicate(row))
          )[0] ||
          null,
        error: null,
      }),
      then: (resolve: (v: any) => any) => {
        const data = rows.filter((row) =>
          predicates.every((predicate) => predicate(row))
        );
        return resolve({ data, error: null });
      },
    };
    return query;
  }
  return {
    calls,
    tableCalls: () => calls.map((c) => c.table),
    from: (table: string) => builder(table),
  };
}

function emptyBoardTables(extra: Record<string, any[]> = {}) {
  return {
    jobs: [],
    makesafe_job_details: [],
    job_service_reports: [],
    xero_invoices: [],
    job_documents: [],
    makesafe_report_packs: [],
    job_assignments: [],
    job_events: [],
    job_media: [],
    job_contacts: [],
    makesafe_status_holds: [],
    makesafe_intake_cases: [],
    makesafe_board_status_current: [],
    ...extra,
  };
}

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
  const hugoShapedViewer = {
    userId: "makesafe-manager-fixture",
    role: "lead_installer",
    managedVerticals: ["makesafe"],
  };
  const managerScope = _resolveManagerVisibility(hugoShapedViewer);
  assertEquals(managerScope.isMakesafeManager, true);
  assertEquals(managerScope.canSeeMakesafePool, true);

  const fixtureClient = makeCanonicalBoardFixtureClient(
    {
      [hugoShapedViewer.userId]: {
        id: hugoShapedViewer.userId,
        name: "Hugo Fixture",
        role: hugoShapedViewer.role,
        managed_verticals: hugoShapedViewer.managedVerticals,
      },
      "fencing-manager-fixture": {
        id: "fencing-manager-fixture",
        name: "Fencing Fixture",
        role: "lead_installer",
        managed_verticals: ["fencing"],
      },
      "wrong-role-fixture": {
        id: "wrong-role-fixture",
        name: "Wrong Role Fixture",
        role: "unexpected_role",
        managed_verticals: ["makesafe"],
      },
    },
    emptyBoardTables({
      jobs: [{ ...createdJob, metadata: { ...createdJob.metadata } }],
      makesafe_job_details: [detail],
    }),
  );

  // Positive path: outer HTTP envelope + production route (no loadBoard option).
  // Canonical loader must read the jobs table; mission proof cannot inject a
  // prebuilt Board array.
  const boardResponse = await _makesafeBoardActionForTest(
    fixtureClient,
    "jwt",
    {
      id: hugoShapedViewer.userId,
      email: "hugo.fixture@example.invalid",
      orgId: "fixture-org",
      // JWT claim deliberately lies; profile row is authoritative.
      role: "admin",
      managedVerticals: ["fencing", "patio"],
    },
    "trade",
    {
      generatedAt: boardProjectedAt,
    },
  );
  const boardBody = JSON.parse(await boardResponse.text());
  assertEquals(boardResponse.status, 200);
  assertEquals(boardBody.projection, "trade");
  assertEquals(
    fixtureClient.tableCalls().includes("jobs"),
    true,
    "canonical loader must query jobs — no prebuilt Board injection",
  );
  assertEquals(
    fixtureClient.tableCalls().includes("makesafe_job_details"),
    true,
  );
  assertEquals(fixtureClient.tableCalls().includes("users"), true);
  // Production route options accept only generatedAt — TypeScript and the
  // runtime signature reject loadBoard. Structural proof: jobs was read.
  const stopRows = [
    ...boardBody.columns.New,
    ...boardBody.columns.Allocated,
  ].filter((row: any) => row.id === jobId);
  assertEquals(stopRows.length, 1, "the exact created job_id must appear once");
  assertEquals(stopRows[0].id, liveJobIdentity.job_id);
  assertEquals(stopRows[0].column, "New");
  // Profile beat the escalated JWT claim: manager-shaped profile still sees all.
  assertEquals(boardBody.permissions.visibility, "all_makesafes");
  assertEquals(boardBody.permissions.sees_all_makesafes, true);

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
    live_sla_claim: false,
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
  assertEquals(timingProof.live_sla_claim, false);

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
  const wrongVerticalResponse = await _makesafeBoardActionForTest(
    fixtureClient,
    "jwt",
    {
      id: wrongVerticalViewer.userId,
      email: "fencing.fixture@example.invalid",
      orgId: "fixture-org",
      role: wrongVerticalViewer.role,
      managedVerticals: wrongVerticalViewer.managedVerticals,
    },
    "trade",
  );
  const wrongVerticalBody = JSON.parse(await wrongVerticalResponse.text());
  assertEquals(wrongVerticalResponse.status, 200);
  assertEquals(fixtureClient.tableCalls().includes("job_assignments"), true);
  assertEquals(wrongVerticalBody.permissions.visibility, "allocated_only");
  assertEquals(
    wrongVerticalBody.rows.some((row: any) => row.id === jobId),
    false,
  );
  assertEquals(wrongVerticalBody.rows.length, 0);

  const wrongRoleResponse = await _makesafeBoardActionForTest(
    fixtureClient,
    "jwt",
    {
      id: "wrong-role-fixture",
      email: "wrong-role.fixture@example.invalid",
      orgId: "fixture-org",
      role: "unexpected_role",
      managedVerticals: ["makesafe"],
    },
    "trade",
  );
  assertEquals(wrongRoleResponse.status, 403);
});

Deno.test("outer handler: non-JWT modes fail for projection=trade before route", async () => {
  const client = makeCanonicalBoardFixtureClient(
    {
      "any-user": {
        id: "any-user",
        name: "Any",
        role: "crew",
        managed_verticals: [],
      },
    },
    emptyBoardTables({
      jobs: [{
        id: "should-not-load",
        type: "makesafe",
        status: "accepted",
        created_at: "2026-06-24T10:00:00.000Z",
      }],
    }),
  );
  const authUser = {
    id: "any-user",
    email: "any@example.invalid",
    orgId: "fixture-org",
    role: "crew",
    managedVerticals: [] as string[],
  };

  for (const mode of ["api_key", "routine", "none", "anonymous"] as const) {
    const response = await _makesafeBoardActionForTest(
      client,
      mode,
      authUser,
      "trade",
    );
    const body = JSON.parse(await response.text());
    assertEquals(response.status, 403, mode);
    assertEquals(
      body.error,
      "trade projection requires an authenticated trade session",
      mode,
    );
  }
  // Outer gate must not have reached the jobs loader for trade non-JWT.
  assertEquals(
    client.tableCalls().includes("jobs"),
    false,
    "non-JWT trade must fail at the outer envelope without loading the board",
  );
});

Deno.test("outer handler: missing profile and JWT claim escalation", async () => {
  const jobId = "job-claim-check";
  const client = makeCanonicalBoardFixtureClient(
    {
      "real-crew": {
        id: "real-crew",
        name: "Ordinary Crew",
        role: "crew",
        managed_verticals: [],
      },
    },
    emptyBoardTables({
      jobs: [{
        id: jobId,
        job_number: "SWMS-CLAIM",
        type: "makesafe",
        status: "accepted",
        created_at: "2026-06-24T10:00:00.000Z",
        client_name: "Claim Client",
        site_address: "1 Claim St",
        metadata: {},
      }],
      makesafe_job_details: [{
        job_id: jobId,
        substatus: "company_contact_required",
      }],
      job_assignments: [{
        id: "asgn-claim",
        job_id: jobId,
        user_id: "someone-else",
        status: "scheduled",
        "jobs.type": "makesafe",
        jobs: { type: "makesafe" },
      }],
    }),
  );

  await assertRejects(
    () =>
      _makesafeBoardActionForTest(
        client,
        "jwt",
        {
          id: "missing-user",
          email: "missing@example.invalid",
          orgId: "fixture-org",
          role: "admin",
          managedVerticals: ["makesafe"],
        },
        "trade",
      ),
    Error,
    "Trade profile not found",
  );

  // JWT claims admin + makesafe; profile is ordinary crew with no assignment.
  const escalated = await _makesafeBoardActionForTest(
    client,
    "jwt",
    {
      id: "real-crew",
      email: "crew@example.invalid",
      orgId: "fixture-org",
      role: "admin",
      managedVerticals: ["makesafe"],
    },
    "trade",
  );
  const body = JSON.parse(await escalated.text());
  assertEquals(escalated.status, 200);
  assertEquals(body.permissions.visibility, "allocated_only");
  assertEquals(body.permissions.sees_all_makesafes, false);
  assertEquals(body.rows.some((row: any) => row.id === jobId), false);
});

Deno.test("assigned-only: ordinary trade sees only cycle-bound makesafe assignment", async () => {
  const assignedJobId = "job-assigned-ms";
  const unassignedJobId = "job-unassigned-ms";
  const wrongTypeJobId = "job-fencing";
  const cycleId = "cycle-assigned-1";
  const ordinaryUser = "ordinary-trade-fixture";
  const otherUser = "other-trade-fixture";

  const assignedDetail = {
    job_id: assignedJobId,
    substatus: "waiting_on_trade_report",
    attendance_cycle_id: cycleId,
    cycle_number: 1,
    reattend_count: 0,
  };
  const unassignedDetail = {
    job_id: unassignedJobId,
    substatus: "company_contact_required",
  };

  const assignedJob = {
    id: assignedJobId,
    job_number: "SWMS-ASSIGNED",
    type: "makesafe",
    status: "scheduled",
    created_at: "2026-06-24T10:00:00.000Z",
    client_name: "Assigned Client",
    site_address: "2 Assigned St",
    metadata: {},
  };
  const unassignedJob = {
    id: unassignedJobId,
    job_number: "SWMS-UNASSIGNED",
    type: "makesafe",
    status: "accepted",
    created_at: "2026-06-24T10:01:00.000Z",
    client_name: "Unassigned Client",
    site_address: "3 Free St",
    metadata: {},
  };
  const fencingJob = {
    id: wrongTypeJobId,
    job_number: "SWF-FENCE",
    type: "fencing",
    status: "scheduled",
    created_at: "2026-06-24T10:02:00.000Z",
    client_name: "Fence Client",
    site_address: "4 Fence St",
    metadata: {},
  };

  // Non-empty assignment rows on every path: ordinary owns the makesafe job
  // (cycle-bound), another user owns the unassigned-to-ordinary makesafe job,
  // and ordinary also has a fencing assignment that nested jobs.type must drop.
  const assignments = [
    {
      id: "asgn-own-ms",
      job_id: assignedJobId,
      user_id: ordinaryUser,
      status: "scheduled",
      scheduled_date: "2026-06-25",
      attendance_cycle_id: cycleId,
      cycle_attribution: "bound",
      "jobs.type": "makesafe",
      jobs: { type: "makesafe" },
      users: { id: ordinaryUser, name: "Ordinary Trade" },
    },
    {
      id: "asgn-other-ms",
      job_id: unassignedJobId,
      user_id: otherUser,
      status: "scheduled",
      scheduled_date: "2026-06-25",
      "jobs.type": "makesafe",
      jobs: { type: "makesafe" },
      users: { id: otherUser, name: "Other Trade" },
    },
    {
      id: "asgn-own-fence",
      job_id: wrongTypeJobId,
      user_id: ordinaryUser,
      status: "scheduled",
      scheduled_date: "2026-06-25",
      "jobs.type": "fencing",
      jobs: { type: "fencing" },
      users: { id: ordinaryUser, name: "Ordinary Trade" },
    },
  ];

  const client = makeCanonicalBoardFixtureClient(
    {
      [ordinaryUser]: {
        id: ordinaryUser,
        name: "Ordinary Trade",
        role: "crew",
        managed_verticals: [],
      },
    },
    emptyBoardTables({
      jobs: [assignedJob, unassignedJob, fencingJob],
      makesafe_job_details: [assignedDetail, unassignedDetail],
      job_assignments: assignments,
    }),
  );

  const response = await _makesafeBoardActionForTest(
    client,
    "jwt",
    {
      id: ordinaryUser,
      email: "ordinary@example.invalid",
      orgId: "fixture-org",
      // Escalation attempt: JWT claims manager; profile is ordinary crew.
      role: "ops_manager",
      managedVerticals: ["makesafe"],
    },
    "trade",
  );
  const body = JSON.parse(await response.text());
  assertEquals(response.status, 200);
  assertEquals(body.permissions.visibility, "allocated_only");
  assertEquals(body.permissions.sees_all_makesafes, false);
  assertEquals(body.permissions.can_allocate, false);

  // Assigned-id restriction must have hit job_assignments with nested type filter.
  const assignmentCalls = client.calls.filter((c) =>
    c.table === "job_assignments"
  );
  assert(
    assignmentCalls.length > 0,
    "allocated-only must query job_assignments",
  );
  assert(
    assignmentCalls.some((c) =>
      c.eqs.some((eq) => eq.column === "jobs.type" && eq.value === "makesafe")
    ),
    "nested jobs.type=makesafe filter must run on the assignment scope read",
  );
  assert(
    assignmentCalls.some((c) =>
      c.eqs.some((eq) => eq.column === "user_id" && eq.value === ordinaryUser)
    ),
    "assignment scope must filter to the signed-in user",
  );

  // Restrict list is non-empty for the assigned makesafe job only — cannot pass
  // through an empty restrict set that coincidentally returns nothing useful.
  assertEquals(
    body.rows.map((row: any) => row.id),
    [assignedJobId],
    "ordinary trade sees exactly their assigned make-safe job",
  );
  assertEquals(
    body.rows.some((row: any) => row.id === unassignedJobId),
    false,
    "must never see an unassigned make-safe",
  );
  assertEquals(
    body.rows.some((row: any) => row.id === wrongTypeJobId),
    false,
    "must never see a wrong-type (fencing) job via nested join filter",
  );

  const assignedRow = body.rows[0];
  assertEquals(assignedRow.attendance_cycle_id, cycleId);
  assert(
    (assignedRow.assignments || []).some((a: any) =>
      a.user_id === ordinaryUser || a.assignment_id === "asgn-own-ms"
    ),
    "current-cycle bound assignment must surface on the trade card",
  );
});

Deno.test("assigned-only: empty assignment list is not how ordinary crew is tested", async () => {
  // Guards the F6 empty-restrict loophole: wrong-vertical / ordinary paths must
  // plant non-empty assignment rows. This case plants rows for another user so
  // the restrict query returns [] only after a real filtered assignment read.
  const jobId = "job-other-only";
  const ordinaryUser = "crew-no-own-asgn";
  const client = makeCanonicalBoardFixtureClient(
    {
      [ordinaryUser]: {
        id: ordinaryUser,
        name: "Crew",
        role: "installer",
        managed_verticals: [],
      },
    },
    emptyBoardTables({
      jobs: [{
        id: jobId,
        job_number: "SWMS-OTHER",
        type: "makesafe",
        status: "accepted",
        created_at: "2026-06-24T10:00:00.000Z",
        client_name: "Other",
        site_address: "9 Other St",
        metadata: {},
      }],
      makesafe_job_details: [{
        job_id: jobId,
        substatus: "company_contact_required",
      }],
      job_assignments: [{
        id: "asgn-someone",
        job_id: jobId,
        user_id: "someone-else",
        status: "scheduled",
        "jobs.type": "makesafe",
        jobs: { type: "makesafe" },
      }],
    }),
  );

  const response = await _makesafeBoardTradeRouteForTest(
    client,
    "jwt",
    {
      id: ordinaryUser,
      email: "crew@example.invalid",
      orgId: "fixture-org",
      role: "installer",
      managedVerticals: [],
    },
  );
  const body = JSON.parse(await response.text());
  assertEquals(response.status, 200);
  assertEquals(body.rows.length, 0);
  assert(
    client.calls.some((c) =>
      c.table === "job_assignments" &&
      c.eqs.some((eq) => eq.column === "user_id" && eq.value === ordinaryUser)
    ),
    "must query assignments for the ordinary user (non-empty table, empty match)",
  );
  // Empty restrict short-circuits before jobs — correct for zero assigned ids.
  assertEquals(
    client.tableCalls().includes("jobs"),
    false,
    "empty restrictToJobIds must not load full make-safe history",
  );
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

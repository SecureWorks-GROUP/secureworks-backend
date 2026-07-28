// ════════════════════════════════════════════════════════════
// deno-lint-ignore-file no-import-prefix

// B5 — SLA LATENCY TESTS (email received -> card created)
// ════════════════════════════════════════════════════════════
//
// Pure-Deno, no network. Covers computeLatencySla percentiles + edge cases.
//
// RUN:
//   ~/.deno/bin/deno test --allow-all --no-check \
//     supabase/functions/ops-api/makesafe_intake_sla_test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeLatencySla,
  computeLogicalIntakeSla,
} from "./makesafe_intake_sla.ts";

// helper: build a row that is `sec` seconds slow.
function row(sec: number) {
  const rec = new Date("2026-07-04T02:00:00.000Z");
  const cre = new Date(rec.getTime() + sec * 1000);
  return { received_at: rec.toISOString(), created_at: cre.toISOString() };
}

Deno.test("SLA: empty input -> all zero, 0 samples", () => {
  assertEquals(computeLatencySla([]), {
    samples: 0,
    p50_sec: 0,
    p95_sec: 0,
    max_sec: 0,
  });
  assertEquals(computeLatencySla(null), {
    samples: 0,
    p50_sec: 0,
    p95_sec: 0,
    max_sec: 0,
  });
});

Deno.test("SLA: single row -> p50=p95=max=that latency", () => {
  const r = computeLatencySla([row(90)]);
  assertEquals(r.samples, 1);
  assertEquals(r.p50_sec, 90);
  assertEquals(r.p95_sec, 90);
  assertEquals(r.max_sec, 90);
});

Deno.test("SLA: percentiles over a known spread", () => {
  // Ten drafts: 30,60,90,120,150,180,210,240,270,300 sec.
  const rows = [30, 60, 90, 120, 150, 180, 210, 240, 270, 300].map(row);
  const r = computeLatencySla(rows);
  assertEquals(r.samples, 10);
  // nearest-rank p50 over 10 items = index ceil(0.5*10)-1 = 4 -> 150
  assertEquals(r.p50_sec, 150);
  // p95 over 10 = ceil(0.95*10)-1 = 9 -> 300
  assertEquals(r.p95_sec, 300);
  assertEquals(r.max_sec, 300);
});

Deno.test("SLA: rows missing a timestamp are excluded", () => {
  const rows = [
    row(60),
    { received_at: null, created_at: "2026-07-04T02:01:00Z" },
    { received_at: "2026-07-04T02:00:00Z", created_at: null },
    { received_at: "nonsense", created_at: "also-bad" },
  ];
  const r = computeLatencySla(rows);
  assertEquals(r.samples, 1);
  assertEquals(r.max_sec, 60);
});

Deno.test("SLA: negative latency (clock skew) is dropped, never counted", () => {
  // created_at BEFORE received_at -> negative delta -> excluded.
  const rows = [
    { received_at: "2026-07-04T02:05:00Z", created_at: "2026-07-04T02:00:00Z" },
    row(120),
  ];
  const r = computeLatencySla(rows);
  assertEquals(r.samples, 1);
  assertEquals(r.max_sec, 120);
});

Deno.test("SLA: seconds are rounded", () => {
  const rec = new Date("2026-07-04T02:00:00.000Z");
  const cre = new Date(rec.getTime() + 90_400); // 90.4s
  const r = computeLatencySla([{
    received_at: rec.toISOString(),
    created_at: cre.toISOString(),
  }]);
  assertEquals(r.max_sec, 90);
});

function unaccountedItem(
  postId: string,
  receivedAt: string,
  subject: string,
) {
  return {
    post_id: postId,
    internet_message_id: null,
    subject,
    from_email: "dispatch@example-builder.test",
    received_at: receivedAt,
    age_minutes: null,
    state: "unaccounted" as const,
    classification: "genuinely_unaccounted" as const,
    reason: "make_safe_candidate_no_draft_no_job",
    evidence: {
      kind: "classification" as const,
      id: "no_durable_capture_evidence",
    },
    raw_reference: null,
    canonical_claim_ref: null,
    canonical_po_ref: null,
  };
}

Deno.test("logical SLA gives every mature case or unaccounted logical email exactly one outcome", () => {
  const result = computeLogicalIntakeSla({
    nowIso: "2026-07-28T12:00:00.000Z",
    windowStartIso: "2026-07-28T11:00:00.000Z",
    cases: [
      {
        id: "case-on-board",
        state: "confirmed_live_job",
        job_id: "job-on-board",
        received_at: "2026-07-28T11:50:00.000Z",
        last_decision_at: "2026-07-28T11:52:00.000Z",
        jobs: {
          id: "job-on-board",
          created_at: "2026-07-28T11:52:00.000Z",
        },
        makesafe_intake_case_sources: [{
          post_id: "captured-source",
          received_at: "2026-07-28T11:50:00.000Z",
        }],
      },
      {
        id: "case-non-work",
        state: "accounted_non_wo",
        received_at: "2026-07-28T11:40:00.000Z",
        last_decision_at: "2026-07-28T11:43:00.000Z",
      },
      {
        id: "case-late-job",
        state: "confirmed_live_job",
        job_id: "job-late",
        received_at: "2026-07-28T11:30:00.000Z",
        last_decision_at: "2026-07-28T11:36:00.000Z",
        jobs: {
          id: "job-late",
          created_at: "2026-07-28T11:36:00.000Z",
        },
      },
    ],
    boardRows: [
      {
        id: "job-on-board",
        canonical_stage: "new",
        ses_family: "physical_makesafe",
      },
      {
        id: "job-late",
        canonical_stage: "new",
        ses_family: "physical_makesafe",
      },
    ],
    notifications: [{
      case_id: "case-on-board",
      job_id: "job-on-board",
      state: "accepted",
      attempted_at: "2026-07-28T11:53:59.000Z",
      provider_accepted_at: "2026-07-28T11:54:00.000Z",
    }],
    unaccountedItems: [
      // Two capture rows for one work order straddle a minute boundary. They
      // remain one logical missed outcome, not two raw-row failures.
      unaccountedItem(
        "raw-a",
        "2026-07-28T11:20:59.000Z",
        "Make Safe Job No 70001",
      ),
      unaccountedItem(
        "raw-b",
        "2026-07-28T11:21:00.000Z",
        "Make Safe Job No 70001",
      ),
      // This group is still inside its five-minute decision window.
      unaccountedItem(
        "raw-pending",
        "2026-07-28T11:57:00.000Z",
        "Make Safe Job No 70002",
      ),
      // An invariant source already attached to a case must not double-count.
      unaccountedItem(
        "captured-source",
        "2026-07-28T11:50:00.000Z",
        "Make Safe Job No 70003",
      ),
    ],
    sourceReadComplete: true,
  });

  assertEquals(result.denominator_matured, 4);
  assertEquals(result.pending_within_300s, 1);
  assertEquals(result.raw_source_rows, 3);
  assertEquals(result.logical_email_groups, 5);
  assertEquals(result.unaccounted_logical_groups, 2);
  assertEquals(result.outcomes, {
    job_on_board_within_300s: 1,
    terminal_non_work_fate_within_300s: 1,
    missed_or_late: 2,
  });
  assertEquals(result.hugo_notification, {
    physical_jobs_in_denominator: 1,
    provider_accepted_within_300s: 1,
    missed_or_late: 0,
  });
  assertEquals(
    Object.values(result.outcomes).reduce((sum, count) => sum + count, 0),
    result.denominator_matured,
  );
});

Deno.test("logical SLA keeps missing Hugo acceptance visible and never admits synthetic live-fire", () => {
  const result = computeLogicalIntakeSla({
    nowIso: "2026-07-28T12:00:00.000Z",
    windowStartIso: "2026-07-28T11:00:00.000Z",
    cases: [
      {
        id: "physical",
        state: "confirmed_live_job",
        job_id: "physical-job",
        received_at: "2026-07-28T11:50:00.000Z",
        jobs: {
          id: "physical-job",
          created_at: "2026-07-28T11:52:00.000Z",
        },
      },
      {
        id: "synthetic",
        state: "confirmed_live_job",
        job_id: "synthetic-job",
        received_at: "2026-07-28T11:40:00.000Z",
        raw_identity_json: {
          synthetic_livefire_marker: "SWG-SES-LIVEFIRE-TEST-ONLY-RUNTIME-001",
        },
        jobs: {
          id: "synthetic-job",
          created_at: "2026-07-28T11:41:00.000Z",
        },
      },
    ],
    boardRows: [
      {
        id: "physical-job",
        canonical_stage: "new",
        ses_family: "physical_makesafe",
      },
      {
        id: "synthetic-job",
        canonical_stage: "new",
        ses_family: "physical_makesafe",
      },
    ],
    notifications: [],
    unaccountedItems: [],
    sourceReadComplete: false,
  });

  assertEquals(result.complete, false);
  assertEquals(result.denominator_matured, 1);
  assertEquals(result.outcomes.job_on_board_within_300s, 1);
  assertEquals(result.hugo_notification, {
    physical_jobs_in_denominator: 1,
    provider_accepted_within_300s: 0,
    missed_or_late: 1,
  });
});

Deno.test("logical SLA never unions distinct explicit claims on a shared builder PO", () => {
  const shared = {
    canonical_po_ref: "PO-9000",
    subject: "Generic make-safe request",
  };
  const result = computeLogicalIntakeSla({
    nowIso: "2026-07-28T12:00:00.000Z",
    windowStartIso: "2026-07-28T11:00:00.000Z",
    cases: [],
    boardRows: [],
    notifications: [],
    unaccountedItems: [
      {
        ...unaccountedItem(
          "claim-a-source",
          "2026-07-28T11:50:00.000Z",
          shared.subject,
        ),
        ...shared,
        canonical_claim_ref: "CLAIM-A",
      },
      {
        ...unaccountedItem(
          "claim-b-source",
          "2026-07-28T11:50:01.000Z",
          shared.subject,
        ),
        ...shared,
        canonical_claim_ref: "CLAIM-B",
      },
    ],
    sourceReadComplete: true,
  });

  assertEquals(result.denominator_matured, 2);
  assertEquals(result.unaccounted_logical_groups, 2);
  assertEquals(result.outcomes.missed_or_late, 2);
});

Deno.test("logical SLA includes the exact 300-second boundary and rejects 301 seconds", () => {
  const result = computeLogicalIntakeSla({
    nowIso: "2026-07-28T12:00:00.000Z",
    windowStartIso: "2026-07-28T11:00:00.000Z",
    cases: [
      {
        id: "job-at-300",
        state: "confirmed_live_job",
        job_id: "job-at-300",
        received_at: "2026-07-28T11:50:00.000Z",
        jobs: {
          id: "job-at-300",
          created_at: "2026-07-28T11:55:00.000Z",
        },
      },
      {
        id: "job-at-301",
        state: "confirmed_live_job",
        job_id: "job-at-301",
        received_at: "2026-07-28T11:50:00.000Z",
        jobs: {
          id: "job-at-301",
          created_at: "2026-07-28T11:55:01.000Z",
        },
      },
      {
        id: "non-work-at-300",
        state: "accounted_non_wo",
        received_at: "2026-07-28T11:40:00.000Z",
        last_decision_at: "2026-07-28T11:45:00.000Z",
      },
    ],
    boardRows: [
      {
        id: "job-at-300",
        canonical_stage: "new",
        ses_family: "physical_makesafe",
      },
      {
        id: "job-at-301",
        canonical_stage: "new",
        ses_family: "physical_makesafe",
      },
    ],
    notifications: [],
    unaccountedItems: [],
    sourceReadComplete: true,
  });

  assertEquals(result.outcomes, {
    job_on_board_within_300s: 1,
    terminal_non_work_fate_within_300s: 1,
    missed_or_late: 1,
  });
});

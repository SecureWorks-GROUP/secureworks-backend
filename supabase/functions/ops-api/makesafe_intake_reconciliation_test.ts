import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { summarizeMakesafeIntakeReconciliation } from "./makesafe_intake_reconciliation.ts";

const NOW = "2026-06-24T12:00:00.000Z";

Deno.test("intake reconciliation: source email with draft and live job is visible", () => {
  const summary = summarizeMakesafeIntakeReconciliation({
    nowIso: NOW,
    staleMinutes: 10,
    emails: [{ post_id: "post-1", received_at: "2026-06-24T11:58:00.000Z" }],
    drafts: [{
      id: "draft-1",
      graph_message_id: "post-1",
      external_ref: "MLB-25911",
      requesting_company_slug: "mlb",
      status: "approved",
      received_at: "2026-06-24T11:58:00.000Z",
      extraction_json: { makesafe_job_family: "roof_report" },
    }],
    jobs: [{
      job_id: "job-1",
      external_ref: "MLB 25911",
      requesting_company_slug: "mlb",
      jobs: {
        metadata: { makesafe_job_family: "roof_report" },
        status: "accepted",
      },
    }],
  });

  assertEquals(summary.counts.source_emails_found, 1);
  assertEquals(summary.counts.jobs_visible, 1);
  assertEquals(summary.counts.unmatched_source_emails, 0);
  assertEquals(
    summary.items.find((i) => i.source_email_id === "post-1")?.state,
    "visible_job",
  );
});

Deno.test("intake reconciliation: unmatched source email and stuck draft are explicit", () => {
  const summary = summarizeMakesafeIntakeReconciliation({
    nowIso: NOW,
    staleMinutes: 10,
    emails: [{
      post_id: "post-unmatched",
      received_at: "2026-06-24T11:50:00.000Z",
    }],
    drafts: [{
      id: "draft-stuck",
      graph_message_id: "post-stuck",
      external_ref: "AJBR-70001",
      requesting_company_slug: "aj",
      status: "needs_review",
      received_at: "2026-06-24T11:40:00.000Z",
      extraction_json: { makesafe_job_family: "general_makesafe" },
    }],
    jobs: [],
  });

  assertEquals(summary.counts.unmatched_source_emails, 1);
  assertEquals(summary.counts.stuck_items, 1);
  assertEquals(summary.items.some((i) => i.state === "unmatched_source"), true);
  assertEquals(
    summary.items.some((i) =>
      i.state === "stuck_review" && i.reason.includes("older_than_10m")
    ),
    true,
  );
});

Deno.test("intake reconciliation: rejected/superseded drafts count as visible skip reasons", () => {
  const summary = summarizeMakesafeIntakeReconciliation({
    nowIso: NOW,
    emails: [],
    drafts: [{
      id: "draft-rejected",
      graph_message_id: "post-rejected",
      external_ref: "MLB-25096",
      requesting_company_slug: "mlb",
      status: "rejected",
      received_at: "2026-06-24T11:55:00.000Z",
      extraction_json: {
        classification_reason: "duplicate already represented",
      },
    }],
    jobs: [],
  });

  assertEquals(summary.counts.visible_skip_reasons, 1);
  assertEquals(summary.items[0].state, "visible_skip");
  assertEquals(summary.items[0].reason, "duplicate already represented");
});

Deno.test("intake reconciliation: alert items expose attachment/model/family risks", () => {
  const summary = summarizeMakesafeIntakeReconciliation({
    nowIso: NOW,
    emails: [],
    drafts: [{
      id: "draft-alert",
      external_ref: "MLB-26005",
      requesting_company_slug: "mlb",
      status: "needs_review",
      confidence: "low",
      missing_fields: ["ai_not_a_work_order_needs_review"],
      extraction_json: {},
      attachments_json: [{
        pdf_unavailable: true,
        pdf_error: "portal_link_or_oversize_needs_review",
      }],
    }],
    jobs: [{
      job_id: "job-alert",
      external_ref: "MLB-26006",
      requesting_company_slug: "mlb",
      jobs: { metadata: {} },
    }],
  });

  assertEquals(summary.counts.alert_items, 4);
  assertEquals(
    summary.alert_items.some((i) =>
      i.reason === "attachment_extraction_failure"
    ),
    true,
  );
  assertEquals(
    summary.alert_items.some((i) => i.reason === "model_uncertainty"),
    true,
  );
  assertEquals(
    summary.alert_items.filter((i) => i.reason === "no_family").length,
    2,
  );
});

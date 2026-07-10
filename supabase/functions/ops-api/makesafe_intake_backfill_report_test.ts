import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { summarizeMakesafeIntakeBackfillReport } from "./makesafe_intake_backfill_report.ts";

Deno.test("backfill report: infers missing family from report_type without writing", () => {
  const summary = summarizeMakesafeIntakeBackfillReport({
    drafts: [{
      id: "draft-roof-report",
      external_ref: "MLB-25911",
      requesting_company_slug: "mlb",
      status: "needs_review",
      report_type: "roof_report",
      extraction_json: {},
    }],
    jobs: [],
  });

  assertEquals(summary.dry_run, true);
  assertEquals(summary.counts.backfill_candidates, 1);
  assertEquals(summary.items[0].state, "backfill_candidate");
  assertEquals(summary.items[0].inferred_family, "roof_report");
  assertEquals(summary.items[0].confidence, "report_type");
});

Deno.test("backfill report: unknown-family draft sharing ref/company with known variant is a suppression risk", () => {
  const summary = summarizeMakesafeIntakeBackfillReport({
    drafts: [
      {
        id: "draft-unknown",
        external_ref: "MLB-26001",
        requesting_company_slug: "mlb",
        status: "draft",
        extraction_json: {},
      },
      {
        id: "draft-known",
        external_ref: "MLB 26001",
        requesting_company_slug: "mlb",
        status: "needs_review",
        extraction_json: { makesafe_job_family: "roof_report" },
      },
    ],
    jobs: [],
  });

  assertEquals(summary.counts.unknown_family_suppression_risks, 1);
  assertEquals(
    summary.items.find((i) => i.id === "draft-unknown")?.state,
    "unknown_family_suppression_risk",
  );
});

Deno.test("backfill report: no weak fallback to general family without make-safe evidence", () => {
  const summary = summarizeMakesafeIntakeBackfillReport({
    drafts: [{
      id: "draft-weak",
      external_ref: "AJBR-70001",
      requesting_company_slug: "aj",
      status: "draft",
      subject: "Status update",
      body_preview: "Please see attached correspondence.",
      extraction_json: {},
    }],
    jobs: [],
  });

  assertEquals(summary.counts.backfill_candidates, 0);
  assertEquals(summary.counts.review_required, 1);
  assertEquals(summary.items[0].state, "review_required");
});

Deno.test("backfill report (M-G FIX 2): stored family contradicted by WO text -> family_mismatch_review", () => {
  const summary = summarizeMakesafeIntakeBackfillReport({
    drafts: [{
      id: "draft-mistyped",
      external_ref: "MLB-25777",
      requesting_company_slug: "mlb",
      status: "needs_review",
      // stored as temp_fence, but the WO text says NO temp fencing + it's an assessment
      extraction_json: {
        makesafe_job_family: "temp_fence_makesafe",
        description: "Attend and assess the damage, provide a quote. No temp fencing needed.",
      },
    }],
    jobs: [],
  });
  assertEquals(summary.counts.family_mismatch_reviews, 1);
  const item = summary.items.find((i) => i.id === "draft-mistyped");
  assertEquals(item?.state, "family_mismatch_review");
  assertEquals(item?.current_family, "temp_fence_makesafe");
  assertEquals(item?.inferred_family, "assessment_report_quote");
  assertEquals(item?.confidence, "text");
});

Deno.test("backfill report (M-G FIX 2): stored family consistent with the text -> no mismatch flag", () => {
  const summary = summarizeMakesafeIntakeBackfillReport({
    drafts: [{
      id: "draft-consistent",
      external_ref: "MLB-26100",
      requesting_company_slug: "mlb",
      status: "needs_review",
      extraction_json: {
        makesafe_job_family: "roof_report",
        description: "Prime roof report required for the storm-damaged roof.",
      },
    }],
    jobs: [],
  });
  assertEquals(summary.counts.family_mismatch_reviews, 0);
});

Deno.test("backfill report (M-G FIX 2): live job with a mistyped family is flagged too", () => {
  const summary = summarizeMakesafeIntakeBackfillReport({
    drafts: [],
    jobs: [{
      job_id: "job-mistyped",
      external_ref: "MLB-17270",
      requesting_company_slug: "mlb",
      report_type: null,
      jobs: {
        status: "accepted",
        notes: "Roof report request for 18 Martinich Drive",
        metadata: { makesafe_job_family: "general_makesafe" },
      },
    }],
  });
  assertEquals(summary.counts.family_mismatch_reviews, 1);
  const item = summary.items.find((i) => i.id === "job-mistyped");
  assertEquals(item?.state, "family_mismatch_review");
  assertEquals(item?.inferred_family, "roof_report");
});

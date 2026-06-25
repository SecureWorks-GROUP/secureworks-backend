import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _classifyPost } from "../monitor-ses-makesafes/index.ts";
import { interleaveOldestNewestForFairScan } from "./makesafe_intake_dedup.ts";
import { summarizeMakesafeIntakeReconciliation } from "./makesafe_intake_reconciliation.ts";

Deno.test("integration: monitor-classified email can reconcile through draft to live job", () => {
  const post = {
    id: "post-mlb-26010",
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

  const recon = summarizeMakesafeIntakeReconciliation({
    emails: [{
      post_id: post.id,
      subject: post.subject,
      received_at: "2026-06-24T10:00:00.000Z",
    }],
    drafts: [{
      id: "draft-26010",
      graph_message_id: post.id,
      external_ref: cls.ref,
      requesting_company_slug: cls.company?.slug || "mlb",
      status: "approved",
      received_at: "2026-06-24T10:00:00.000Z",
      extraction_json: { makesafe_job_family: "roof_report" },
    }],
    jobs: [{
      job_id: "job-26010",
      external_ref: "MLB 26010",
      requesting_company_slug: "mlb",
      jobs: { metadata: { makesafe_job_family: "roof_report" } },
    }],
    nowIso: "2026-06-24T10:05:00.000Z",
  });

  assertEquals(recon.counts.source_emails_found, 1);
  assertEquals(recon.counts.unmatched_source_emails, 0);
  assertEquals(recon.items[0].state, "visible_job");
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

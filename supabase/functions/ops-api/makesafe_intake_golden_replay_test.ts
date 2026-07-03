import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  replayGoldenEmail,
  summarizeGoldenReplay,
} from "./makesafe_intake_golden_replay.ts";
import { senderMatchesPattern } from "../_shared/makesafe_intake_classification.ts";

const PATTERNS = [
  { slug: "mlb", name: "ML Builders", pattern: "mlbuilders.com.au" },
];

Deno.test("golden replay: an excluded subject would not draft and would not auto-file", () => {
  const r = replayGoldenEmail(
    { subject: "Photo Evidence - MLB-25096", from_email: "jobs@mlbuilders.com.au", wo_pdf_count: 0 },
    PATTERNS,
    senderMatchesPattern,
  );
  assertEquals(r.would_draft, false);
  assertEquals(r.would_auto_file, "no");
});

Deno.test("golden replay: a clean WO with a servable PDF is auto-file-pending on the live key", () => {
  const r = replayGoldenEmail(
    { subject: "NEW WORK ORDER - MLB-25096 7 Broughton St, Balcatta", from_email: "jobs@mlbuilders.com.au", wo_pdf_count: 1 },
    PATTERNS,
    senderMatchesPattern,
  );
  assertEquals(r.is_candidate, true);
  assertEquals(r.would_draft, true);
  assertEquals(r.would_auto_file, "requires_live_extraction");
  assertEquals(r.matched_company, "mlb");
});

Deno.test("golden replay: a report-capture email (no PDF) is a manual-review report, never auto-file", () => {
  const r = replayGoldenEmail(
    { subject: "Our Ref: MLB-26010 - roof report request", from_email: "jobs@mlbuilders.com.au", body: "please complete the roof report", wo_pdf_count: 0 },
    PATTERNS,
    senderMatchesPattern,
  );
  assertEquals(r.kind, "report");
  assertEquals(r.would_auto_file, "no");
  assertEquals(r.report_type, "roof_report");
});

Deno.test("golden replay: our own outbound copy is flagged own-outbound and would not draft", () => {
  const r = replayGoldenEmail(
    { subject: "Make Safe Report and Invoice - MLB-25096", from_email: "invoices@secureworksgroup.app", wo_pdf_count: 0 },
    PATTERNS,
    senderMatchesPattern,
  );
  assertEquals(r.is_own_outbound, true);
  assertEquals(r.would_draft, false);
});

Deno.test("golden replay summary: flags a disagreement when replay would draft but no draft exists", () => {
  const report = summarizeGoldenReplay({
    emails: [{ post_id: "p1", subject: "NEW WORK ORDER - MLB-99999", from_email: "jobs@mlbuilders.com.au", wo_pdf_count: 1 }],
    drafts: [],
    senderPatterns: PATTERNS,
    matchSender: senderMatchesPattern,
  });
  assertEquals(report.counts.would_draft, 1);
  assertEquals(report.counts.disagreements, 1);
  assertEquals(report.items[0].agreement.draft_presence_match, false);
});

Deno.test("golden replay summary: agrees + matches family when the actual draft lines up", () => {
  const report = summarizeGoldenReplay({
    emails: [{ post_id: "p2", subject: "NEW WORK ORDER - MLB-25096", from_email: "jobs@mlbuilders.com.au", wo_pdf_count: 1 }],
    drafts: [{
      graph_message_id: "p2",
      external_ref: "MLB-25096",
      confidence: "high",
      status: "approved",
      approved_by: "auto-intake",
      approved_job_id: "job-123",
      extraction_json: { makesafe_job_family: "general_makesafe", client_name: "Jane", site_address: "7 Broughton St" },
    }],
    senderPatterns: PATTERNS,
    matchSender: senderMatchesPattern,
  });
  assertEquals(report.counts.disagreements, 0);
  assertEquals(report.counts.drafts_present, 1);
  const item = report.items[0];
  assertEquals(item.agreement.draft_presence_match, true);
  assertEquals(item.agreement.family_match, true);
  assert(item.actual);
  assertEquals(item.actual?.auto_filed, true);
  assertEquals(item.actual?.created_job_id, "job-123");
});

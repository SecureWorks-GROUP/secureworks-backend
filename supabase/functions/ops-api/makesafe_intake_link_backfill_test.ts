import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  recoverJobLinks,
  selectLegacyWorkOrderEmail,
  summarizeLinkBackfill,
} from "./makesafe_intake_link_backfill.ts";

const ROOF_EMAIL_BODY =
  `Hi team, please complete the roof report for this property.\n` +
  `Upload the roof report here: https://portal.primeeco.tech/report/AB123\n` +
  `Thanks, MLB`;

Deno.test("recoverJobLinks: extracts a portal link from the WO email body", () => {
  const { links, sources } = recoverJobLinks({
    job_id: "j1",
    report_type: "roof_report",
    email_body: ROOF_EMAIL_BODY,
  });
  assert(links.length >= 1);
  assert(links.some((l) => l.url.includes("portal.primeeco.tech")));
  assert(sources.includes("email_body"));
});

Deno.test("recoverJobLinks: falls back to the draft extraction when the body is purged", () => {
  const { links, sources } = recoverJobLinks({
    job_id: "j1",
    report_type: "roof_report",
    email_body: null,
    draft_extraction: {
      portal_links: [{
        label: "Roof report",
        url: "https://portal.mlb.example/x",
        kind: "roof_report",
      }],
    },
  });
  assert(links.some((l) => l.url.includes("portal.mlb.example")));
  assert(sources.includes("draft_extraction"));
});

Deno.test("legacy recovery: chooses the exact original work-order email without a draft join", () => {
  const selected = selectLegacyWorkOrderEmail("MLB-25795", [
    {
      post_id: "follow-up",
      subject: "Re: MLB-25795",
      body_content: "Just following up.",
      received_at: "2026-07-27T01:00:00Z",
    },
    {
      post_id: "other-ref",
      subject: "NEW WORK ORDER - MLB-257950",
      body_content: "Assessment https://primeeco.tech/share/wrong-reference",
      received_at: "2026-07-27T02:00:00Z",
    },
    {
      post_id: "original",
      subject: "NEW WORK ORDER - MLB-25795 47 Hale St",
      body_content: `
        <a href="https://primeeco.tech/share/assessment">Assessment Report</a>
        <a href="https://primeeco.tech/share/photos">Photo Schedule</a>
        <a href="https://primeeco.tech/share/scope">Scope of Works</a>
      `,
      received_at: "2026-07-10T01:00:00Z",
    },
  ]);
  assertEquals(selected?.post_id, "original");
});

Deno.test("summarizeLinkBackfill: dry-run by default, patches a report job missing links", () => {
  const report = summarizeLinkBackfill({
    jobs: [{
      job_id: "j-roof",
      external_ref: "MLB-26010",
      report_type: "roof_report",
      job_status: "accepted",
      current_external_links: [],
      email_body: ROOF_EMAIL_BODY,
      evidence_email_id: "post-1",
    }],
  });
  assertEquals(report.dry_run, true);
  assertEquals(report.counts.report_family_missing_links, 1);
  assertEquals(report.counts.patches_planned, 1);
  assertEquals(report.patches[0].job_id, "j-roof");
  assertEquals(report.patches[0].evidence_email_id, "post-1");
  assert(report.patches[0].recovered_links.length >= 1);
});

Deno.test("summarizeLinkBackfill: a partial assessment triad is completed without replacing the existing link", () => {
  const report = summarizeLinkBackfill({
    jobs: [{
      job_id: "j-has-links",
      external_ref: "MLB-26011",
      report_type: "assessment_report",
      current_external_links: [{
        label: "Assessment report",
        url: "https://primeeco.tech/share/assessment-1",
        kind: "assessment_report",
      }],
      email_body: `
        <a href="https://primeeco.tech/share/assessment-1">Assessment Report</a>
        <a href="https://primeeco.tech/share/photos-1">Photo Schedule</a>
        <a href="https://primeeco.tech/share/scope-1">Scope of Works</a>
      `,
    }],
  });
  assertEquals(report.counts.report_family_missing_links, 1);
  assertEquals(report.counts.patches_planned, 1);
  assertEquals(report.patches[0].recovered_links.length, 3);
  assertEquals(
    report.patches[0].recovered_links.map((link) => link.kind),
    ["assessment_report", "photos", "quote"],
  );
  assertEquals(
    report.patches[0].recovered_links[0].url,
    "https://primeeco.tech/share/assessment-1",
  );
});

Deno.test("summarizeLinkBackfill: a complete typed triad is left untouched", () => {
  const report = summarizeLinkBackfill({
    jobs: [{
      job_id: "j-complete",
      external_ref: "MLB-26011",
      report_type: "assessment_report",
      current_external_links: [
        {
          label: "Assessment report",
          url: "https://primeeco.tech/share/assessment-1",
          kind: "assessment_report",
        },
        {
          label: "Photos",
          url: "https://primeeco.tech/share/photos-1",
          kind: "photos",
        },
        {
          label: "Scope",
          url: "https://primeeco.tech/share/scope-1",
          kind: "scope",
        },
      ],
      email_body: "No new links.",
    }],
  });
  assertEquals(report.counts.report_family_missing_links, 0);
  assertEquals(report.counts.patches_planned, 0);
});

Deno.test("summarizeLinkBackfill: non-report-family jobs are out of scope", () => {
  const report = summarizeLinkBackfill({
    jobs: [{
      job_id: "j-general",
      external_ref: "AJBR 67998",
      job_family: "general_makesafe",
      current_external_links: [],
      email_body: ROOF_EMAIL_BODY,
    }],
  });
  assertEquals(report.counts.report_family_missing_links, 0);
  assertEquals(report.counts.patches_planned, 0);
});

Deno.test("summarizeLinkBackfill: report job with no recoverable link is reported as no_source", () => {
  const report = summarizeLinkBackfill({
    jobs: [{
      job_id: "j-nolink",
      external_ref: "MLB-26012",
      report_type: "assessment_report",
      current_external_links: [],
      email_body: "Please attend and assess. No portal link in this email.",
    }],
  });
  assertEquals(report.counts.patches_planned, 0);
  assertEquals(report.counts.jobs_no_recoverable_source, 1);
  assertEquals(report.no_source[0].job_id, "j-nolink");
});

Deno.test("summarizeLinkBackfill: archived report jobs are skipped unless includeArchived", () => {
  const jobs = [{
    job_id: "j-archived",
    external_ref: "MLB-26013",
    report_type: "roof_report",
    job_status: "archived",
    current_external_links: [],
    email_body: ROOF_EMAIL_BODY,
  }];
  assertEquals(summarizeLinkBackfill({ jobs }).counts.patches_planned, 0);
  assertEquals(
    summarizeLinkBackfill({ jobs, includeArchived: true }).counts
      .patches_planned,
    1,
  );
});

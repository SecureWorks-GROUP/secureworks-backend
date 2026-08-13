// deno-lint-ignore-file no-import-prefix

import {
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildPrimeCaptureSweepItems,
  isPrimeCaptureShareUrl,
  primeCaptureSweepRole,
} from "./ses_prime_capture_sweep.ts";

Deno.test("Prime sweep admits share/report paths and rejects asset hosts", () => {
  assertEquals(isPrimeCaptureShareUrl("https://primeeco.tech/share/one"), true);
  assertEquals(
    isPrimeCaptureShareUrl("https://portal.primeeco.tech/report/two"),
    true,
  );
  assertFalse(
    isPrimeCaptureShareUrl("https://documents.primeeco.tech/logo.png"),
  );
  assertFalse(isPrimeCaptureShareUrl("https://example.com/share/one"));
});

Deno.test("Prime sweep maps legacy roof portal links but refuses ambiguous assessment links", () => {
  assertEquals(
    primeCaptureSweepRole("roof_report", "builder_portal"),
    "roof_report",
  );
  assertEquals(
    primeCaptureSweepRole("assessment_report", "assessment_report"),
    "assessment",
  );
  assertEquals(primeCaptureSweepRole("assessment_report", "quote"), "scope");
  assertEquals(
    primeCaptureSweepRole("assessment_report", "builder_portal"),
    null,
  );
});

Deno.test("Prime sweep returns every active typed URL with ordered reader history only", () => {
  const items = buildPrimeCaptureSweepItems(
    [{
      job_id: "job-1",
      job_number: "SWMS-261171",
      report_type: "roof_report",
      portal_links: [
        { role: "builder_portal", url: "https://primeeco.tech/share/roof" },
        {
          role: "builder_portal",
          url: "https://documents.primeeco.tech/logo.png",
        },
      ],
    }],
    [
      {
        id: "reader-old",
        job_id: "job-1",
        attendance_cycle_id: "cycle-1",
        role: "roof_report",
        capture_result: "done",
        source_url: "https://primeeco.tech/share/roof",
        capture_producer: "capture_portal_evidence.py/v1",
        captured_at: "2026-08-02T00:00:00Z",
        signal: "form locked/submitted, 21 of 23 answered",
        makesafe_fact_version: 1,
      },
      {
        id: "reader-new",
        job_id: "job-1",
        attendance_cycle_id: "cycle-1",
        role: "roof_report",
        capture_result: "unreachable",
        source_url: "https://primeeco.tech/share/roof",
        capture_producer: "capture_portal_evidence.py/v1",
        captured_at: "2026-08-13T00:00:00Z",
        signal: "link has expired",
        makesafe_fact_version: 2,
      },
      {
        id: "trade-tick",
        job_id: "job-1",
        attendance_cycle_id: "cycle-1",
        role: "roof_report",
        capture_result: "done",
        source_url: "https://primeeco.tech/share/roof",
        capture_producer: "trade_portal_confirmation/v1",
        captured_at: "2026-08-13T01:00:00Z",
        signal: "trade confirmed",
        makesafe_fact_version: 3,
      },
    ],
  );

  assertEquals(items.length, 1);
  assertEquals(items[0].role, "roof_report");
  assertEquals(
    (items[0].revisions as Array<Record<string, unknown>>).map((row) => row.id),
    ["reader-new", "reader-old"],
  );
});

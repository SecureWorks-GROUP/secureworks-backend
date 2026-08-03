// deno-lint-ignore-file no-import-prefix
import { assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _makesafeRenderReportForTest } from "./index.ts";
import { CommercialContentError } from "./makesafe_report_render.ts";

function makeClientStub() {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => ({
            data: table === "makesafe_job_details"
              ? { report_type: null, attendance_cycle_id: "cycle-fixture" }
              : null,
            error: null,
          }),
        }),
      }),
    }),
  };
}

Deno.test("makesafeRenderReport routes its curated payload through the commercial-content guard", async () => {
  await assertRejects(
    () =>
      _makesafeRenderReportForTest(makeClientStub(), {
        job_id: "job-fixture",
        job: {
          ref: "REF-001",
          address: "Privacy-safe test property",
          crew: "1 trade",
          scope: "Stabilise the damaged boundary.",
          findings: "The boundary fence was unstable.",
          works: "2 trades completed 3 hours billed at $480.",
          materials: "Star pickets x 20.",
          photos: [],
        },
      }),
    CommercialContentError,
    "works",
  );
});

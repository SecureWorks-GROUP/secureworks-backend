// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  INTAKE_MISSING_SUBURB_REASON,
  intakeCommittedWithoutSiteSuburb,
} from "./makesafe_intake_suburb_backstop.ts";
import {
  INTAKE_SOURCE_ISSUE_NEXT_ACTION,
  intakeSourceIssueChangeType,
} from "./makesafe_intake_source_issues.ts";

Deno.test("a minted job with no suburb is flagged", () => {
  for (const siteSuburb of [null, undefined, "", "   ", "\t\n"]) {
    assertEquals(
      intakeCommittedWithoutSiteSuburb({
        jobCreated: true,
        jobId: "job-1",
        siteSuburb,
      }),
      true,
      `expected a flag for ${JSON.stringify(siteSuburb)}`,
    );
  }
});

Deno.test("a minted job carrying a suburb is not flagged", () => {
  assertEquals(
    intakeCommittedWithoutSiteSuburb({
      jobCreated: true,
      jobId: "job-1",
      siteSuburb: "Fixtureton",
    }),
    false,
  );
});

Deno.test("a run that did not mint the job flags nothing", () => {
  // Re-linking an already-live card is not this run's commit, so re-flagging it
  // would raise an exception nobody's intake produced.
  assertEquals(
    intakeCommittedWithoutSiteSuburb({
      jobCreated: false,
      jobId: "job-1",
      siteSuburb: "",
    }),
    false,
  );
  assertEquals(
    intakeCommittedWithoutSiteSuburb({
      jobCreated: true,
      jobId: null,
      siteSuburb: "",
    }),
    false,
  );
});

Deno.test("the backstop rides the shared source-issue mechanism as a human-actionable exception", () => {
  assertEquals(
    intakeSourceIssueChangeType(INTAKE_MISSING_SUBURB_REASON),
    "intake_exception_committed_without_site_suburb",
  );
  assertEquals(
    INTAKE_SOURCE_ISSUE_NEXT_ACTION[INTAKE_MISSING_SUBURB_REASON],
    "human_supply_site_suburb",
  );
});

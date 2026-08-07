// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  flagIntakeCommitWithoutSiteSuburb,
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

// The flag write itself. It is purely informational, so it must never throw
// back at the mint it is describing, and it must not report a flag it did not
// actually land.
function issueClient(options: {
  rows?: any[];
  failSelect?: boolean;
  failInsert?: boolean;
} = {}) {
  const inserted: any[] = [];
  const rows = options.rows || [];
  const client = {
    inserted,
    from(_table: string) {
      return {
        select(_columns: string) {
          const chain: any = {
            eq() {
              return chain;
            },
            then(resolve: (value: any) => void) {
              resolve(
                options.failSelect
                  ? { data: null, error: { message: "read failed" } }
                  : { data: rows, error: null },
              );
            },
          };
          return chain;
        },
        insert(row: any) {
          if (options.failInsert) {
            return Promise.resolve({ error: { code: "42P01", message: "no" } });
          }
          inserted.push(row);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return client;
}

Deno.test("the flag writes one open source issue per source of a suburb-less commit", async () => {
  const client = issueClient();
  const result = await flagIntakeCommitWithoutSiteSuburb(client as any, {
    jobCreated: true,
    jobId: "job-1",
    siteSuburb: "  ",
    orgId: "org-1",
    mailbox: "ses@example.invalid",
    sourcePostIds: ["post-1", "post-2"],
    instructionKey: "FIX:PO-1",
    caseId: "case-1",
  });
  assertEquals(result, { flagged: true, writeFailures: 0 });
  assertEquals(client.inserted.length, 2);
  assertEquals(
    client.inserted[0].change_type,
    "intake_exception_committed_without_site_suburb",
  );
  assertEquals(
    client.inserted[0].exclusion_reason,
    INTAKE_MISSING_SUBURB_REASON,
  );
  assertEquals(
    client.inserted[0].page_meta.next_action_code,
    "human_supply_site_suburb",
  );
  assertEquals(client.inserted[0].page_meta.case_id, "case-1");
});

Deno.test("a commit carrying a suburb, or one that minted nothing, writes nothing", async () => {
  for (
    const args of [
      { jobCreated: true, jobId: "job-1", siteSuburb: "Fixtureton" },
      { jobCreated: false, jobId: "job-1", siteSuburb: "" },
      { jobCreated: true, jobId: null, siteSuburb: "" },
    ]
  ) {
    const client = issueClient();
    const result = await flagIntakeCommitWithoutSiteSuburb(client as any, {
      ...args,
      orgId: "org-1",
      mailbox: "ses@example.invalid",
      sourcePostIds: ["post-1"],
    });
    assertEquals(result, { flagged: false, writeFailures: 0 });
    assertEquals(client.inserted.length, 0);
  }
});

Deno.test("a failed flag write never reaches the mint it describes and is never counted as flagged", async () => {
  for (const failure of [{ failSelect: true }, { failInsert: true }]) {
    const client = issueClient(failure);
    const result = await flagIntakeCommitWithoutSiteSuburb(client as any, {
      jobCreated: true,
      jobId: "job-1",
      siteSuburb: null,
      orgId: "org-1",
      mailbox: "ses@example.invalid",
      sourcePostIds: ["post-1"],
    });
    // Flag, never block: the mint stands and the caller keeps going, but a
    // write that did not land must not report itself as a flag.
    assertEquals(result, { flagged: false, writeFailures: 1 });
  }
});

Deno.test("one guard covers every mint path because it sits at the single approval seam", async () => {
  const index = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  const runtime = await Deno.readTextFile(
    new URL("./makesafe_deterministic_intake_runtime.ts", import.meta.url),
  );
  // The guard runs inside approveIntakeDraft, on the branch that actually
  // minted a card.
  assertStringIncludes(
    index,
    "await flagIntakeCommitWithoutSiteSuburb(client, {",
  );
  assertStringIncludes(
    index,
    "committed_without_site_suburb: suburbBackstop.flagged",
  );
  assertEquals(
    index.split("flagIntakeCommitWithoutSiteSuburb(client, {").length - 1,
    1,
  );
  // All three mint paths converge on that one gate: the deterministic runtime
  // through its approval callback, the clean-draft backlog sweep and the manual
  // review button directly.
  assertStringIncludes(index, "approveDraft: approveIntakeDraft");
  assertStringIncludes(index, "await approveIntakeDraft(client, {");
  // ...and the runtime holds no second copy of the rule.
  assert(!runtime.includes("intakeCommittedWithoutSiteSuburb"));
  assert(!runtime.includes("flagIntakeCommitWithoutSiteSuburb"));
});

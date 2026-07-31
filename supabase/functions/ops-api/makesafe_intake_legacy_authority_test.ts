// deno-lint-ignore-file no-import-prefix no-explicit-any

import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _intakeMintAuthorityForTest,
} from "./index.ts";

Deno.test("pre-branch deterministic drafts resolve canonical authority from graph message id", async () => {
  const caseReads: Array<{ orgId: string; sourcePostIds: string[] }> = [];
  const query: any = {
    select() {
      return query;
    },
    eq(_column: string, value: string) {
      caseReads.push({ orgId: value, sourcePostIds: [] });
      return query;
    },
    in(_column: string, values: string[]) {
      caseReads[caseReads.length - 1].sourcePostIds = values;
      return query;
    },
    limit() {
      return query;
    },
    maybeSingle() {
      return Promise.resolve({
        data: { case_id: "case-legacy" },
        error: null,
      });
    },
  };
  const client = {
    from(table: string) {
      assertEquals(table, "makesafe_intake_case_sources");
      return query;
    },
  };

  const authority = await _intakeMintAuthorityForTest(
    client,
    {
      org_id: "org-1",
      graph_message_id: "legacy-post-1",
    },
    {
      deterministic_intake: true,
    },
    {},
  );

  assertEquals(authority, {
    caseId: "case-legacy",
    sourcePostIds: ["legacy-post-1"],
  });
  assertEquals(caseReads, [{
    orgId: "org-1",
    sourcePostIds: ["legacy-post-1"],
  }]);
});

Deno.test("non-SES drafts retain the non-notifying authority path", async () => {
  let queried = false;
  const authority = await _intakeMintAuthorityForTest(
    {
      from() {
        queried = true;
        throw new Error("unexpected authority query");
      },
    },
    {
      org_id: "org-1",
      graph_message_id: "routine-proposal:1",
    },
    {
      source: "routine_proposal",
    },
    {},
  );

  assertEquals(authority, null);
  assertEquals(queried, false);
});

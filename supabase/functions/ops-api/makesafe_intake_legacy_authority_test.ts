// deno-lint-ignore-file no-import-prefix no-explicit-any

import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _intakeMintAuthorityForTest,
} from "./index.ts";

type QueryState = {
  table: string;
  filters: Record<string, unknown>;
};

function legacyAuthorityClient() {
  const reads: QueryState[] = [];

  const responseFor = (state: QueryState) => {
    const inFilter = state.filters.in as {
      column: string;
      values: string[];
    } | undefined;
    if (
      state.table === "makesafe_intake_cases" &&
      inFilter?.column === "instruction_key"
    ) {
      return {
        data: [{
          id: "case-legacy",
          instruction_key: "instruction-legacy-1",
        }],
        error: null,
      };
    }
    if (
      state.table === "makesafe_intake_case_sources" &&
      inFilter?.column === "case_id"
    ) {
      return {
        data: inFilter.values.includes("case-legacy")
          ? [{
            case_id: "case-legacy",
            post_id: "real-source-post-1",
          }]
          : [],
        error: null,
      };
    }
    if (
      state.table === "makesafe_intake_case_sources" &&
      inFilter?.column === "post_id"
    ) {
      return {
        data: [{
          post_id: "real-source-post-1",
          case_id: "case-legacy",
        }],
        error: null,
      };
    }
    if (
      state.table === "makesafe_intake_source_authority_corrections" &&
      inFilter?.column === "source_post_id"
    ) {
      return {
        data: [{
          id: "correction-1",
          source_post_id: "real-source-post-1",
          legacy_case_id: "case-legacy",
          effective_case_id: "case-corrected",
          target_job_id: null,
          expected_identity_key: "po:legacy",
        }],
        error: null,
      };
    }
    if (
      state.table ===
        "makesafe_intake_source_authority_correction_supersessions" &&
      inFilter?.column === "source_post_id"
    ) {
      return {
        data: [{
          source_post_id: "real-source-post-1",
          superseded_correction_id: "correction-1",
          prior_authority_case_id: "case-corrected",
          effective_case_id: "case-final",
          expected_identity_key: "po:final",
        }],
        error: null,
      };
    }
    if (
      state.table === "makesafe_intake_cases" &&
      inFilter?.column === "id"
    ) {
      return {
        data: [{
          id: "case-final",
          instruction_key: "instruction-final",
          cycle: 1,
          parent_relation: null,
          source_fingerprint: "fingerprint-final",
          state: "ready",
          job_id: null,
        }],
        error: null,
      };
    }
    if (
      state.table === "makesafe_intake_source_authority_corrections" &&
      inFilter?.column === "effective_case_id"
    ) {
      return { data: [], error: null };
    }
    if (
      state.table ===
        "makesafe_intake_source_authority_correction_supersessions" &&
      inFilter?.column === "effective_case_id"
    ) {
      return {
        data: [{
          source_post_id: "real-source-post-1",
          effective_case_id: "case-final",
        }],
        error: null,
      };
    }
    throw new Error(
      `unexpected authority query: ${state.table} ${
        JSON.stringify(state.filters)
      }`,
    );
  };

  const client = {
    from(table: string) {
      const state: QueryState = { table, filters: {} };
      reads.push(state);
      const query: any = {
        select() {
          return query;
        },
        eq(column: string, value: unknown) {
          state.filters[`eq:${column}`] = value;
          return query;
        },
        in(column: string, values: string[]) {
          state.filters.in = { column, values };
          return query;
        },
        order() {
          return query;
        },
        range() {
          return Promise.resolve(responseFor(state));
        },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve(responseFor(state)).then(resolve);
        },
      };
      return query;
    },
  };
  return { client, reads };
}

Deno.test("synthetic pre-branch drafts recover corrected canonical source authority", async () => {
  const { client, reads } = legacyAuthorityClient();
  const authority = await _intakeMintAuthorityForTest(
    client,
    {
      org_id: "00000000-0000-0000-0000-000000000001",
      graph_message_id: "deterministic:fingerprint-legacy-1",
      deterministic_key: "draft:instruction-legacy-1",
    },
    {
      deterministic_intake: true,
    },
    {},
  );

  assertEquals(authority, {
    caseId: "case-final",
    sourcePostIds: ["real-source-post-1"],
  });
  assertEquals(
    reads.some((read) =>
      read.table === "makesafe_intake_cases" &&
      (read.filters.in as any)?.column === "instruction_key"
    ),
    true,
  );
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

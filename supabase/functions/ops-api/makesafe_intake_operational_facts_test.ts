// deno-lint-ignore-file no-import-prefix no-explicit-any

import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadIntakeOperationalFacts } from "./makesafe_intake_operational_facts.ts";

const ORG = "00000000-0000-0000-0000-000000000001";

class Query {
  private filters: Array<(row: any) => boolean> = [];
  private from = 0;
  private to = Number.MAX_SAFE_INTEGER;

  constructor(private readonly rows: any[]) {}

  select() {
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  in(column: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  order() {
    return this;
  }

  range(from: number, to: number) {
    this.from = from;
    this.to = to;
    return this;
  }

  then(resolve: (value: unknown) => void) {
    const matching = this.rows
      .filter((row) => this.filters.every((filter) => filter(row)))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .slice(this.from, this.to + 1);
    resolve({ data: matching, error: null });
  }
}

function fixtureClient(store: Record<string, any[]>) {
  return {
    from(table: string) {
      return {
        select: () => new Query(store[table] || []),
      };
    },
  } as any;
}

function intakeCase(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    org_id: ORG,
    instruction_key: `instruction-${id}`,
    lineage_id: id,
    parent_case_id: null,
    parent_relation: null,
    job_id: null,
    target_relation: null,
    target_job_id: null,
    state: "exception",
    reason_code: "below_identity_floor",
    blocked_reasons: [],
    received_at: "2026-07-27T00:00:00.000Z",
    field_provenance: {},
    ...overrides,
  };
}

Deno.test("operational fact loader pages every row and keeps pre-job and open issues visible", async () => {
  const store: Record<string, any[]> = {
    makesafe_intake_cases: [
      intakeCase("case-1"),
      intakeCase("case-2", {
        reason_code: "cancellation_target_ambiguous",
        target_relation: "cancellation_of",
        target_job_id: "job-2",
      }),
      intakeCase("case-3", {
        state: "confirmed_live_job",
        reason_code: "cancellation",
        target_relation: "cancellation_of",
        target_job_id: "job-3",
      }),
    ],
    makesafe_intake_case_sources: [
      { id: "source-1", org_id: ORG, case_id: "case-1", post_id: "post-1" },
      { id: "source-2", org_id: ORG, case_id: "case-2", post_id: "post-2" },
      { id: "source-3", org_id: ORG, case_id: "case-3", post_id: "post-3" },
    ],
    email_events_raw: [
      {
        id: "event-1",
        org_id: ORG,
        mailbox: "ses@secureworkswa.com.au",
        post_id: "post-open",
        change_type: "intake_deferred_run_cap_deferred",
        exclusion_reason: "run_cap_deferred",
        received_at: "2026-07-27T00:01:00.000Z",
        observed_at: "2026-07-27T00:01:01.000Z",
        page_meta: {},
      },
      {
        id: "event-2",
        org_id: ORG,
        mailbox: "ses@secureworkswa.com.au",
        post_id: "post-1",
        change_type: "intake_deferred_pdf_attachment_limit",
        exclusion_reason: "pdf_attachment_limit",
        received_at: "2026-07-27T00:00:00.000Z",
        observed_at: "2026-07-27T00:00:01.000Z",
        page_meta: {},
      },
    ],
    email_classifier_exclusions: [],
    jobs: [
      { id: "job-2", status: "scheduled" },
      { id: "job-3", status: "cancelled" },
    ],
  };

  const facts = await loadIntakeOperationalFacts(fixtureClient(store), {
    orgId: ORG,
    nowIso: "2026-07-27T00:05:00.000Z",
    pageSize: 2,
  });

  assertEquals(facts.length, 5);
  assertEquals(
    facts.find((fact) => fact.item_id === "case:case-1")
      ?.attachment_issue_codes,
    ["pdf_attachment_limit"],
  );
  assertEquals(
    facts.find((fact) => fact.item_id === "case:case-2")
      ?.cancellation_job_status,
    "scheduled",
  );
  assertEquals(
    facts.find((fact) => fact.item_id === "case:case-3")
      ?.cancellation_job_status,
    "cancelled",
  );
  assertEquals(
    facts.find((fact) => fact.item_id === "source:post-open")
      ?.next_action_code,
    "retry_exact_source",
  );
  assertEquals(
    facts.find((fact) => fact.item_id === "source:post-1")?.fate,
    "open_source_issue",
  );
});

Deno.test("operational fact loader fails loudly on duplicate open source issues", async () => {
  const issue = {
    org_id: ORG,
    mailbox: "ses@secureworkswa.com.au",
    post_id: "post-open",
    exclusion_reason: "run_cap_deferred",
    received_at: null,
    observed_at: "2026-07-27T00:01:01.000Z",
    page_meta: {},
  };
  const store: Record<string, any[]> = {
    makesafe_intake_cases: [],
    makesafe_intake_case_sources: [],
    email_events_raw: [
      {
        ...issue,
        id: "event-1",
        change_type: "intake_deferred_run_cap_deferred",
      },
      {
        ...issue,
        id: "event-2",
        change_type: "scan_run_cap_deferred",
      },
    ],
    email_classifier_exclusions: [],
    jobs: [],
  };

  await assertRejects(
    () =>
      loadIntakeOperationalFacts(fixtureClient(store), {
        orgId: ORG,
        pageSize: 1,
      }),
    Error,
    "uniqueness violated",
  );
});

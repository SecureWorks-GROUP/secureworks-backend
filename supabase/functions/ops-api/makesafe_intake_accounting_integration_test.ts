// deno-lint-ignore-file no-import-prefix no-explicit-any

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assertDurableSourceFates } from "./makesafe_deterministic_intake_runtime.ts";
import { loadIntakeOperationalFacts } from "./makesafe_intake_operational_facts.ts";
import { _runMakesafeReportingIntakePassForTest } from "./index.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const MAILBOX = "ses@secureworkswa.com.au";
const RECEIVED = "2026-07-27T00:00:00.000Z";

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
    resolve({
      data: this.rows
        .filter((row) => this.filters.every((filter) => filter(row)))
        .slice(this.from, this.to + 1),
      error: null,
    });
  }
}

function fixtureClient(store: Record<string, any[]>) {
  return {
    from(table: string) {
      return { select: () => new Query(store[table] || []) };
    },
  } as any;
}

function intakeCase(
  id: string,
  state: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    org_id: ORG,
    instruction_key: `instruction-${id}`,
    lineage_id: overrides.lineage_id || id,
    parent_case_id: null,
    parent_relation: null,
    job_id: null,
    target_relation: null,
    target_job_id: null,
    state,
    reason_code: null,
    blocked_reasons: [],
    received_at: RECEIVED,
    field_provenance: { external_ref: { source_post_id: `post-${id}` } },
    ...overrides,
  };
}

Deno.test("reporting boundary proves five injected durable fates and exposes their U1 facts", async () => {
  const cases = [
    intakeCase("live", "confirmed_live_job", { job_id: "job-live" }),
    intakeCase("blocked", "blocked_live_job", {
      job_id: "job-blocked",
      blocked_reasons: ["missing:client_phone"],
    }),
    intakeCase("exception", "exception", {
      reason_code: "below_identity_floor",
    }),
    intakeCase("revision", "confirmed_live_job", {
      lineage_id: "live",
      parent_case_id: "live",
      parent_relation: "revision_of",
      target_relation: "revision_of",
      target_job_id: "job-live",
      job_id: "job-revision",
      reason_code: "revision",
    }),
    intakeCase("nonwork", "accounted_non_wo", {
      reason_code: "non_makesafe",
    }),
  ];
  const postIds = cases.map((row) => `post-${row.id}`);
  const store: Record<string, any[]> = {
    makesafe_intake_cases: cases,
    makesafe_intake_case_sources: cases.map((row, index) => ({
      id: `source-${index}`,
      org_id: ORG,
      case_id: row.id,
      post_id: postIds[index],
    })),
    email_classifier_exclusions: [],
    email_events_raw: [],
    jobs: [
      { id: "job-live", status: "accepted" },
      { id: "job-blocked", status: "accepted" },
      { id: "job-revision", status: "accepted" },
    ],
  };
  const client = fixtureClient(store);
  let advancementRan = false;

  const result = await _runMakesafeReportingIntakePassForTest(client, {
    scan: async () => ({
      mode: "deterministic",
      evidence: {
        durable_source_fates: await assertDurableSourceFates(
          client,
          postIds,
        ),
      },
    }),
    advance: () => {
      advancementRan = true;
      return Promise.resolve({ auto_approved_count: 0 });
    },
  });

  assertEquals(advancementRan, true);
  assertEquals(result.accounting, { checked: 5, final: 5, transient: 0 });

  const facts = await loadIntakeOperationalFacts(client, {
    orgId: ORG,
    mailbox: MAILBOX,
    nowIso: "2026-07-27T00:05:00.000Z",
    pageSize: 2,
  });
  assertEquals(
    facts.map((fact) => fact.fate).sort(),
    [
      "accounted_non_work",
      "blocked_live_job",
      "confirmed_live_job",
      "lineage_update",
      "reason_coded_exception",
    ],
  );
  assertEquals(
    facts.find((fact) => fact.item_id === "case:exception")?.job_id,
    null,
  );
  assertEquals(
    facts.find((fact) => fact.item_id === "case:blocked")
      ?.next_action_code,
    "resolve_case_blockers",
  );
});

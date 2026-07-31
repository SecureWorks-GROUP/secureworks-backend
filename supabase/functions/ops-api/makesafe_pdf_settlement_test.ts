// deno-lint-ignore-file no-import-prefix no-explicit-any

import { assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assertFreshMakesafeSourceSettled } from "./makesafe_pdf_settlement.ts";

const ORG = "00000000-0000-0000-0000-000000000001";

function client(rows: Record<string, any[]>) {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const query: any = {
        select() {
          return query;
        },
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return query;
        },
        maybeSingle() {
          return Promise.resolve({
            data: (rows[table] || []).find((row) =>
              filters.every(([column, value]) =>
                row[column] === value
              )
            ) || null,
            error: null,
          });
        },
      };
      return query;
    },
  };
}

function completedReport(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    completion_status: "completed",
    totals: {
      write_failures: 0,
      cases_failed: 0,
      cases_deferred: 0,
      hugo_notifications_required: 1,
      hugo_notifications_accepted: 1,
      ...overrides,
    },
  };
}

Deno.test("fresh PDF handoff settles only after canonical job fate and Hugo acceptance", async () => {
  const db = client({
    makesafe_intake_case_sources: [
      { org_id: ORG, post_id: "source-1", case_id: "case-1" },
    ],
    makesafe_intake_cases: [
      {
        org_id: ORG,
        id: "case-1",
        state: "confirmed_live_job",
        job_id: "job-1",
      },
    ],
  });

  await assertFreshMakesafeSourceSettled(
    db,
    "source-1",
    completedReport(),
  );
});

Deno.test("fresh PDF handoff rejects degraded writes and incomplete Hugo settlement", async () => {
  const db = client({
    makesafe_intake_case_sources: [
      { org_id: ORG, post_id: "source-1", case_id: "case-1" },
    ],
    makesafe_intake_cases: [
      {
        org_id: ORG,
        id: "case-1",
        state: "confirmed_live_job",
        job_id: "job-1",
      },
    ],
  });

  await assertRejects(
    () =>
      assertFreshMakesafeSourceSettled(
        db,
        "source-1",
        {
          ...completedReport(),
          completion_status: "completed_degraded",
        },
      ),
    Error,
    "settlement incomplete",
  );
  await assertRejects(
    () =>
      assertFreshMakesafeSourceSettled(
        db,
        "source-1",
        completedReport({ hugo_notifications_accepted: 0 }),
      ),
    Error,
    "settlement incomplete",
  );
});

Deno.test("fresh PDF handoff rejects a report without an exact-source durable fate", async () => {
  await assertRejects(
    () =>
      assertFreshMakesafeSourceSettled(
        client({}),
        "source-missing",
        completedReport({
          hugo_notifications_required: 0,
          hugo_notifications_accepted: 0,
        }),
      ),
    Error,
    "canonical case fate missing",
  );
});

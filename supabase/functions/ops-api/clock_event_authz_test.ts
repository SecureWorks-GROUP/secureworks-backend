// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { prepareClockEventAssignment } from "./index.ts";

type Fixture = {
  assignments: Record<string, any>;
  idempotencyHits?: Record<string, any[]>;
  calls: Array<{ table: string; filters: Record<string, unknown> }>;
};

function makeClient(fixture: Fixture) {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const query: any = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return query;
        },
        limit: () => query,
        maybeSingle: () => {
          fixture.calls.push({ table, filters: { ...filters } });
          const row = table === "job_assignments"
            ? fixture.assignments[String(filters.id)] ?? null
            : null;
          return Promise.resolve({ data: row, error: null });
        },
        then: (resolve: (value: unknown) => void) => {
          fixture.calls.push({ table, filters: { ...filters } });
          const key = String(filters["detail_json->>idempotency_key"] ?? "");
          const rows = table === "job_events"
            ? fixture.idempotencyHits?.[key] ?? []
            : [];
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        },
      };
      return query;
    },
  };
}

Deno.test("clock_event authz: own assignment proceeds", async () => {
  const assignment = {
    id: "assignment-own",
    job_id: "job-1",
    user_id: "trade-own",
    status: "scheduled",
  };
  const fixture: Fixture = {
    assignments: { "assignment-own": assignment },
    calls: [],
  };

  const result = await prepareClockEventAssignment(
    makeClient(fixture),
    "assignment-own",
    "trade-own",
  );

  assertEquals(result, { assignment, duplicate: false });
  assertEquals(fixture.calls.map((call) => call.table), ["job_assignments"]);
});

Deno.test("clock_event authz: foreign assignment is denied", async () => {
  const fixture: Fixture = {
    assignments: {
      "assignment-foreign": {
        id: "assignment-foreign",
        job_id: "job-2",
        user_id: "other-trade",
      },
    },
    calls: [],
  };

  await assertRejects(
    () =>
      prepareClockEventAssignment(
        makeClient(fixture),
        "assignment-foreign",
        "trade-caller",
      ),
    Error,
    "Not your assignment",
  );

  assertEquals(fixture.calls.map((call) => call.table), ["job_assignments"]);
});

Deno.test("clock_event authz: foreign idempotency replay is denied before event lookup", async () => {
  const fixture: Fixture = {
    assignments: {
      "assignment-foreign": {
        id: "assignment-foreign",
        job_id: "job-2",
        user_id: "other-trade",
      },
    },
    idempotencyHits: { "replay-key": [{ id: "event-existing" }] },
    calls: [],
  };

  await assertRejects(
    () =>
      prepareClockEventAssignment(
        makeClient(fixture),
        "assignment-foreign",
        "trade-caller",
        "replay-key",
      ),
    Error,
    "Not your assignment",
  );

  assertEquals(
    fixture.calls.map((call) => call.table),
    ["job_assignments"],
    "ownership denial must happen before idempotency state is queried",
  );
});

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { authorizeReportingJobContext } from "./job_context_gate.ts";

const ORG_A = "00000000-0000-4000-8000-000000000001";
const ORG_B = "00000000-0000-4000-8000-000000000002";
const JOB_A = "10000000-0000-4000-8000-000000000001";
const NOTE = "Private Dispatch note must not leak";

function client(tables: Record<string, any[]>) {
  return {
    from(table: string) {
      const rows = tables[table] || [];
      const filters: Array<(row: any) => boolean> = [];
      const api: any = {
        select() {
          return api;
        },
        eq(column: string, value: unknown) {
          filters.push((row) => String(row[column]) === String(value));
          return api;
        },
        ilike(column: string, value: unknown) {
          filters.push((row) =>
            String(row[column]).toLowerCase() === String(value).toLowerCase()
          );
          return api;
        },
        limit() {
          return api;
        },
        maybeSingle() {
          const data = rows.find((row) => filters.every((filter) => filter(row))) ||
            null;
          return Promise.resolve({ data, error: null });
        },
      };
      return api;
    },
  };
}

const jobs = [{
  id: JOB_A,
  org_id: ORG_A,
  job_number: "FIX-POP-1",
  note: NOTE,
}];

Deno.test("reporting job_context refuses a non-office JWT", async () => {
  const result = await authorizeReportingJobContext({
    sb: client({
      jobs,
      users: [{ id: "trade", org_id: ORG_A, role: "installer" }],
    }),
    jobId: JOB_A,
    authMode: "jwt",
    userId: "trade",
  });
  assertEquals("error" in result, true);
  if ("error" in result) assertEquals(result.status, 403);
});

Deno.test("reporting job_context refuses a foreign-tenant office JWT", async () => {
  const result = await authorizeReportingJobContext({
    sb: client({
      jobs,
      users: [{ id: "office-b", org_id: ORG_B, role: "admin" }],
    }),
    jobId: JOB_A,
    authMode: "jwt",
    userId: "office-b",
  });
  assertEquals("error" in result, true);
  if ("error" in result) assertEquals(result.status, 403);
});

Deno.test("reporting job_context refuses a JWT with no organisation", async () => {
  const result = await authorizeReportingJobContext({
    sb: client({
      jobs,
      users: [{ id: "no-org", org_id: null, role: "admin" }],
    }),
    jobId: JOB_A,
    authMode: "jwt",
    userId: "no-org",
  });
  assertEquals("error" in result, true);
  if ("error" in result) assertEquals(result.status, 403);
});

Deno.test("reporting job_context preserves the job identity for same-org office", async () => {
  const result = await authorizeReportingJobContext({
    sb: client({
      jobs,
      users: [{ id: "office-a", org_id: ORG_A, role: "ops_manager" }],
    }),
    jobId: JOB_A,
    authMode: "jwt",
    userId: "office-a",
  });
  assertEquals("error" in result, false);
  if (!("error" in result)) {
    assertEquals(result.jobId, JOB_A);
    assertEquals(result.orgId, ORG_A);
  }
});

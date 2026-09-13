import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  authenticateReportingRequest,
  authorizeReportingJobContext,
} from "./job_context_gate.ts";

const ORG_A = "00000000-0000-4000-8000-000000000001";
const ORG_B = "00000000-0000-4000-8000-000000000002";
const JOB_A = "10000000-0000-4000-8000-000000000001";
const NOTE = "Private Dispatch note must not leak";

function client(tables: Record<string, any[]>, reads: string[] = []) {
  return {
    from(table: string) {
      reads.push(table);
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
          const data =
            rows.find((row) => filters.every((filter) => filter(row))) ||
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
  job_number: "SWF-123",
  note: NOTE,
}];

Deno.test("reporting job_context refuses a non-office JWT", async () => {
  const reads: string[] = [];
  const result = await authorizeReportingJobContext({
    sb: client({
      jobs,
      users: [{ id: "trade", org_id: ORG_A, role: "installer" }],
    }, reads),
    jobId: JOB_A,
    authMode: "jwt",
    userId: "trade",
  });
  assertEquals("error" in result, true);
  if ("error" in result) assertEquals(result.status, 403);
  assertEquals(reads, ["users"]);
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
  if ("error" in result) assertEquals(result.status, 404);
});

const keys = {
  sharedKey: "browser-key",
  serviceKey: "service-key",
  agentServerKey: "agent-key",
};

Deno.test("shared reporting credentials cannot resolve jobs through either header", async () => {
  for (const header of ["x-api-key", "authorization"]) {
    for (
      const credentials of [
        keys,
        { ...keys, agentServerKey: keys.sharedKey },
        { ...keys, serviceKey: keys.sharedKey },
      ]
    ) {
      const sb = {
        from() {
          throw new Error("Shared credentials must not read any table");
        },
        auth: {
          getUser() {
            throw new Error("Shared credentials are not JWTs");
          },
        },
      };
      const auth = await authenticateReportingRequest({
        sb,
        headers: new Headers({
          [header]: header === "authorization"
            ? "Bearer browser-key"
            : "browser-key",
        }),
        ...credentials,
      });
      assertEquals(auth, { authMode: "shared_key", userId: null });
      if (!auth) throw new Error("Expected classified shared credentials");
      for (const jobId of [JOB_A, "SWF-123"]) {
        assertEquals(
          await authorizeReportingJobContext({ sb, jobId, ...auth }),
          {
            error: "Office authorization required",
            status: 403,
          },
        );
      }
    }
  }
});

Deno.test("server-only reporting credentials preserve canonical job access", async () => {
  for (const header of ["x-api-key", "authorization"]) {
    for (const key of [keys.serviceKey, keys.agentServerKey]) {
      const sb = client({ jobs });
      const auth = await authenticateReportingRequest({
        sb,
        headers: new Headers({
          [header]: header === "authorization" ? `Bearer ${key}` : key,
        }),
        ...keys,
      });
      assertEquals(auth, { authMode: "server_key", userId: null });
      if (!auth) throw new Error("Expected server credentials");
      assertEquals(
        await authorizeReportingJobContext({ sb, jobId: "SWF-123", ...auth }),
        {
          jobId: JOB_A,
          orgId: ORG_A,
        },
      );
    }
  }
});

Deno.test("browser key plus JWT requires an office profile and resolves only its tenant", async () => {
  for (const role of ["admin", "owner", "ops_manager", "installer"]) {
    const reads: string[] = [];
    const sb = {
      ...client({
        jobs: [{ ...jobs[0], id: "foreign-job", org_id: ORG_B }, ...jobs],
        users: [{ id: "office-a", org_id: ORG_A, role }],
      }, reads),
      auth: {
        getUser(token: string) {
          assertEquals(token, "office-jwt");
          return Promise.resolve({
            data: { user: { id: "office-a" } },
            error: null,
          });
        },
      },
    };
    const auth = await authenticateReportingRequest({
      sb,
      headers: new Headers({
        "x-api-key": keys.sharedKey,
        authorization: "Bearer office-jwt",
      }),
      ...keys,
    });
    assertEquals(auth, { authMode: "jwt", userId: "office-a" });
    if (!auth) throw new Error("Expected authenticated JWT");
    const result = await authorizeReportingJobContext({
      sb,
      jobId: "SWF-123",
      ...auth,
    });
    if (role === "installer") {
      assertEquals(result, {
        error: "Office authorization required",
        status: 403,
      });
      assertEquals(reads, ["users"]);
    } else {
      assertEquals(result, { jobId: JOB_A, orgId: ORG_A });
      assertEquals(reads, ["users", "jobs"]);
    }
  }
});

Deno.test("invalid browser JWT cannot turn a shared key into office authority", async () => {
  const sb = {
    from() {
      throw new Error("Invalid JWT must not read any table");
    },
    auth: {
      getUser() {
        return Promise.resolve({
          data: { user: null },
          error: { message: "Invalid JWT" },
        });
      },
    },
  };
  const auth = await authenticateReportingRequest({
    sb,
    headers: new Headers({
      "x-api-key": keys.sharedKey,
      authorization: "Bearer invalid-jwt",
    }),
    ...keys,
  });
  assertEquals(auth, { authMode: "shared_key", userId: null });
  if (!auth) throw new Error("Expected shared credentials only");
  assertEquals(
    await authorizeReportingJobContext({ sb, jobId: JOB_A, ...auth }),
    {
      error: "Office authorization required",
      status: 403,
    },
  );
  assertEquals(
    await authenticateReportingRequest({ sb, headers: new Headers(), ...keys }),
    null,
  );
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

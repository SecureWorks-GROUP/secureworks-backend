// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _invoiceMilestoneReviewsActionForTest as action,
  _jumpCouncilStepForTest as jumpCouncil,
  _updateCouncilStatusForTest as updateCouncil,
} from "./index.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const JOB = "11000000-0000-4000-8000-000000000001";
const params = () => new URLSearchParams({ job_id: JOB });
function client(options: { missing?: boolean; error?: boolean } = {}) {
  const reads: any[] = [];
  return {
    reads,
    from(table: string) {
      const filters: Record<string, any> = {};
      const query: any = {
        select() {
          return query;
        },
        eq(k: string, v: unknown) {
          filters[k] = v;
          return query;
        },
        order() {
          return query;
        },
        maybeSingle() {
          reads.push({ table, filters });
          return Promise.resolve({
            data: options.missing ? null : { id: JOB },
            error: null,
          });
        },
        then(resolve: any) {
          reads.push({ table, filters });
          return Promise.resolve({
            data: [{
              state: "held",
              hold_reasons: ["machine_billing_terms_missing"],
            }],
            error: options.error ? { message: "unreadable" } : null,
          }).then(resolve);
        },
      };
      return query;
    },
  };
}
for (const role of ["admin", "owner", "ops_manager"]) {
  Deno.test(`invoice review read: ${role} sees held preparation only`, async () => {
    const db = client();
    const response = await action(db, params(), "GET", "jwt", {
      role,
      orgId: ORG,
    }, false);
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.reviews[0].state, "held");
    assertEquals(body.automatic_xero_drafts, false);
    assertEquals(body.preparation_only, true);
    assertEquals(body.send_requires_staff, true);
    assertEquals(db.reads.map((r) => r.filters), [{ id: JOB, org_id: ORG }, {
      job_id: JOB,
      org_id: ORG,
    }]);
  });
}
for (const role of ["trade", "lead_installer", "crew", ""]) {
  Deno.test(`invoice review read: ${role || "missing role"} denied before reads`, async () => {
    const db = client();
    assertEquals(
      (await action(db, params(), "GET", "jwt", { role, orgId: ORG }, false))
        .status,
      403,
    );
    assertEquals(db.reads, []);
  });
}
Deno.test("invoice review read: foreign or missing office org denied before reads", async () => {
  for (const orgId of ["", "99000000-0000-4000-8000-000000000001"]) {
    const db = client();
    assertEquals(
      (await action(
        db,
        params(),
        "GET",
        "jwt",
        { role: "admin", orgId },
        false,
      )).status,
      403,
    );
    assertEquals(db.reads, []);
  }
});
Deno.test("invoice review read: trusted server can read; nonprivileged key cannot", async () => {
  assertEquals(
    (await action(client(), params(), "GET", "api_key", null, true)).status,
    200,
  );
  const db = client();
  assertEquals(
    (await action(db, params(), "GET", "api_key", null, false)).status,
    403,
  );
  assertEquals(db.reads, []);
});
Deno.test("invoice review read: missing job, invalid id and writes are refused", async () => {
  assertEquals(
    (await action(
      client({ missing: true }),
      params(),
      "GET",
      "api_key",
      null,
      true,
    )).status,
    404,
  );
  assertEquals(
    (await action(
      client(),
      new URLSearchParams({ job_id: "bad" }),
      "GET",
      "api_key",
      null,
      true,
    )).status,
    400,
  );
  const db = client();
  assertEquals(
    (await action(db, params(), "POST", "api_key", null, true)).status,
    405,
  );
  assertEquals(db.reads, []);
});
Deno.test("invoice review read: unreadable review store never becomes empty success", async () => {
  await assertRejects(
    () =>
      action(client({ error: true }), params(), "GET", "api_key", null, true),
    Error,
    "could not be read",
  );
});

Deno.test("council completion: failed capture is reported before success or event logging", async () => {
  const writes: any[] = [];
  const reads: string[] = [];
  const db = {
    from(table: string) {
      reads.push(table);
      if (table !== "council_submissions") {
        throw new Error("must not read/log after failed completion");
      }
      let updating = false;
      const query: any = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        single() {
          return Promise.resolve({
            data: {
              id: "submission",
              job_id: JOB,
              steps: [{ step_id: "engineering", status: "pending" }],
            },
          });
        },
        update(payload: unknown) {
          updating = true;
          writes.push(payload);
          return query;
        },
        then(resolve: any) {
          return Promise.resolve({
            error: updating ? new Error("review queue insert failed") : null,
          }).then(resolve);
        },
      };
      return query;
    },
  };
  await assertRejects(
    () =>
      updateCouncil(db, {
        submission_id: "submission",
        step_id: "engineering",
        status: "complete",
      }),
    Error,
    "review queue insert failed",
  );
  assertEquals(writes.length, 1);
  assertEquals(reads, ["council_submissions", "council_submissions"]);
});

Deno.test("council workflow jump: completion is tagged as positioning and failed write is reported", async () => {
  const writes: any[] = [];
  const reads: string[] = [];
  const db = {
    from(table: string) {
      reads.push(table);
      if (table !== "council_submissions") {
        throw new Error("must not log after failed jump");
      }
      const query: any = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        single() {
          return Promise.resolve({
            data: {
              id: "submission",
              job_id: JOB,
              steps: [{
                step_id: "engineering",
                name: "Engineering",
                status: "pending",
              }, { step_id: "approval", name: "Approval", status: "pending" }],
            },
          });
        },
        update(payload: unknown) {
          writes.push(payload);
          return query;
        },
        then(resolve: any) {
          return Promise.resolve({
            error: new Error("council jump write failed"),
          }).then(resolve);
        },
      };
      return query;
    },
  };
  await assertRejects(
    () =>
      jumpCouncil(db, { submission_id: "submission", target_step_index: 1 }),
    Error,
    "council jump write failed",
  );
  assertEquals(writes[0].steps[0].completion_source, "workflow_jump");
  assertEquals(reads, ["council_submissions", "council_submissions"]);
});

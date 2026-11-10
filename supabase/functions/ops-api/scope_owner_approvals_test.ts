// deno-lint-ignore-file no-explicit-any
import { deepStrictEqual as assertEquals } from "node:assert/strict";
import { scopeOwnerApprovalsAction } from "./scope_owner_approvals.ts";

// Generated identifiers only, no operational records.
const ORG = crypto.randomUUID();
const JOB = crypto.randomUUID();
const REV = crypto.randomUUID();
const WO = crypto.randomUUID();
const APPROVER = crypto.randomUUID();
const STAMP = "2026-11-09T01:02:03.456789+00:00";
const PDF_SHA = "a".repeat(64);

type Opts = {
  authority?: string | null;
  authorityError?: unknown;
  recordError?: unknown;
  workOrder?: any;
  terminalFlag?: boolean;
};

function fakeClient(opts: Opts = {}) {
  const rpcs: Array<{ fn: string; args: any }> = [];
  const client = {
    rpcs,
    rpc(fn: string, args: any) {
      rpcs.push({ fn, args });
      if (fn === "owner_approval_authority") {
        return Promise.resolve({
          data: opts.authority === undefined ? "approver_list" : opts.authority,
          error: opts.authorityError ?? null,
        });
      }
      if (fn === "read_job_owner_approval_state") {
        return Promise.resolve({
          data: { job_id: args.p_job_id, price_approval: null },
          error: null,
        });
      }
      if (opts.recordError) {
        return Promise.resolve({ data: null, error: opts.recordError });
      }
      return Promise.resolve({
        data: { approval: { id: "a1" }, replayed: false },
        error: null,
      });
    },
    from(table: string) {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        maybeSingle() {
          if (table === "feature_flags") {
            return Promise.resolve({
              data: { enabled: opts.terminalFlag === true },
              error: null,
            });
          }
          return Promise.resolve({
            data: opts.workOrder === undefined
              ? { id: WO, job_id: JOB, kind: "job" }
              : opts.workOrder,
            error: null,
          });
        },
      };
    },
  };
  return client;
}

const staff = {
  staff: true,
  orgId: ORG,
  approver: { userId: APPROVER, via: "session" as const },
};

async function call(
  client: any,
  action: string,
  body: unknown,
  actor: any = staff,
  method = "POST",
) {
  const res = await scopeOwnerApprovalsAction(
    client,
    action,
    method,
    body,
    actor,
  );
  return { status: res.status, body: await res.json() };
}

Deno.test("owner approvals: a caller outside the staff set or with a bad job id records nothing", async () => {
  const client = fakeClient();
  for (const actor of [{ ...staff, staff: false }, { ...staff, orgId: null }]) {
    const r = await call(client, "approve_scope_price", {
      job_id: JOB,
      scope_revision_id: REV,
    }, actor);
    assertEquals([r.status, r.body.code], [403, "operator_access_required"]);
  }
  const bad = await call(client, "approve_scope_price", {
    job_id: "nope",
    scope_revision_id: REV,
  });
  assertEquals([bad.status, bad.body.code], [400, "job_id_required"]);
  assertEquals(client.rpcs, []);
});

Deno.test("owner approvals: ordinary staff are refused by the database rule, never by a role", async () => {
  const client = fakeClient({ authority: null });
  for (
    const [action, body] of [
      ["approve_scope_price", { job_id: JOB, scope_revision_id: REV }],
      ["approve_scope_work_order", {
        job_id: JOB,
        scope_revision_id: REV,
        work_order_id: WO,
        expected_updated_at: STAMP,
      }],
    ] as const
  ) {
    const r = await call(client, action, body);
    assertEquals([r.status, r.body.code], [403, "approver_required"]);
    assertEquals(r.body.capabilities.approve_price, false);
  }
  assertEquals(
    client.rpcs.map((c) => c.fn),
    ["owner_approval_authority", "owner_approval_authority"],
  );
  const unreadable = fakeClient({ authorityError: { code: "57014" } });
  const r = await call(unreadable, "approve_scope_price", {
    job_id: JOB,
    scope_revision_id: REV,
  });
  assertEquals([r.status, r.body.code], [503, "approvers_unreadable"]);
});

Deno.test("owner approvals: no signed-in approver, or a terminal call while its switch is off, records nothing", async () => {
  const none = fakeClient();
  const r = await call(none, "approve_scope_price", {
    job_id: JOB,
    scope_revision_id: REV,
  }, { ...staff, approver: null });
  assertEquals([r.status, r.body.code], [403, "approver_identity_missing"]);
  const terminal = fakeClient({ terminalFlag: false });
  const t = await call(terminal, "approve_scope_price", {
    job_id: JOB,
    scope_revision_id: REV,
  }, { ...staff, approver: { userId: APPROVER, via: "terminal" } });
  assertEquals(
    [t.status, t.body.code],
    [403, "terminal_approval_switched_off"],
  );
  assertEquals([...none.rpcs, ...terminal.rpcs], []);
});

Deno.test("owner approvals: the price decision names the server's approver and only the saved revision", async () => {
  const client = fakeClient({ authority: "owner" });
  const extra = await call(client, "approve_scope_price", {
    job_id: JOB,
    scope_revision_id: REV,
    approver: crypto.randomUUID(),
  });
  assertEquals([extra.status, extra.body.code], [
    400,
    "owner_approval_input_invalid",
  ]);
  const unshown = await call(client, "approve_scope_price", {
    job_id: JOB,
    scope_revision_id: REV,
  });
  assertEquals([unshown.status, unshown.body.code], [
    400,
    "quote_document_sha256s_required",
  ]);
  const badList = await call(client, "approve_scope_price", {
    job_id: JOB,
    scope_revision_id: REV,
    quote_document_sha256s: ["not-a-hash"],
  });
  assertEquals([badList.status, badList.body.code], [
    400,
    "quote_document_sha256s_required",
  ]);
  assertEquals(
    client.rpcs.filter((c) => c.fn === "record_scope_price_approval"),
    [],
  );
  const r = await call(client, "approve_scope_price", {
    job_id: JOB,
    scope_revision_id: REV,
    quote_document_sha256s: [PDF_SHA],
  });
  assertEquals(r.status, 200);
  assertEquals(r.body.capabilities.authority, "owner");
  const record = client.rpcs.filter((c) =>
    c.fn === "record_scope_price_approval"
  );
  assertEquals(record, [{
    fn: "record_scope_price_approval",
    args: {
      p_job_id: JOB,
      p_scope_revision_id: REV,
      p_approver: APPROVER,
      p_via: "session",
      p_org_id: ORG,
      p_expected_documents: [PDF_SHA],
    },
  }]);
  assertEquals(r.body.state.job_id, JOB);
});

Deno.test("owner approvals: a quote PDF list the database does not hold is refused as changed", async () => {
  const client = fakeClient({
    recordError: { code: "23514", message: "scope_owner_approval_documents_changed" },
  });
  const r = await call(client, "approve_scope_price", {
    job_id: JOB,
    scope_revision_id: REV,
    quote_document_sha256s: [],
  });
  assertEquals([r.status, r.body.code], [409, "scope_price_documents_changed"]);
});

Deno.test("owner approvals: the work order decision binds the draft as read, on its own revision", async () => {
  const client = fakeClient();
  const missing = await call(client, "approve_scope_work_order", {
    job_id: JOB,
    scope_revision_id: REV,
    work_order_id: WO,
  });
  assertEquals([missing.status, missing.body.code], [
    400,
    "expected_updated_at_required",
  ]);
  const other = fakeClient({
    workOrder: { id: WO, job_id: crypto.randomUUID(), kind: "job" },
  });
  const mismatch = await call(other, "approve_scope_work_order", {
    job_id: JOB,
    scope_revision_id: REV,
    work_order_id: WO,
    expected_updated_at: STAMP,
  });
  assertEquals([mismatch.status, mismatch.body.code], [
    409,
    "work_order_job_mismatch",
  ]);
  const crew = fakeClient({
    workOrder: { id: WO, job_id: JOB, kind: "crew" },
  });
  assertEquals(
    (await call(crew, "approve_scope_work_order", {
      job_id: JOB,
      scope_revision_id: REV,
      work_order_id: WO,
      expected_updated_at: STAMP,
    })).status,
    409,
  );
  const r = await call(client, "approve_scope_work_order", {
    job_id: JOB,
    scope_revision_id: REV,
    work_order_id: WO,
    expected_updated_at: STAMP,
  });
  assertEquals(r.status, 200);
  assertEquals(
    client.rpcs.find((c) => c.fn === "record_job_work_order_approval")?.args,
    {
      p_work_order_id: WO,
      p_approver: APPROVER,
      p_via: "session",
      p_expected_updated_at: STAMP,
      p_scope_revision_id: REV,
      p_org_id: ORG,
      p_require_revision: true,
    },
  );
});

Deno.test("owner approvals: database refusals keep their meaning", async () => {
  for (
    const [error, status, code] of [
      [
        { message: "scope_owner_approval_revision_mismatch" },
        409,
        "work_order_revision_mismatch",
      ],
      [
        { message: "scope_owner_approval_revision_not_frozen" },
        409,
        "scope_revision_not_frozen",
      ],
      [
        { message: "scope_owner_approval_job_forbidden" },
        403,
        "scope_owner_approval_job_forbidden",
      ],
      [{ code: "WO409", message: "changed" }, 409, "stale_review"],
      [
        { code: "23514", message: "already decided" },
        409,
        "work_order_not_ready",
      ],
      [
        { code: "XX000", message: "private detail" },
        503,
        "owner_approval_unavailable",
      ],
    ] as const
  ) {
    const client = fakeClient({ recordError: error });
    const r = await call(client, "approve_scope_work_order", {
      job_id: JOB,
      scope_revision_id: REV,
      work_order_id: WO,
      expected_updated_at: STAMP,
    });
    assertEquals([r.status, r.body.code], [status, code]);
    if (status === 503) assertEquals(r.body.error, undefined);
  }
});

Deno.test("owner approvals: the read carries the decisions and the server's capabilities", async () => {
  const client = fakeClient({ authority: null });
  const r = await call(
    client,
    "read_scope_owner_approvals",
    { job_id: JOB },
    staff,
    "GET",
  );
  assertEquals(r.status, 200);
  assertEquals(r.body.job_id, JOB);
  assertEquals(r.body.capabilities, {
    approve_price: false,
    approve_work_order: false,
    authority: null,
    reason: "approver_required",
  });
  assertEquals(client.rpcs[0], {
    fn: "read_job_owner_approval_state",
    args: { p_job_id: JOB, p_org_id: ORG },
  });
});

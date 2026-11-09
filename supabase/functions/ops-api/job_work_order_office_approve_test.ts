// deno-lint-ignore-file no-explicit-any
// approve_office_job_work_order follows the database's one approval rule
// (owner_approval_authority, 20261109040000) and the caller's company.
// Generated identifiers only, no operational records. No database.
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  approveOfficeJobWorkOrder,
  JobWorkOrderOfficeError,
} from "./job_work_order_office.ts";
import { decideOfficeWrite } from "./crew_invoice_job_work_order.ts";

const ORG = crypto.randomUUID();
const WO = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const DELEGATE = crypto.randomUUID();
const STAFF = crypto.randomUUID();
const STAMP = "2026-11-09T01:02:03.456789+00:00";

type Opts = {
  owners?: string[];
  approvers?: string[];
  officeFlag?: boolean;
  approveError?: { code: string; message: string } | null;
};

function fakeClient(opts: Opts = {}) {
  const owners = opts.owners ?? [OWNER];
  const approvers = opts.approvers ?? [DELEGATE];
  const rpcs: Array<{ fn: string; args: any }> = [];
  const client = {
    rpcs,
    rpc(fn: string, args: any) {
      rpcs.push({ fn, args });
      if (fn === "owner_approval_authority") {
        const user = String(args.p_user);
        const authority = owners.includes(user)
          ? "owner"
          : approvers.includes(user)
          ? "approver_list"
          : null;
        return Promise.resolve({ data: authority, error: null });
      }
      if (fn === "approve_job_work_order") {
        if (opts.approveError) {
          return Promise.resolve({ data: null, error: opts.approveError });
        }
        return Promise.resolve({
          data: {
            id: args.p_work_order_id,
            status: "draft",
            owner_approval: {
              approval: { kind: "work_order" },
              issue: { issued: false, held: true, missing: ["price_approval"] },
            },
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from(table: string) {
      const chain: any = {
        select() {
          return chain;
        },
        eq() {
          return chain;
        },
        limit() {
          // readFlag: every switch this route reads.
          return Promise.resolve({
            data: [{ enabled: table === "feature_flags" && opts.officeFlag !== false }],
            error: null,
          });
        },
        maybeSingle() {
          // work_order_settings: the two existing lists, never the owner list.
          return Promise.resolve({
            data: { approver_user_ids: approvers, backup_approver_user_ids: [] },
            error: null,
          });
        },
      };
      return chain;
    },
  };
  return client;
}

const body = { work_order_id: WO, expected_updated_at: STAMP };
const actor = (userId: string, orgId: string | null = ORG) => ({
  staff: true,
  userId,
  orgId,
});
const approveCalls = (client: any) =>
  client.rpcs.filter((c: any) => c.fn === "approve_job_work_order");

Deno.test("office approve: the owner listed only as owner approves", async () => {
  const client = fakeClient({ owners: [OWNER], approvers: [DELEGATE] });
  const out = await approveOfficeJobWorkOrder(client, body, actor(OWNER));
  assertEquals(out.issued, false);
  assertEquals(approveCalls(client), [{
    fn: "approve_job_work_order",
    args: {
      p_work_order_id: WO,
      p_approver: OWNER,
      p_via: "session",
      p_expected_updated_at: STAMP,
      p_org_id: ORG,
    },
  }]);
});

Deno.test("office approve: the existing delegate still approves", async () => {
  const client = fakeClient();
  await approveOfficeJobWorkOrder(client, body, actor(DELEGATE));
  assertEquals(approveCalls(client).length, 1);
});

Deno.test("office approve: ordinary staff, no session or no company records nothing", async () => {
  for (
    const [who, code] of [
      [actor(STAFF), "not_approver"],
      [{ staff: true, userId: null, orgId: ORG }, "not_approver"],
      [{ staff: false, userId: OWNER, orgId: ORG }, "operator_access_required"],
      [actor(OWNER, null), "operator_access_required"],
    ] as const
  ) {
    const client = fakeClient();
    const err = await assertRejects(
      () => approveOfficeJobWorkOrder(client, body, who),
      JobWorkOrderOfficeError,
    ) as JobWorkOrderOfficeError;
    assertEquals([err.status, err.code], [403, code]);
    assertEquals(approveCalls(client), []);
  }
});

Deno.test("office approve: the office switch still decides first", async () => {
  const client = fakeClient({ officeFlag: false });
  const err = await assertRejects(
    () => approveOfficeJobWorkOrder(client, body, actor(OWNER)),
    JobWorkOrderOfficeError,
  ) as JobWorkOrderOfficeError;
  assertEquals(err.code, "job_work_order_office_fill_off");
  assertEquals(approveCalls(client), []);
});

Deno.test("office approve: another company's work order reads as not found", async () => {
  const client = fakeClient({
    approveError: { code: "42501", message: "scope_owner_approval_job_forbidden" },
  });
  const err = await assertRejects(
    () => approveOfficeJobWorkOrder(client, body, actor(DELEGATE)),
    JobWorkOrderOfficeError,
  ) as JobWorkOrderOfficeError;
  assertEquals([err.status, err.code], [404, "work_order_not_found"]);
  assertEquals(approveCalls(client)[0].args.p_org_id, ORG);
});

Deno.test("office rule: the database authority decides approve only; fill and review keep their lists", () => {
  const base = {
    staff: true,
    officeFlagOn: true,
    reviewFlagOn: true,
    primaryIds: [DELEGATE],
    backupIds: [],
  };
  assertEquals(
    decideOfficeWrite({ ...base, userId: OWNER, action: "approve", approveAuthority: "owner" }).ok,
    true,
  );
  assertEquals(
    decideOfficeWrite({ ...base, userId: DELEGATE, action: "approve", approveAuthority: null }).ok,
    false,
  );
  // Fill is not widened by the owner's approval authority.
  assertEquals(
    decideOfficeWrite({ ...base, userId: OWNER, action: "fill", approveAuthority: "owner" }).ok,
    false,
  );
  assertEquals(
    decideOfficeWrite({ ...base, userId: DELEGATE, action: "fill" }).ok,
    true,
  );
});

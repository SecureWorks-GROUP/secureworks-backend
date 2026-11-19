import { assertEquals, assertRejects, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  disputeOfficeGroupHours,
  officeDaysFromBody,
  officeEnterGroupHours,
  officeEntryMarks,
  officeReason,
  withOwnOfficeEntryMarks,
} from "./group_office_days.ts";
import { GroupWorkOrderError } from "./group_work_order.ts";

const OFFICE = "00000000-0000-4000-8000-0000000000a1";
const TRADE = "00000000-0000-4000-8000-0000000000b1";
const GROUP = "00000000-0000-4000-8000-0000000000d1";
const TODAY = "2026-11-19";
const DAY = { work_date: "2026-11-16", start_time: "07:00", finish_time: "15:00", break_minutes: 30 };

type Log = { rpc: Array<{ name: string; args: any }>; reads: string[] };

function fakeClient(opts: { flag?: boolean | null; flagError?: boolean; rpcError?: string; rows?: any[]; rowsError?: boolean } = {}) {
  const log: Log = { rpc: [], reads: [] };
  const client = {
    from(table: string) {
      log.reads.push(table);
      const q: any = {
        select: () => q,
        eq: () => q,
        order: () =>
          Promise.resolve(opts.rowsError ? { data: null, error: { message: "boom" } } : { data: opts.rows ?? [], error: null }),
        maybeSingle: () =>
          Promise.resolve(
            opts.flagError
              ? { data: null, error: { message: "boom" } }
              : { data: opts.flag == null ? null : { enabled: opts.flag }, error: null },
          ),
      };
      for (const write of ["insert", "update", "upsert", "delete"]) {
        q[write] = () => {
          throw new Error(`write to ${table}`);
        };
      }
      return q;
    },
    rpc(name: string, args: any) {
      log.rpc.push({ name, args });
      return Promise.resolve(
        opts.rpcError ? { data: null, error: { message: opts.rpcError } } : { data: { ok: true }, error: null },
      );
    },
  };
  return { client, log };
}

async function code(p: Promise<unknown>): Promise<[string, number]> {
  const err = await assertRejects(() => p, GroupWorkOrderError);
  return [(err as GroupWorkOrderError).code, (err as GroupWorkOrderError).status];
}

const body = (extra: Record<string, unknown> = {}) => ({
  group_id: GROUP,
  target_user_id: TRADE,
  entries: [DAY],
  reason: "ZZTEST trade away, foreman confirmed",
  ...extra,
});

Deno.test("reason: 3 to 500 characters once trimmed", () => {
  assertEquals(officeReason("  abc  "), "abc");
  for (const bad of [undefined, "", "  ab ", "x".repeat(501), 42]) {
    let c = "";
    try {
      officeReason(bad);
    } catch (e) {
      c = (e as GroupWorkOrderError).code;
    }
    assertEquals(c, "group_reason_invalid");
  }
});

Deno.test("days: hours are worked out from the times; a bare number of hours is refused", () => {
  const [day] = officeDaysFromBody({ entries: [DAY] }, TODAY);
  assertEquals(day, { ...DAY, hours: 7.5 });
  assertEquals(officeDaysFromBody({ ...DAY }, TODAY).length, 1);
  for (const bad of [{ hours: 8 }, { entries: [{ work_date: "2026-11-16", hours: 8 }] }, { entries: [DAY, DAY] }, { entries: [] }]) {
    let c = "";
    try {
      officeDaysFromBody(bad as Record<string, unknown>, TODAY);
    } catch (e) {
      c = (e as GroupWorkOrderError).code;
    }
    assertEquals(["group_day_invalid", "group_hours_required"].includes(c), true, JSON.stringify(bad));
  }
});

Deno.test("office entry: switch off is 409 with no write; unreadable is 503 with no write", async () => {
  for (const flag of [false, null]) {
    const { client, log } = fakeClient({ flag });
    assertEquals(await code(officeEnterGroupHours(client, { userId: OFFICE, isStaff: true }, body(), TODAY)), ["group_office_day_entry_disabled", 409]);
    assertEquals(log.rpc.length, 0);
  }
  const { client, log } = fakeClient({ flagError: true });
  assertEquals(await code(officeEnterGroupHours(client, { userId: OFFICE, isStaff: true }, body(), TODAY)), ["group_office_day_entry_unreadable", 503]);
  assertEquals(log.rpc.length, 0);
});

Deno.test("office entry: a person only, a valid reason, then one RPC with server-worked hours", async () => {
  const { client, log } = fakeClient({ flag: true });
  assertEquals(await code(officeEnterGroupHours(client, { userId: null, isStaff: true }, body(), TODAY)), ["group_actor_required", 403]);
  assertEquals(await code(officeEnterGroupHours(client, { userId: OFFICE, isStaff: true }, body({ reason: "x" }), TODAY)), ["group_reason_invalid", 400]);
  assertEquals(await code(officeEnterGroupHours(client, { userId: OFFICE, isStaff: true }, body({ target_user_id: "nope" }), TODAY)), ["group_office_target_invalid", 400]);
  assertEquals(log.rpc.length, 0);
  await officeEnterGroupHours(client, { userId: OFFICE, isStaff: true }, body(), TODAY);
  assertEquals(log.rpc, [{
    name: "group_office_enter_hours",
    args: { p_group_id: GROUP, p_actor: OFFICE, p_target: TRADE, p_days: [{ ...DAY, hours: 7.5 }], p_reason: "ZZTEST trade away, foreman confirmed" },
  }]);
});

Deno.test("office entry: database refusals read as their own code, an unknown one as 503", async () => {
  const cases: Array<[string, string, number]> = [
    ["group_split_frozen", "group_split_frozen", 409],
    ["group_claim_invoiced", "group_claim_invoiced", 409],
    ["group_office_target_not_member", "group_office_target_not_member", 409],
    ["group_office_actor_not_staff", "group_office_actor_not_staff", 403],
    ["group_office_day_entry_disabled", "group_office_day_entry_disabled", 409],
    ["connection reset", "group_office_days_unreadable", 503],
  ];
  for (const [raise, want, status] of cases) {
    const { client } = fakeClient({ flag: true, rpcError: raise });
    assertEquals(await code(officeEnterGroupHours(client, { userId: OFFICE, isStaff: true }, body(), TODAY)), [want, status]);
  }
});

Deno.test("dispute: self only, the session's person is the actor, never a body field", async () => {
  const { client, log } = fakeClient({ flag: true });
  await disputeOfficeGroupHours(client, TRADE, { group_id: GROUP, reason: "ZZTEST I worked longer", user_id: OFFICE, actor: OFFICE });
  assertEquals(log.rpc, [{ name: "group_office_dispute_hours", args: { p_group_id: GROUP, p_actor: TRADE, p_reason: "ZZTEST I worked longer" } }]);
  const off = fakeClient({ flag: false });
  assertEquals(await code(disputeOfficeGroupHours(off.client, TRADE, { group_id: GROUP, reason: "ZZTEST nope" })), ["group_office_day_entry_disabled", 409]);
  assertEquals(off.log.rpc.length, 0);
  const short = fakeClient({ flag: true });
  assertEquals(await code(disputeOfficeGroupHours(short.client, TRADE, { group_id: GROUP, reason: "no" })), ["group_reason_invalid", 400]);
  assertEquals(short.log.rpc.length, 0);
  const notMine = fakeClient({ flag: true, rpcError: "group_office_entry_not_found" });
  assertEquals(await code(disputeOfficeGroupHours(notMine.client, TRADE, { group_id: GROUP, reason: "ZZTEST nope" })), ["group_office_entry_not_found", 409]);
});

Deno.test("my share: only the caller's own rows, marks added, a failed read says unknown", async () => {
  assertEquals(officeEntryMarks([{ entered_by_office: false }]), { office_entered: false, disputed: false });
  const marks = officeEntryMarks([
    { work_date: "2026-11-16", entered_by_office: true, office_entered_at: "2026-11-17T01:00:00Z", office_entry_reason: "ZZTEST first" },
    { work_date: "2026-11-17", entered_by_office: true, office_entered_at: "2026-11-18T01:00:00Z", office_entry_reason: "ZZTEST latest", disputed_at: "2026-11-18T05:00:00Z", dispute_reason: "ZZTEST wrong" },
  ]);
  assertEquals(marks, {
    office_entered: true,
    office_entry_reason: "ZZTEST latest",
    office_entered_at: "2026-11-18T01:00:00Z",
    office_entered_dates: ["2026-11-16", "2026-11-17"],
    disputed: true,
    dispute_reason: "ZZTEST wrong",
  });
  const share = { group_id: GROUP, awaiting: "needs_hours" };
  const ok = fakeClient({ rows: [{ work_date: "2026-11-16", entered_by_office: true, office_entered_at: "x", office_entry_reason: "ZZTEST r" }] });
  const merged = await withOwnOfficeEntryMarks(ok.client, TRADE, share);
  assertEquals(merged.office_entered, true);
  assertEquals(merged.awaiting, "needs_hours");
  const bad = fakeClient({ rowsError: true });
  assertEquals((await withOwnOfficeEntryMarks(bad.client, TRADE, share)).office_entry_unknown, true);
  // Not on the group: nothing read, nothing added.
  const none = fakeClient();
  const outsider = { participant: false, group_id: GROUP };
  assertEquals(await withOwnOfficeEntryMarks(none.client, TRADE, outsider), outsider);
  assertEquals(none.log.reads.length, 0);
});

Deno.test("my share read filters by the caller's own user id", async () => {
  const src = await Deno.readTextFile(new URL("./group_office_days.ts", import.meta.url));
  assertStringIncludes(src, '.eq("group_id", groupId).eq("user_id", userId)');
});

Deno.test("wiring: office door uses the session person; dispute is a trade door on the session", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const office = src.slice(src.indexOf("case 'office_enter_group_hours': {"), src.indexOf("case 'held_trade_lines':"));
  assertStringIncludes(office, "requestActor.source === 'jwt' && authMode === 'jwt' ? (authUser?.id || null) : null");
  assertStringIncludes(office, "req.method !== 'POST'");
  const scoped = src.slice(src.indexOf("const OPS_API_PROFILE_SCOPED_JWT_ACTIONS"), src.indexOf("])", src.indexOf("const OPS_API_PROFILE_SCOPED_JWT_ACTIONS")));
  assertStringIncludes(scoped, "'dispute_office_group_hours'");
  assertEquals(scoped.includes("'office_enter_group_hours'"), false);
  assertStringIncludes(src, "disputeOfficeGroupHours(client, groupCaller.userId, groupPayload)");
  assertStringIncludes(src, "withOwnOfficeEntryMarks(client, groupCaller.userId, share)");
});

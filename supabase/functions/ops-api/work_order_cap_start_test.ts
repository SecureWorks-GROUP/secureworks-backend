// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
// Follow-up 49 item 9(b), before the switch: the cap's start date doors
// (work_order_cap_start.ts). The database decides who is an approver and
// records the change; these cases pin what the doors send and refuse.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { workOrderCapStartAction } from "./work_order_cap_start.ts";

const APPROVER = "44444444-4444-4444-8444-444444444444";
const person = { staff: true, signedIn: true, userId: APPROVER, email: "approver@example.invalid" };
const serverKey = { staff: true, signedIn: false, userId: null, email: null };

function fakeClient(opts: {
  settings?: any[];
  changes?: any[];
  failTable?: string;
  rpc?: (fn: string, args: any) => any;
} = {}) {
  const calls: Array<{ fn: string; args: any }> = [];
  const reads: string[] = [];
  const query = (table: string) => {
    const q: any = {
      select: () => q,
      eq: () => q,
      order: () => q,
      limit: () => q,
      then: (res: any, rej: any) => {
        reads.push(table);
        if (opts.failTable === table) return Promise.resolve({ data: null, error: { message: "boom" } }).then(res, rej);
        const rows = table === "work_order_cap_settings" ? opts.settings ?? [] : opts.changes ?? [];
        return Promise.resolve({ data: rows, error: null }).then(res, rej);
      },
    };
    return q;
  };
  return {
    calls,
    reads,
    from: query,
    rpc: async (fn: string, args: any) => {
      calls.push({ fn, args });
      return opts.rpc ? opts.rpc(fn, args) : { data: { changed: true, cap_start_on: args.p_start, previous_start: args.p_shown_start, authority: "owner" }, error: null };
    },
  };
}

const ask = { shown_start: null, cap_start_on: "2026-11-24", reason: "  start  the cap  " };

Deno.test("set: a signed-in person's ask goes to the database door as sent, reason tidied", async () => {
  const db = fakeClient();
  const out = await workOrderCapStartAction(db, "set_work_order_cap_start", "POST", ask, person);
  assertEquals(out.status, 200);
  assertEquals(out.body, { ok: true, changed: true, cap_start_on: "2026-11-24", previous_start: null, authority: "owner" });
  assertEquals(db.calls, [{
    fn: "set_work_order_cap_start",
    args: { p_actor: APPROVER, p_actor_email: "approver@example.invalid", p_shown_start: null, p_start: "2026-11-24", p_reason: "start the cap" },
  }]);
});

Deno.test("set: the server key, GET and bad input are refused before the database", async () => {
  const cases: Array<[string, any, any, string, number, string]> = [
    ["server key", "POST", ask, "serverKey", 403, "named_person_required"],
    ["GET", "GET", ask, "person", 405, "method_not_allowed"],
    ["shown missing", "POST", { cap_start_on: "2026-11-24", reason: "start the cap" }, "person", 400, "shown_start_invalid"],
    ["start missing", "POST", { shown_start: null, reason: "start the cap" }, "person", 400, "cap_start_invalid"],
    ["not a day", "POST", { ...ask, cap_start_on: "2026-02-30" }, "person", 400, "cap_start_invalid"],
    ["not a date", "POST", { ...ask, shown_start: "soon" }, "person", 400, "shown_start_invalid"],
    ["short reason", "POST", { ...ask, reason: " x " }, "person", 400, "reason_invalid"],
  ];
  for (const [label, method, body, who, status, code] of cases) {
    const db = fakeClient();
    const out = await workOrderCapStartAction(db, "set_work_order_cap_start", method, body, who === "person" ? person : serverKey);
    assertEquals([out.status, out.body.code], [status, code], label);
    assertEquals(db.calls.length, 0, label);
  }
});

Deno.test("set: null clears the start date (no job capped)", async () => {
  const db = fakeClient();
  const out = await workOrderCapStartAction(db, "set_work_order_cap_start", "POST", { ...ask, shown_start: "2026-11-24", cap_start_on: null }, person);
  assertEquals([out.status, out.body.cap_start_on], [200, null]);
  assertEquals(db.calls[0].args.p_start, null);
});

Deno.test("set: database refusals map to their codes; anything else is 503, never a success", async () => {
  const cases: Array<[any, number, string]> = [
    [{ data: null, error: { message: "work_order_cap_start_not_approver" } }, 403, "approver_required"],
    [{ data: null, error: { message: "work_order_cap_start_changed" } }, 409, "cap_start_changed"],
    [{ data: null, error: { message: "work_order_cap_settings_missing" } }, 409, "cap_settings_missing"],
    [{ data: null, error: { message: "work_order_cap_start_reason_invalid" } }, 400, "reason_invalid"],
    [{ data: null, error: { message: "work_order_cap_start_not_recorded" } }, 503, "cap_start_unrecorded"],
    [{ data: null, error: { message: "boom", code: "XX000" } }, 503, "cap_start_unwritable"],
    [{ data: null, error: null }, 503, "cap_start_unwritable"],
    [{ data: { changed: "yes" }, error: null }, 503, "cap_start_unwritable"],
  ];
  for (const [answer, status, code] of cases) {
    const out = await workOrderCapStartAction(fakeClient({ rpc: () => answer }), "set_work_order_cap_start", "POST", ask, person);
    assertEquals([out.status, out.body.code], [status, code], JSON.stringify(answer));
  }
  const thrown = await workOrderCapStartAction(
    fakeClient({ rpc: () => Promise.reject(new TypeError("fetch failed")) }),
    "set_work_order_cap_start", "POST", ask, person,
  );
  assertEquals([thrown.status, thrown.body.code], [503, "cap_start_unwritable"]);
});

Deno.test("read: staff only; the date, its row and the record; a failed read is 503", async () => {
  const changes = [{ id: 2, via: "approver", new_start: "2026-11-24" }];
  const db = fakeClient({ settings: [{ cap_start_on: "2026-11-24", updated_at: "2026-11-18T12:00:00Z" }], changes });
  const out = await workOrderCapStartAction(db, "work_order_cap_start", "GET", {}, person);
  assertEquals(out.body, { ok: true, settings_row: true, cap_start_on: "2026-11-24", updated_at: "2026-11-18T12:00:00Z", changes });
  const none = await workOrderCapStartAction(fakeClient(), "work_order_cap_start", "GET", {}, person);
  assertEquals([none.body.settings_row, none.body.cap_start_on], [false, null]);
  const trade = await workOrderCapStartAction(fakeClient(), "work_order_cap_start", "GET", {}, { ...person, staff: false });
  assertEquals([trade.status, trade.body.code], [403, "operator_access_required"]);
  for (const table of ["work_order_cap_settings", "work_order_cap_start_changes"]) {
    const failed = await workOrderCapStartAction(fakeClient({ failTable: table }), "work_order_cap_start", "GET", {}, person);
    assertEquals([failed.status, failed.body.code], [503, "cap_start_unreadable"], table);
  }
  const post = await workOrderCapStartAction(fakeClient(), "work_order_cap_start", "POST", {}, person);
  assertEquals(post.status, 405);
});

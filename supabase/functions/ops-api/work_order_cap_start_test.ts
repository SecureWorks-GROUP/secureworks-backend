// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
// Follow-up 49 item 9(b), before the switch: the cap's start date doors
// (work_order_cap_start.ts). The database decides who is an approver and
// records the change; these cases pin what the doors send and refuse.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { capStartChangeWords, HOLD_ON_WITHOUT_START_WORDS, workOrderCapStartAction } from "./work_order_cap_start.ts";

const APPROVER = "44444444-4444-4444-8444-444444444444";
const person = { staff: true, signedIn: true, userId: APPROVER, email: "approver@example.invalid" };
const serverKey = { staff: true, signedIn: false, userId: null, email: null };

function fakeClient(opts: {
  settings?: any[];
  changes?: any[];
  flags?: any[];
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
        const rows = table === "work_order_cap_settings" ? opts.settings ?? []
          : table === "feature_flags" ? opts.flags ?? []
          : opts.changes ?? [];
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
      if (opts.rpc) return opts.rpc(fn, args);
      if (fn === "work_order_cap_start_preview") return { data: { authority: "owner", settings_row: true, cap_start_on: "2026-11-24", hold_switch_on: true }, error: null };
      return { data: { changed: true, cap_start_on: args.p_start, previous_start: args.p_shown_start, authority: "owner", hold_switch_on: false }, error: null };
    },
  };
}

const ask = { shown_start: null, cap_start_on: "2026-11-24", reason: "  start  the cap  " };

Deno.test("set: a signed-in person's ask goes to the database door as sent, reason tidied", async () => {
  const db = fakeClient();
  const out = await workOrderCapStartAction(db, "set_work_order_cap_start", "POST", ask, person);
  assertEquals(out.status, 200);
  assertEquals(out.body, {
    ok: true, effect: "set", words: capStartChangeWords(null, "2026-11-24", false).words,
    changed: true, cap_start_on: "2026-11-24", previous_start: null, authority: "owner", hold_switch_on: false,
    warning: null,
  });
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
    [{ data: null, error: { message: "work_order_cap_start_clear_while_on" } }, 409, "cap_start_clear_while_on"],
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
  assertEquals(out.body, {
    ok: true, settings_row: true, cap_start_on: "2026-11-24", updated_at: "2026-11-18T12:00:00Z",
    hold_switch_on: false, warning: null, changes,
  });
  const none = await workOrderCapStartAction(fakeClient(), "work_order_cap_start", "GET", {}, person);
  assertEquals([none.body.settings_row, none.body.cap_start_on], [false, null]);
  const trade = await workOrderCapStartAction(fakeClient(), "work_order_cap_start", "GET", {}, { ...person, staff: false });
  assertEquals([trade.status, trade.body.code], [403, "operator_access_required"]);
  for (const table of ["work_order_cap_settings", "work_order_cap_start_changes", "feature_flags"]) {
    const failed = await workOrderCapStartAction(fakeClient({ failTable: table }), "work_order_cap_start", "GET", {}, person);
    assertEquals([failed.status, failed.body.code], [503, "cap_start_unreadable"], table);
  }
  const post = await workOrderCapStartAction(fakeClient(), "work_order_cap_start", "POST", {}, person);
  assertEquals(post.status, 405);
});

Deno.test("words: an earlier day caps more jobs, a later day fewer; true for the switch either way", () => {
  const later = capStartChangeWords("2026-11-24", "2026-12-01", true);
  assertEquals([later.effect, later.refused], ["later", false]);
  assertEquals(later.words.startsWith("Later start day, 2026-11-24 to 2026-12-01: fewer jobs capped."), true, later.words);
  const earlier = capStartChangeWords("2026-12-01", "2026-11-24", true);
  assertEquals(earlier.effect, "earlier");
  assertEquals(earlier.words.startsWith("Earlier start day, 2026-12-01 to 2026-11-24: more jobs capped."), true, earlier.words);
  // Switch on: clearing is refused, and the words say so.
  const clearOn = capStartChangeWords("2026-11-24", null, true);
  assertEquals([clearOn.effect, clearOn.refused], ["cleared", true]);
  assertEquals(clearOn.words.startsWith("Not allowed while held lines are on"), true, clearOn.words);
  // Switch off: clearing changes nothing yet, and nothing says jobs are released.
  const clearOff = capStartChangeWords("2026-11-24", null, false);
  assertEquals([clearOff.effect, clearOff.refused], ["cleared", false]);
  assertEquals(clearOff.words.includes("changes nothing yet"), true, clearOff.words);
  assertEquals(/released/.test(clearOff.words), false, clearOff.words);
  assertEquals(capStartChangeWords("2026-11-24", "2026-12-01", false).words.includes("Held lines are off now"), true);
  assertEquals(capStartChangeWords("2026-11-24", "2026-12-01", null).words.includes("could not be read"), true);
  assertEquals(capStartChangeWords(null, "2026-11-24", true).effect, "set");
  assertEquals(capStartChangeWords("2026-11-24", "2026-11-24", true).effect, "unchanged");
  for (const hold of [true, false, null]) {
    for (const [a, b] of [["2026-11-24", "2026-12-01"], ["2026-12-01", "2026-11-24"], ["2026-11-24", null], [null, "2026-11-24"]] as const) {
      const w = capStartChangeWords(a, b, hold).words;
      assertEquals(w.includes("Hourly maximums still apply"), true, w);
      assertEquals(/[\u2014]|back|forward/.test(w), false, w);
    }
  }
});

Deno.test("preview: the database checks the approver first; names the effect for the switch; writes nothing", async () => {
  const db = fakeClient();
  const out = await workOrderCapStartAction(db, "set_work_order_cap_start", "POST",
    { shown_start: "2026-11-24", cap_start_on: "2026-12-01", reason: "move it later", preview: true }, person);
  assertEquals([out.status, out.body.effect, out.body.shown_matches, out.body.preview, out.body.hold_switch_on], [200, "later", true, true, true]);
  assertEquals(db.calls, [{ fn: "work_order_cap_start_preview", args: { p_actor: APPROVER } }]);
  // Only the approver read: no table is read before or instead of it.
  assertEquals(db.reads, []);
  const clear = await workOrderCapStartAction(fakeClient(), "set_work_order_cap_start", "POST",
    { shown_start: "2026-11-24", cap_start_on: null, reason: "clear it", preview: true }, person);
  assertEquals([clear.body.effect, clear.body.refused], ["cleared", true]);
  const notApprover = await workOrderCapStartAction(
    fakeClient({ rpc: () => ({ data: null, error: { message: "work_order_cap_start_not_approver" } }) }),
    "set_work_order_cap_start", "POST", { ...ask, preview: true }, person);
  assertEquals([notApprover.status, notApprover.body.code, notApprover.body.cap_start_on], [403, "approver_required", undefined]);
  const bad: any[] = [
    { data: null, error: { message: "boom" } },
    { data: { cap_start_on: "soon", hold_switch_on: true }, error: null },
    { data: { cap_start_on: null }, error: null },
    { data: null, error: null },
  ];
  for (const answer of bad) {
    const r = await workOrderCapStartAction(fakeClient({ rpc: () => answer }), "set_work_order_cap_start", "POST", { ...ask, preview: true }, person);
    assertEquals([r.status, r.body.code], [503, "cap_start_unreadable"], JSON.stringify(answer));
  }
  const thrown = await workOrderCapStartAction(fakeClient({ rpc: () => Promise.reject(new TypeError("fetch failed")) }),
    "set_work_order_cap_start", "POST", { ...ask, preview: true }, person);
  assertEquals([thrown.status, thrown.body.code], [503, "cap_start_unreadable"]);
  const key = await workOrderCapStartAction(fakeClient(), "set_work_order_cap_start", "POST", { ...ask, preview: true }, serverKey);
  assertEquals([key.status, key.body.code], [403, "named_person_required"]);
});

Deno.test("warning (own item): held lines on with no start date is said on the read, the preview and the set answer", async () => {
  const on = [{ enabled: true }];
  const warning = { code: "hold_on_without_start", words: HOLD_ON_WITHOUT_START_WORDS };
  const read = await workOrderCapStartAction(fakeClient({ settings: [{ cap_start_on: null }], flags: on }), "work_order_cap_start", "GET", {}, person);
  assertEquals([read.body.hold_switch_on, read.body.warning], [true, warning]);
  const noRow = await workOrderCapStartAction(fakeClient({ flags: on }), "work_order_cap_start", "GET", {}, person);
  assertEquals(noRow.body.warning, warning);
  const dated = await workOrderCapStartAction(fakeClient({ settings: [{ cap_start_on: "2026-11-24" }], flags: on }), "work_order_cap_start", "GET", {}, person);
  assertEquals(dated.body.warning, null);
  const off = await workOrderCapStartAction(fakeClient({ settings: [{ cap_start_on: null }], flags: [{ enabled: false }] }), "work_order_cap_start", "GET", {}, person);
  assertEquals([off.body.hold_switch_on, off.body.warning], [false, null]);
  const preview = await workOrderCapStartAction(
    fakeClient({ rpc: () => ({ data: { authority: "owner", settings_row: true, cap_start_on: null, hold_switch_on: true }, error: null }) }),
    "set_work_order_cap_start", "POST", { ...ask, preview: true }, person);
  assertEquals([preview.body.effect, preview.body.warning], ["set", warning]);
  const retry = await workOrderCapStartAction(
    fakeClient({ rpc: () => ({ data: { changed: false, cap_start_on: null, authority: "owner", hold_switch_on: true }, error: null }) }),
    "set_work_order_cap_start", "POST", { shown_start: null, cap_start_on: null, reason: "again" }, person);
  assertEquals([retry.body.changed, retry.body.warning], [false, warning]);
  assertEquals(/[\u2014]/.test(HOLD_ON_WITHOUT_START_WORDS), false);
});

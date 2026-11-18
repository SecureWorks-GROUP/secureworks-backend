import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  confirmGroupWorkOrderHours,
  decideGroupSplit,
  readGroupClaim,
  readGroupClaimFlow,
} from "./group_claim.ts";
import { GroupWorkOrderError } from "./group_work_order.ts";

const user = "crew-a";
const group = "group-a";
const booking = (id: string, date: string) => ({
  id,
  scheduled_date: date,
  clocked_on_at: date + "T08:00:00+08:00",
  clocked_off_at: date + "T16:00:00+08:00",
  hours_worked: 7.5,
  break_minutes: 30,
});
const clock = {
  bookings: [booking("first", "2026-01-05"), booking("second", "2026-01-06")],
  history: [],
};
const inputDay = (work_date: string) => ({
  work_date,
  start_time: "08:00",
  finish_time: "16:00",
  break_minutes: 30,
});
const days = clock.bookings.map((b) => inputDay(b.scheduled_date));
function fixture() {
  const writes: Record<string, any>[] = [];
  const client = {
    rpc: (name: string, args: Record<string, any>) => {
      assertEquals(args.p_actor, user);
      assertEquals(args.p_group_id, group);
      if (name === "group_claim_clock") return { data: clock };
      if (name === "group_claim_read") {
        return {
          data: {
            state: "waiting_hours",
            split_hash: null,
            pot_total: 1,
            my_days: [],
            my_hours: 0,
            my_share: null,
            crew: [{ user_id: user }],
            clock,
          },
        };
      }
      if (name === "group_claim_hours") {
        writes.push(args);
        return { data: { ok: true } };
      }
      throw new Error("unexpected_rpc");
    },
  };
  return { client, writes };
}
Deno.test("own clock supplies two booking IDs and one confirm stores the original for both days", async () => {
  const { client, writes } = fixture();
  const view = await readGroupClaim(client, group, user);
  assertEquals(view.my_suggested_days.map((d) => d.booking_id), [
    "first",
    "second",
  ]);
  assertEquals("clock" in view, false);
  await confirmGroupWorkOrderHours(client, user, {
    group_id: group,
    user_id: "other",
    days,
  });
  assertEquals(writes.length, 1);
  assertEquals(
    writes[0].p_days.map((
      d: any,
    ) => [d.suggested.booking_id, d.hours, d.changed_from_suggestion]),
    [["first", 7.5, false], ["second", 7.5, false]],
  );
});
Deno.test("edited hours and a moved day retain the original booking, a new day has none", async () => {
  const { client, writes } = fixture();
  await confirmGroupWorkOrderHours(client, user, {
    group_id: group,
    days: [
      {
        ...days[0],
        finish_time: "17:30",
        booking_id: "first",
        suggested: { hours: 99 },
      },
      { ...inputDay("2026-01-07"), booking_id: "second" },
      inputDay("2026-01-08"),
    ],
  });
  const [edited, moved, added] = writes[0].p_days;
  assertEquals([
    edited.hours,
    edited.suggested.hours,
    edited.changed_from_suggestion,
  ], [9, 7.5, true]);
  assertEquals([moved.suggested.work_date, moved.changed_from_suggestion], [
    "2026-01-06",
    true,
  ]);
  assertEquals([added.suggested, added.changed_from_suggestion], [{
    source: "none",
  }, null]);
});
Deno.test("foreign, removed or repeated booking IDs, duplicate dates and empty days cannot write", async () => {
  const { client, writes } = fixture();
  for (
    const invalid of [[], [{ ...days[0], booking_id: "other-booking" }], [
      days[0],
      days[0],
    ], [{ ...days[0], booking_id: "first" }, {
      ...days[1],
      booking_id: "first",
    }]]
  ) {
    await assertRejects(
      () =>
        confirmGroupWorkOrderHours(client, user, {
          group_id: group,
          days: invalid,
        }),
      GroupWorkOrderError,
    );
  }
  assertEquals(writes, []);
  await confirmGroupWorkOrderHours(client, user, { group_id: group, days });
  assertEquals(writes.length, 1);
});
Deno.test("invalid day refuses the whole confirm before a write", async () => {
  const { client, writes } = fixture();
  for (
    const invalid of [inputDay("2099-01-01"), {
      ...days[1],
      finish_time: "07:59",
    }, { ...days[1], finish_time: "23:00", break_minutes: 601 }]
  ) {
    await assertRejects(() =>
      confirmGroupWorkOrderHours(client, user, {
        group_id: group,
        days: [days[0], invalid],
      })
    );
  }
  assertEquals(writes, []);
});
Deno.test("one-day legacy submit preserves the other days and uses the same claim transaction", async () => {
  const { client, writes } = fixture();
  await confirmGroupWorkOrderHours(client, user, {
    group_id: group,
    days: [days[0]],
  }, "upsert");
  assertEquals(writes[0].p_mode, "upsert");
});
Deno.test("membership, unreadable data and a changed booking have distinct refusals", async () => {
  for (
    const [error, status] of [["group_claim_not_member", 403], [
      "group_clock_changed",
      409,
    ], ["read failed", 503]] as const
  ) {
    const client = { rpc: () => ({ error: { message: error } }) };
    const e = await assertRejects(
      () => readGroupClaim(client, group, user),
      GroupWorkOrderError,
    );
    assertEquals(e.status, status);
  }
  await assertRejects(
    () => readGroupClaim({ rpc: () => ({ data: {} }) }, group, user),
    GroupWorkOrderError,
  );
});
Deno.test("a failed switch read refuses legacy edits and a switched-off claim uses the old writer", async () => {
  const client = (answer: unknown) => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => answer }) }),
    }),
  });
  assertEquals(
    await readGroupClaimFlow(client({ data: { enabled: false } })),
    false,
  );
  assertEquals(
    await readGroupClaimFlow(client({ data: null, error: null })),
    false,
  );
  await assertRejects(
    () =>
      readGroupClaimFlow(
        client({ data: null, error: { message: "read failed" } }),
      ),
    GroupWorkOrderError,
  );
});
Deno.test("a decision uses only session identity and a stale split asks for a fresh read", async () => {
  const calls: any[] = [];
  const client = {
    rpc: (_name: string, args: any) => {
      calls.push(args);
      return args.p_hash === "current"
        ? { data: { all_approved: false } }
        : { error: { message: "group_split_changed" } };
    },
  };
  const e = await assertRejects(
    () =>
      decideGroupSplit(
        client,
        user,
        { group_id: group, split_hash: "old" },
        "approve",
      ),
    GroupWorkOrderError,
  );
  assertEquals([e.status, e.message], [
    409,
    "The hours changed. Check the split again.",
  ]);
  assertEquals(
    await decideGroupSplit(client, user, {
      group_id: group,
      user_id: "other",
      split_hash: "current",
      reason: "check the day",
    }, "dispute"),
    { all_approved: false },
  );
  assertEquals(calls[1].p_actor, user);
});

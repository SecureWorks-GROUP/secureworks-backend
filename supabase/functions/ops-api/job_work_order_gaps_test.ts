// deno-lint-ignore-file no-explicit-any
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { readJobWorkOrderGaps } from "./job_work_order_gaps.ts";
import { JobWorkOrderOfficeError } from "./job_work_order_office.ts";

Deno.test("office gaps use the verified company and fail closed on method, role and unreadable data", async () => {
  const actor = { staff: true, userId: null, orgId: crypto.randomUUID() };
  const answer = {
    counts: { no_work_order: 1, no_amount: 0, jobs_with_held_lines: 0 },
    jobs: [{ job_number: "ZZTEST-GAP" }],
  };
  const client = {
    rpc: (name: string, args: any) => {
      assertEquals(name, "job_work_order_gaps");
      assertEquals(args, { p_org_id: actor.orgId });
      return Promise.resolve({ data: answer, error: null });
    },
  };
  assertEquals(await readJobWorkOrderGaps(client, "GET", actor), answer);
  for (
    const rpc of [
      () => Promise.resolve({ data: null, error: { message: "unreadable" } }),
      () => Promise.resolve({ data: null, error: null }),
      () => Promise.reject(new Error("unreadable")),
    ]
  ) {
    const error = await assertRejects(
      () => readJobWorkOrderGaps({ rpc }, "GET", actor),
      JobWorkOrderOfficeError,
    );
    assertEquals([error.status, error.code], [503, "gaps_unreadable"]);
  }
  const noRead = {
    rpc: () => {
      throw new Error("must not read");
    },
  };
  for (
    const [method, profile, status] of [
      ["POST", actor, 405],
      ["GET", { ...actor, staff: false }, 403],
      ["GET", { ...actor, orgId: null }, 403],
    ] as const
  ) {
    const error = await assertRejects(
      () => readJobWorkOrderGaps(noRead, method, profile),
      JobWorkOrderOfficeError,
    );
    assertEquals(error.status, status);
  }
});

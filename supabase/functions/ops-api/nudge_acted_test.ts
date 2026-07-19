// M0/U4b — unit test for the proposed-action -> nudge acted-stamping path.
// Fake Supabase client: chainable builder that records the smart_nudges update
// and serves the feature_flags read, so we assert the flag gate + exact filters
// without a DB.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { markJobNudgesActedFromProposed } from "./nudge_acted.ts";

function fakeClient(flagEnabled: boolean) {
  const updates: { payload: any; filters: Record<string, unknown> }[] = [];
  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let updatePayload: any = null;
      const b: any = {
        select() { return b; },
        update(p: any) { updatePayload = p; return b; },
        eq(c: string, v: any) { filters[`eq_${c}`] = v; return b; },
        in(c: string, v: any) { filters[`in_${c}`] = v; return b; },
        is(c: string, v: any) { filters[`is_${c}`] = v; return b; },
        limit() { return b; },
        // Thenable: `await <chain>` resolves here.
        then(res: (v: any) => unknown) {
          let result: any;
          if (table === "feature_flags") {
            result = { data: [{ enabled: flagEnabled }], error: null };
          } else if (table === "smart_nudges") {
            updates.push({ payload: updatePayload, filters });
            result = { error: null };
          } else {
            result = { data: null, error: null };
          }
          return Promise.resolve(result).then(res);
        },
      };
      return b;
    },
  };
  return { client, updates };
}

Deno.test("U4b: flag ON stamps the job's open nudges acted, with exact filters", async () => {
  const { client, updates } = fakeClient(true);
  await markJobNudgesActedFromProposed(client, "job-1");
  assertEquals(updates.length, 1);
  assertEquals(updates[0].payload.status, "acted");
  assertEquals(typeof updates[0].payload.acted_at, "string");
  assertEquals(updates[0].filters.eq_job_id, "job-1");
  assertEquals(updates[0].filters.in_status, ["pending", "sent"]);
  assertEquals(updates[0].filters.is_acted_at, null);
});

Deno.test("U4b: flag OFF leaves nudges untouched", async () => {
  const { client, updates } = fakeClient(false);
  await markJobNudgesActedFromProposed(client, "job-1");
  assertEquals(updates.length, 0);
});

Deno.test("U4b: no job_id is a no-op (no flag read, no update)", async () => {
  const { client, updates } = fakeClient(true);
  await markJobNudgesActedFromProposed(client, null);
  assertEquals(updates.length, 0);
});

// deno-lint-ignore-file no-import-prefix no-explicit-any
// update_job_status with expected_statuses (the paid close-out's compare and set): a card
// moved by hand since it was read is left alone and nothing downstream runs.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _updateJobStatus } from "./index.ts";

function client(status: string) {
  const writes: string[] = [];
  const job = { id: "job-1", status, type: "fencing", job_number: "SWF-1" };
  const builder = (table: string) => {
    const filters: [string, string, unknown][] = [];
    let patch: any = null;
    const q: any = {
      select: () => q,
      update: (p: any) => {
        patch = p;
        return q;
      },
      insert: () => {
        writes.push(`insert:${table}`);
        return Promise.resolve({ error: null });
      },
      eq: (c: string, v: unknown) => {
        filters.push(["eq", c, v]);
        return q;
      },
      in: (c: string, v: unknown) => {
        filters.push(["in", c, v]);
        return q;
      },
      single: () => Promise.resolve({ data: job, error: null }),
      maybeSingle: () => {
        const statusFilter = filters.find(([op, c]) => op === "in" && c === "status");
        const match = !statusFilter || (statusFilter[2] as string[]).includes(job.status);
        if (patch && match) {
          writes.push(`update:${table}`);
          Object.assign(job, patch);
        }
        return Promise.resolve({ data: patch && match ? job : null, error: null });
      },
    };
    return q;
  };
  return { client: { from: builder }, writes, job };
}

Deno.test("expected_statuses: a card no longer in an expected status is left alone and nothing is logged", async () => {
  const { client: c, writes, job } = client("archived");
  const out = await _updateJobStatus(c, {
    jobId: "job-1",
    status: "get_review",
    source: "xero_sync",
    expected_statuses: ["complete", "final_payment", "invoiced"],
  });
  assertEquals(out.success, false);
  assertEquals((out as any).skipped, "status_changed");
  assertEquals(job.status, "archived");
  assertEquals(writes, []);
});

// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "jsr:@std/assert@1";
import { councilMarkLabel, setCouncilRequired } from "./council_mark.ts";

// deno-lint-ignore no-explicit-any
function fakeClient(job: Record<string, any> | null) {
  // deno-lint-ignore no-explicit-any
  const events: any[] = [];
  const client = {
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      let patch: any = null;
      const q = {
        select: () => q,
        eq: () => q,
        // deno-lint-ignore no-explicit-any
        update: (p: any) => {
          patch = p;
          return q;
        },
        maybeSingle: () => {
          if (patch && job) Object.assign(job, patch);
          return Promise.resolve({
            data: job ? { ...job } : null,
            error: null,
          });
        },
        // deno-lint-ignore no-explicit-any
        insert: (row: any) => {
          if (table === "job_events") events.push(row);
          return Promise.resolve({ error: null });
        },
      };
      return q;
    },
  };
  return { client, events };
}

Deno.test("council mark: labels", () => {
  assertEquals(councilMarkLabel(true), "needs council");
  assertEquals(councilMarkLabel(false), "no council");
  assertEquals(councilMarkLabel(null), "not answered");
  assertEquals(councilMarkLabel(undefined), "not answered");
});

Deno.test("council mark: a change records from, to, operator and source", async () => {
  const job = { id: "j1", council_required: null };
  const { client, events } = fakeClient(job);
  const r = await setCouncilRequired(client, {
    jobId: "j1",
    value: true,
    operatorId: "u1",
    actor: "user:u1",
    source: "update_job_field",
  });
  assertEquals(r, { ok: true, value: true });
  assertEquals(job.council_required, true);
  assertEquals(events.length, 1);
  assertEquals(events[0].event_type, "council_required_set");
  assertEquals(events[0].user_id, "u1");
  assertEquals(events[0].detail_json, {
    from: null,
    to: true,
    from_label: "not answered",
    to_label: "needs council",
    operator_id: "u1",
    actor: "user:u1",
    source: "update_job_field",
  });
});

Deno.test("council mark: unknown job writes nothing", async () => {
  const { client, events } = fakeClient(null);
  const r = await setCouncilRequired(client, {
    jobId: "nope",
    value: false,
    operatorId: null,
    actor: null,
    source: "update_job_field",
  });
  assertEquals(r, { ok: false, status: 404, error: "job not found" });
  assertEquals(events.length, 0);
});

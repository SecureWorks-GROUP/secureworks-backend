// R28: dispatch_commit writes canonical plan.updated_at as event_at.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleDispatch } from "../../supabase/functions/ops-api/dispatch_workbench.ts";
import { literal, openDispatchPg } from "./pg_client.ts";

const org = "00000000-0000-4000-8000-000000000001";
const actor = "event-at-producer";
const jobId = "aa000000-0000-4000-8000-000000000001";
const noteId = "aa000000-0000-4000-8000-000000000002";
const requestId = "aa000000-0000-4000-8000-000000000003";

Deno.test("human Dispatch commit stores plan.updated_at as event_at without replacing occurred_at", async () => {
  const pg = await openDispatchPg();
  try {
    const insert = await pg.query(
      `insert into jobs(id,org_id,status,accepted_at,scope_json,pricing_json,job_number)
       values(${literal(jobId)},${literal(org)},'accepted',now(),'{}'::jsonb,'{}'::jsonb,'FIX-EVENT-AT')
       returning jsonb_build_object('id',id)`,
    );
    if (insert.error) throw new Error(insert.error.message);
    const current = await handleDispatch(
      pg.client,
      org,
      actor,
      "dispatch_job",
      "GET",
      new URLSearchParams({ job_id: jobId }),
      {},
    );
    await handleDispatch(
      pg.client,
      org,
      actor,
      "dispatch_command",
      "POST",
      new URLSearchParams(),
      {
        job_id: jobId,
        expected_version: current.version,
        source_version: current.source_version,
        request_id: requestId,
        command: "note_upsert",
        payload: { id: noteId, text: "Producer event_at fixture note" },
      },
    );
    const event = await pg.query(
      `select jsonb_build_object(
         'event_at',event_at,
         'occurred_at',occurred_at,
         'plan_updated_at',(select updated_at from dispatch_plans where org_id=${
        literal(org)
      } and job_id=${literal(jobId)}),
         'correlation_id',correlation_id
       ) from business_events where correlation_id=${literal(requestId)}`,
    );
    if (event.error) throw new Error(event.error.message);
    assertEquals(event.data.correlation_id, requestId);
    assertEquals(event.data.event_at != null, true);
    assertEquals(event.data.occurred_at != null, true);
    assertEquals(event.data.event_at, event.data.plan_updated_at);
  } finally {
    await pg.close();
  }
});

// First persisted Dispatch slice for a real accepted job.
// Isolated local SQL only. No supplier send, PO, calendar write or production.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleDispatch } from "../../supabase/functions/ops-api/dispatch_workbench.ts";
import { literal, openDispatchPg } from "./pg_client.ts";

const org = "00000000-0000-4000-8000-000000000001";
const actor = "dispatch-first-slice";
const snapshot = JSON.parse(
  await Deno.readTextFile(
    new URL("./real_jobs/swf-26968.json", import.meta.url),
  ),
);
const groupId = "26968000-0000-4000-8000-000000000001";
const noteId = "26968000-0000-4000-8000-000000000099";
const requirementId = (n: number) =>
  `26968000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function dispatchJob(client: any, jobId: string) {
  return await handleDispatch(
    client,
    org,
    actor,
    "dispatch_job",
    "GET",
    new URLSearchParams({ job_id: jobId }),
    {},
  );
}

async function command(
  client: any,
  jobId: string,
  name: string,
  payload: unknown,
  requestId: string,
) {
  const current = await dispatchJob(client, jobId);
  return await handleDispatch(
    client,
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
      command: name,
      payload,
    },
  );
}

Deno.test("SWF-26968 quote lines persist through handler SQL and survive reload", async () => {
  const pg = await openDispatchPg();
  try {
    const jobId = snapshot.job_id;
    const insert = await pg.query(
      `insert into jobs(id,org_id,status,accepted_at,scope_json,pricing_json,site_address,scheduled_at)
       values(${literal(jobId)},${literal(org)},'scheduled',${
        literal(snapshot.accepted_at)
      },'{}'::jsonb,'{}'::jsonb,${literal(snapshot.suburb)},${
        literal(snapshot.scheduled_at)
      }) returning jsonb_build_object('id',id)`,
    );
    if (insert.error) throw new Error(insert.error.message);

    await command(pg.client, jobId, "group_upsert", {
      id: groupId,
      name: "Lysaght quote materials",
      position: 0,
    }, requirementId(10));

    for (const [i, line] of snapshot.quote_material_lines.entries()) {
      await command(pg.client, jobId, "requirement_upsert", {
        id: requirementId(i + 1),
        group_id: groupId,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        specification: line.supplier_name,
        destination: "site",
        phase: "installation",
        source_ref: {
          kind: "quote_line",
          job_number: snapshot.job_number,
          as_of: snapshot.as_of,
        },
      }, requirementId(20 + i));
    }

    await command(pg.client, jobId, "note_upsert", {
      id: noteId,
      text:
        "B&D claimed tubes ready 11 Sep. Bookkeeping found no paid bill. Do not collect as paid. No system PO.",
    }, requirementId(30));

    const saved = await dispatchJob(pg.client, jobId);
    assertEquals(saved.job.id, jobId);
    assertEquals(saved.groups.length, 1);
    assertEquals(saved.groups[0].name, "Lysaght quote materials");
    assertEquals(saved.requirements.length, 3);
    assertEquals(
      saved.requirements.map((r: { description: string; quantity: number }) => [
        r.description,
        r.quantity,
      ]),
      snapshot.quote_material_lines.map((
        line: { description: string; quantity: number },
      ) => [line.description, line.quantity]),
    );
    assertEquals(saved.notes.length, 1);
    assertEquals(saved.notes[0].id, noteId);
    assertEquals(saved.version >= 5, true);

    const reloaded = await dispatchJob(pg.client, jobId);
    assertEquals(reloaded.version, saved.version);
    assertEquals(reloaded.source_version, saved.source_version);
    assertEquals(reloaded.requirements.length, 3);
    assertEquals(reloaded.notes[0].text, saved.notes[0].text);
    assertEquals(reloaded.purchase_orders?.length || 0, 0);
  } finally {
    await pg.close();
  }
});

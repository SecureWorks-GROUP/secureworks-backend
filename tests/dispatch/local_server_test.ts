// deno-lint-ignore-file no-explicit-any
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createDispatchLocalHandler,
  createDispatchSqlClient,
} from "./local_server.ts";

const PSQL = "/opt/homebrew/opt/postgresql@17/bin/psql";
const ORG = "00000000-0000-4000-8000-000000000001";

const name = (value: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error("Invalid SQL identifier");
  }
  return '"' + value + '"';
};

const literal = (value: any): string =>
  value == null
    ? "null"
    : typeof value === "number"
    ? String(value)
    : typeof value === "boolean"
    ? String(value)
    : "'" +
      (typeof value === "object" ? JSON.stringify(value) : String(value))
        .replaceAll("'", "''") +
      "'" +
      (typeof value === "object" ? "::jsonb" : "");

async function openDispatchUiRollback() {
  const child = new Deno.Command(PSQL, {
    args: [
      "-X",
      "-qAt",
      "-h",
      "127.0.0.1",
      "-p",
      "55581",
      "-d",
      "dispatch_ui",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const errors = new Response(child.stderr).text();
  let buffer = "";
  let queue = Promise.resolve();
  const held = "dispatch_ui_saved_" + crypto.randomUUID().replaceAll("-", "");
  const send = (sql: string) =>
    writer.write(new TextEncoder().encode(sql + "\n"));
  async function line() {
    while (!buffer.includes("\n")) {
      const next = await reader.read();
      if (next.done) {
        throw new Error("PostgreSQL fixture stopped: " + await errors);
      }
      buffer += next.value;
    }
    const end = buffer.indexOf("\n");
    const value = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    return value;
  }
  await send(`begin;
set local lock_timeout='5s';
alter schema public rename to ${name(held)};
create schema public;
grant usage on schema public to anon,authenticated,service_role;
\\set APPLY_LUNA 1
\\i tests/dispatch/fixture.sql
\\i supabase/migrations/20260910112833_luna_context_source_revisions.sql
\\i supabase/migrations/20260912150402_dispatch_workbench.sql
delete from jobs;
create function pg_temp.dispatch_ui_test_query(statement text) returns jsonb language plpgsql as $$
declare result jsonb;
begin
  execute statement into result;
  return jsonb_build_object('data',result,'error',null);
exception when others then
  return jsonb_build_object('data',null,'error',jsonb_build_object('message',sqlerrm,'code',sqlstate));
end $$;
set role service_role;
select jsonb_build_object('ready',true,'held_schema',${literal(held)});`);
  const ready = JSON.parse(await line());
  if (!ready.ready) throw new Error("dispatch_ui fixture not ready");
  const query = (statement: string): Promise<string> => {
    const result = queue.then(async () => {
      await send(
        `select pg_temp.dispatch_ui_test_query(${literal(statement)});`,
      );
      const wrapped = JSON.parse(await line());
      if (wrapped.error) throw new Error(wrapped.error.message);
      return JSON.stringify(wrapped.data);
    });
    queue = result.then(() => {}, () => {});
    return result;
  };
  return {
    client: createDispatchSqlClient(query),
    heldSchema: ready.held_schema,
    async query(statement: string) {
      return JSON.parse(await query(statement));
    },
    async close() {
      await queue;
      await send("rollback;\n\\q");
      await writer.close();
      await reader.cancel();
      const status = await child.status;
      if (!status.success) throw new Error(await errors);
      await errors;
    },
  };
}

async function copyCommonRows(
  pg: any,
  heldSchema: string,
  table: string,
  predicate: string,
) {
  const columns = await pg.query(
    `select coalesce(jsonb_agg(column_name order by ordinal_position),'[]'::jsonb)
     from information_schema.columns
     where table_schema='public'
       and table_name=${literal(table)}
       and column_name in (
         select column_name from information_schema.columns
         where table_schema=${literal(heldSchema)} and table_name=${
      literal(table)
    }
       )`,
  );
  if (!columns.length) return;
  const list = columns.map(name).join(",");
  await pg.query(
    `with copied as (
       insert into public.${name(table)}(${list}) select ${list} from ${
      name(heldSchema)
    }.${name(table)} where ${predicate} on conflict do nothing returning 1
     )
     select jsonb_build_object('copied',coalesce(count(*),0)) from copied`,
  );
}

async function copySavedDispatchAggregate(pg: any) {
  const saved = await pg.query(
    `select jsonb_build_object(
       'org_id',org_id,
       'job_id',job_id,
       'version',version,
       'state',state,
       'source_version',source_version
     )
     from ${name(pg.heldSchema)}.dispatch_plans
     order by version desc,updated_at desc
     limit 1`,
  );
  if (!saved) throw new Error("dispatch_ui saved Dispatch plan required");
  const orgId = saved.org_id;
  const jobId = saved.job_id;
  await copyCommonRows(pg, pg.heldSchema, "jobs", `id=${literal(jobId)}`);
  await copyCommonRows(
    pg,
    pg.heldSchema,
    "job_documents",
    `job_id=${literal(jobId)}`,
  );
  await copyCommonRows(
    pg,
    pg.heldSchema,
    "purchase_orders",
    `job_id=${literal(jobId)}`,
  );
  await copyCommonRows(
    pg,
    pg.heldSchema,
    "po_communications",
    `job_id=${literal(jobId)}`,
  );
  await copyCommonRows(
    pg,
    pg.heldSchema,
    "job_media",
    `job_id=${literal(jobId)}`,
  );
  await copyCommonRows(
    pg,
    pg.heldSchema,
    "job_assignments",
    `job_id=${literal(jobId)}`,
  );
  await copyCommonRows(
    pg,
    pg.heldSchema,
    "dispatch_plans",
    `org_id=${literal(orgId)} and job_id=${literal(jobId)}`,
  );
  await copyCommonRows(
    pg,
    pg.heldSchema,
    "dispatch_commands",
    `org_id=${literal(orgId)} and job_id=${literal(jobId)}`,
  );
  await copyCommonRows(
    pg,
    pg.heldSchema,
    "dispatch_supply_lots",
    `org_id=${literal(orgId)}`,
  );
  await copyCommonRows(
    pg,
    pg.heldSchema,
    "dispatch_reservations",
    `org_id=${literal(orgId)} and job_id=${literal(jobId)}`,
  );
  return saved;
}

async function json(url: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  const response = await fetch(url, {
    ...init,
    headers,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || response.statusText);
  return body;
}

Deno.test("local dispatch server drives HTTP handler through rollback SQL transport", async () => {
  const pg = await openDispatchUiRollback();
  const controller = new AbortController();
  let port = 0;
  let ready!: () => void;
  const listening = new Promise<void>((resolve) => ready = resolve);
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: controller.signal,
    onListen(address) {
      port = address.port;
      ready();
    },
  }, createDispatchLocalHandler(pg.client, ORG, "local-server-test"));
  try {
    await listening;
    const base = `http://127.0.0.1:${port}/functions/v1/ops-api`;
    const saved = await copySavedDispatchAggregate(pg);
    const savedJob = await json(
      `${base}?action=dispatch_job&job_id=${saved.job_id}`,
    );
    assertEquals(savedJob.version, saved.version);
    assertEquals(
      savedJob.order_drafts.map((draft: any) => draft.id),
      saved.state.order_drafts.map((draft: any) => draft.id),
    );
    assertEquals(
      savedJob.purchase_orders.some((po: any) =>
        saved.state.order_drafts.some((draft: any) => draft.id === po.id)
      ),
      true,
    );
    assertEquals(savedJob.drafts, saved.state.drafts);
    assertEquals(savedJob.notes, saved.state.notes);
    const savedNoteId = crypto.randomUUID();
    const savedCommitted = await json(`${base}?action=dispatch_command`, {
      method: "POST",
      body: JSON.stringify({
        job_id: saved.job_id,
        expected_version: savedJob.version,
        source_version: savedJob.source_version,
        request_id: crypto.randomUUID(),
        command: "note_upsert",
        payload: { id: savedNoteId, text: "HTTP copied saved aggregate note" },
      }),
    });
    assertEquals(savedCommitted.version, saved.version + 1);
    const savedReloaded = await json(
      `${base}?action=dispatch_job&job_id=${saved.job_id}`,
    );
    assertEquals(
      savedReloaded.notes.some((note: any) =>
        note.id === savedNoteId &&
        note.text === "HTTP copied saved aggregate note"
      ),
      true,
    );
    const heldAfter = await pg.query(
      `select jsonb_build_object('version',version,'state',state)
       from ${name(pg.heldSchema)}.dispatch_plans
       where org_id=${literal(saved.org_id)} and job_id=${
        literal(saved.job_id)
      }`,
    );
    assertEquals(heldAfter.version, saved.version);
    assertEquals(heldAfter.state, saved.state);
    const jobId = crypto.randomUUID();
    const noteId = crypto.randomUUID();
    const commandRequestId = crypto.randomUUID();
    const retryRequestId = crypto.randomUUID();
    await pg.query(
      `insert into jobs(id,org_id,status,accepted_at,scope_json,pricing_json) values(${
        literal(jobId)
      },${
        literal(ORG)
      },'accepted',now(),'{}','{}') returning jsonb_build_object('id',id)`,
    );
    const job = await json(`${base}?action=dispatch_job&job_id=${jobId}`);
    const committed = await json(`${base}?action=dispatch_command`, {
      method: "POST",
      body: JSON.stringify({
        job_id: jobId,
        expected_version: job.version,
        source_version: job.source_version,
        request_id: commandRequestId,
        command: "note_upsert",
        payload: { id: noteId, text: "HTTP rollback fixture note" },
      }),
    });
    assertEquals(committed.version, job.version + 1);
    const reloaded = await json(`${base}?action=dispatch_job&job_id=${jobId}`);
    assertEquals(
      reloaded.notes.some((note: any) =>
        note.id === noteId && note.text === "HTTP rollback fixture note"
      ),
      true,
    );
    await json(`${base}?action=dispatch_trigger`, {
      method: "POST",
      body: JSON.stringify({ job_ids: [jobId] }),
    });
    const tasks = await json(
      `${base}?action=dispatch_tasks&status=pending&limit=100&offset=0`,
    );
    assertEquals(Array.isArray(tasks.items), true);
    assertEquals(typeof tasks.has_more, "boolean");
    const task = tasks.items.find((item: any) => item.job_id === jobId);
    if (!task) throw new Error("HTTP-triggered Dispatch task was not listed");
    const retry = await json(`${base}?action=dispatch_retry_task`, {
      method: "POST",
      body: JSON.stringify({
        job_id: jobId,
        request_id: retryRequestId,
        source_version: task.source_version,
        plan_version: task.plan_version,
        reason: "http fixture retry",
      }),
    });
    assertEquals(retry.live_actions_enabled, false);
  } finally {
    controller.abort();
    await server.finished;
    await pg.close();
  }
});

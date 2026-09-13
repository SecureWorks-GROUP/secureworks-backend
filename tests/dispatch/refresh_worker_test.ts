// deno-lint-ignore-file no-explicit-any
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runClaimedDispatchRefresh,
  runDispatchRefreshWorker,
} from "../../supabase/functions/ops-api/dispatch_refresh_worker.ts";
import { DispatchError } from "../../supabase/functions/ops-api/dispatch_workbench.ts";
import { literal, openDispatchPg } from "./pg_client.ts";

const org = "00000000-0000-4000-8000-000000000001";
const id = (n: number) =>
  `dd000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function insertAcceptedJob(pg: any, jobId: string) {
  const result = await pg.query(
    `insert into jobs(id,org_id,status,accepted_at,scope_json,pricing_json,job_number,type)
     values(${literal(jobId)},${literal(org)},'accepted',now(),'{}','{}',${
      literal(`REFRESH-${jobId.slice(-3)}`)
    },'fencing') returning jsonb_build_object('id',id)`,
  );
  if (result.error) throw new Error(result.error.message);
}

function claim(jobId: string, n = 1) {
  return {
    id: id(1000 + n),
    org_id: org,
    scope: { org_id: org, job_id: jobId },
    owner: "dispatch" as const,
    lease_token: `lease-${n}`,
    generation: n,
  };
}

function refreshClient(
  base: any,
  claimed: any,
  options: {
    recordError?: any;
    skipCommitPersistence?: boolean;
    fabricateCommandRequestId?: boolean;
    mutateSourceAfterPlanRead?: { pg: any; jobId: string };
  } = {},
) {
  const calls: any[] = [];
  let recordedReceipt: any = null;
  let finishedOutput: any = null;
  let sourceMutated = false;
  let planReadbacks = 0;
  return {
    calls,
    get recordedReceipt() {
      return recordedReceipt;
    },
    get finishedOutput() {
      return finishedOutput;
    },
    from(table: string) {
      const q = base.from(table);
      if (
        !options.fabricateCommandRequestId &&
        !options.mutateSourceAfterPlanRead
      ) {
        return q;
      }
      const originalMaybeSingle = q.maybeSingle.bind(q);
      q.maybeSingle = () => {
        const p = originalMaybeSingle();
        return Promise.resolve(p).then(async (result: any) => {
          if (
            options.fabricateCommandRequestId &&
            table === "dispatch_commands" &&
            result.data
          ) {
            return {
              ...result,
              data: { ...result.data, request_id: crypto.randomUUID() },
            };
          }
          if (
            options.mutateSourceAfterPlanRead && table === "dispatch_plans" &&
            result.data && !sourceMutated
          ) {
            planReadbacks++;
            if (planReadbacks < 2) return result;
            sourceMutated = true;
            const changed = await options.mutateSourceAfterPlanRead.pg.query(
              `insert into job_documents(id,job_id,type,accepted_at,superseded_at)
               values(${literal(crypto.randomUUID())},${
                literal(options.mutateSourceAfterPlanRead.jobId)
              },'quote',now(),null) returning jsonb_build_object('id',id)`,
            );
            if (changed.error) throw new Error(changed.error.message);
          }
          return result;
        });
      };
      return q;
    },
    async rpc(name: string, args: any) {
      calls.push({ name, args });
      if (name === "claim_workflow_refresh") {
        return { data: structuredClone(claimed), error: null };
      }
      if (name === "record_workflow_refresh_receipt") {
        if (options.recordError) {
          return { data: null, error: options.recordError };
        }
        recordedReceipt = args.p_receipt;
        return { data: { ok: true, id: args.p_id }, error: null };
      }
      if (name === "finish_workflow_refresh") {
        finishedOutput = args.p_output;
        return {
          data: { id: args.p_id, outcome: "completed", status: "completed" },
          error: null,
        };
      }
      if (name === "dispatch_commit" && options.skipCommitPersistence) {
        return { data: { version: args.p_expected + 1 }, error: null };
      }
      return await base.rpc(name, args);
    },
  };
}

Deno.test("Dispatch Refresh worker persists assessment output before recording receipt", async () => {
  const pg = await openDispatchPg();
  try {
    const jobId = id(1);
    await insertAcceptedJob(pg, jobId);
    const expectedClaim = claim(jobId);
    const client = refreshClient(pg.client, expectedClaim);
    const result = await runDispatchRefreshWorker(client, org);
    const receipt = client.recordedReceipt;
    assertEquals(result.reason, "dispatch_verified_output_unavailable");
    assertEquals(receipt.driver_version, "dispatch_refresh/v1");
    assertEquals(receipt.scope, { org_id: org, job_id: jobId });
    assertEquals(receipt.output.ok, "true");
    assertEquals(
      receipt.observed_source_revision,
      receipt.output.observed_source_revision,
    );
    assertEquals(receipt.output.output_ref.table, "dispatch_commands");
    assertEquals(receipt.output.output_ref.command, "assess");
    assert(
      receipt.output.work.missing_materials.some((item: any) =>
        item.code === "complete_set_unreviewed"
      ),
    );
    assert(
      receipt.output.work.missing_order_evidence.some((item: any) =>
        item.code === "complete_set_unreviewed"
      ),
    );
    const persisted = await pg.query(
      `select jsonb_build_object(
        'command',(select to_jsonb(c) from dispatch_commands c where c.org_id=${
        literal(org)
      } and c.request_id=${literal(receipt.output.output_ref.request_id)}),
        'plan',(select to_jsonb(p) from dispatch_plans p where p.org_id=${
        literal(org)
      } and p.job_id=${literal(jobId)})
      )`,
    );
    if (persisted.error) throw new Error(persisted.error.message);
    assertEquals(persisted.data.command.command, "assess");
    assertEquals(
      receipt.observed_source_revision,
      persisted.data.plan.source_version,
    );
    assertEquals(
      persisted.data.command.result.version,
      persisted.data.plan.version,
    );
    assertEquals(
      persisted.data.command.result.source_version,
      persisted.data.plan.source_version,
    );
    assertEquals(
      client.finishedOutput.observed_source_revision,
      persisted.data.plan.source_version,
    );
    const claimCall = client.calls.findIndex((call: any) =>
      call.name === "claim_workflow_refresh"
    );
    const commitCall = client.calls.findIndex((call: any) =>
      call.name === "dispatch_commit"
    );
    const recordCall = client.calls.find((call: any) =>
      call.name === "record_workflow_refresh_receipt"
    );
    const finishCall = client.calls.find((call: any) =>
      call.name === "finish_workflow_refresh"
    );
    assert(claimCall > -1);
    assert(commitCall > claimCall);
    assert(recordCall);
    assert(finishCall);
    assertEquals(recordCall.args.p_id, expectedClaim.id);
    assertEquals(recordCall.args.p_lease_token, expectedClaim.lease_token);
    assertEquals(recordCall.args.p_generation, expectedClaim.generation);
    assertEquals(
      recordCall.args.p_receipt.observed_source_revision,
      persisted.data.plan.source_version,
    );
    assertEquals(finishCall.args.p_id, expectedClaim.id);
    assertEquals(finishCall.args.p_lease_token, expectedClaim.lease_token);
    assertEquals(finishCall.args.p_generation, expectedClaim.generation);
    assertEquals(
      finishCall.args.p_observed_source_revision,
      persisted.data.plan.source_version,
    );
  } finally {
    await pg.close();
  }
});

Deno.test("Dispatch Refresh worker leaves run pending when receipt RPC is missing", async () => {
  const pg = await openDispatchPg();
  try {
    const jobId = id(2);
    await insertAcceptedJob(pg, jobId);
    const client = refreshClient(pg.client, claim(jobId, 2), {
      recordError: {
        code: "PGRST202",
        message:
          "Could not find public.record_workflow_refresh_receipt in the schema cache",
      },
    });
    const result = await runDispatchRefreshWorker(client, org);
    assertEquals(result.reason, "dispatch_refresh_receipt_rpc_missing");
    assertEquals(
      client.calls.some((call: any) => call.name === "finish_workflow_refresh"),
      false,
    );
    const persisted = await pg.query(
      `select jsonb_build_object(
        'commands',(select count(*) from dispatch_commands where org_id=${
        literal(org)
      } and job_id=${literal(jobId)} and command='assess'),
        'plans',(select count(*) from dispatch_plans where org_id=${
        literal(org)
      } and job_id=${literal(jobId)} and state->'assessment' is not null)
      )`,
    );
    if (persisted.error) throw new Error(persisted.error.message);
    assertEquals(persisted.data, { commands: 1, plans: 1 });
  } finally {
    await pg.close();
  }
});

Deno.test("Dispatch Refresh worker rejects listing-only commit without persisted output", async () => {
  const pg = await openDispatchPg();
  try {
    const jobId = id(3);
    await insertAcceptedJob(pg, jobId);
    const client = refreshClient(pg.client, claim(jobId, 3), {
      skipCommitPersistence: true,
    });
    await assertRejects(
      () => runDispatchRefreshWorker(client, org),
      DispatchError,
      "Refresh requires a matching persisted assessment",
    );
    assertEquals(client.recordedReceipt, null);
  } finally {
    await pg.close();
  }
});

Deno.test("Dispatch Refresh worker rejects fabricated command request readback", async () => {
  const pg = await openDispatchPg();
  try {
    const jobId = id(4);
    await insertAcceptedJob(pg, jobId);
    const client = refreshClient(pg.client, claim(jobId, 4), {
      fabricateCommandRequestId: true,
    });
    await assertRejects(
      () => runDispatchRefreshWorker(client, org),
      DispatchError,
      "Refresh requires a matching persisted assessment",
    );
    assertEquals(client.recordedReceipt, null);
  } finally {
    await pg.close();
  }
});

Deno.test("Dispatch Refresh invalid claimed scope forms fail before writes", async () => {
  const pg = await openDispatchPg();
  try {
    const jobId = id(5);
    await insertAcceptedJob(pg, jobId);
    const invalidClaims = [
      { ...claim(jobId, 5), owner: "sales" },
      { ...claim(jobId, 5), org_id: "00000000-0000-4000-8000-000000000099" },
      {
        ...claim(jobId, 5),
        scope: {
          org_id: "00000000-0000-4000-8000-000000000099",
          job_id: jobId,
        },
      },
      {
        ...claim(jobId, 5),
        scope: { org_id: org, job_id: jobId, job_ids: [jobId] },
      },
      { ...claim(jobId, 5), generation: 0 },
    ];
    for (const invalid of invalidClaims) {
      await assertRejects(
        () => runClaimedDispatchRefresh(pg.client, org, invalid as any),
        DispatchError,
        "Invalid claimed Dispatch Refresh scope or lease",
      );
    }
    const persisted = await pg.query(
      `select to_jsonb(count(*)) from dispatch_commands where org_id=${
        literal(org)
      } and job_id=${literal(jobId)}`,
    );
    if (persisted.error) throw new Error(persisted.error.message);
    assertEquals(persisted.data, 0);
  } finally {
    await pg.close();
  }
});

Deno.test("Dispatch Refresh worker refuses source drift after assessment readback", async () => {
  const pg = await openDispatchPg();
  try {
    const jobId = id(6);
    await insertAcceptedJob(pg, jobId);
    const client = refreshClient(pg.client, claim(jobId, 6), {
      mutateSourceAfterPlanRead: { pg, jobId },
    });
    await assertRejects(
      () => runDispatchRefreshWorker(client, org),
      DispatchError,
      "Refresh source changed after assessment",
    );
    assertEquals(client.recordedReceipt, null);
  } finally {
    await pg.close();
  }
});

// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  outlookDispatchProvider,
  readbackDispatchExecution,
} from "../../supabase/functions/ops-api/dispatch_execution.ts";
import {
  DispatchError,
  handleDispatch,
} from "../../supabase/functions/ops-api/dispatch_workbench.ts";
import { GraphProviderError } from "../../supabase/functions/send-outlook-email/index.ts";
import { literal, openDispatchPg } from "./pg_client.ts";

const org = "00000000-0000-4000-8000-000000000001";
const actor = "handler-sql-test";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function insertAcceptedJob(pg: any, jobId: string) {
  const result = await pg.query(
    `insert into jobs(id,org_id,status,accepted_at,scope_json,pricing_json) values(${
      literal(jobId)
    },${
      literal(org)
    },'accepted',now(),'{}','{}') returning jsonb_build_object('id',id)`,
  );
  if (result.error) throw new Error(result.error.message);
}

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

async function dispatchCommand(
  client: any,
  jobId: string,
  command: string,
  payload: any,
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
      command,
      payload,
    },
  );
}

async function dispatchEnvelope(client: any, envelope: any) {
  return await handleDispatch(
    client,
    org,
    actor,
    "dispatch_command",
    "POST",
    new URLSearchParams(),
    envelope,
  );
}

async function setupReviewedRequirement(
  client: any,
  jobId: string,
  requirementId: string,
  quantity = 10,
  unit = "each",
) {
  await dispatchCommand(client, jobId, "requirement_upsert", {
    id: requirementId,
    description: "Roof sheets",
    quantity,
    unit,
    specification: "Reviewed profile",
    destination: "site",
    phase: "roof",
  }, id(Number(requirementId.slice(-12)) + 1000));
  await dispatchCommand(client, jobId, "requirement_review", {
    id: requirementId,
  }, id(Number(requirementId.slice(-12)) + 2000));
}

Deno.test("handler SQL receipt split requires stable new id and replays custody lineage", async () => {
  const pg = await openDispatchPg();
  try {
    const jobId = id(701), requirementId = id(702), stockId = id(703);
    const allocationId = id(704), receiptId = id(705), splitId = id(706);
    await insertAcceptedJob(pg, jobId);
    await setupReviewedRequirement(pg.client, jobId, requirementId, 6);
    await dispatchCommand(pg.client, jobId, "stock_record", {
      id: stockId,
      description: "Counted sheets",
      quantity: 6,
      unit: "each",
      location: "yard",
      evidence: "Photo count",
    }, id(1703));
    await dispatchCommand(pg.client, jobId, "allocation_upsert", {
      id: allocationId,
      requirement_id: requirementId,
      supply_id: `stock:${stockId}`,
      quantity: 6,
    }, id(1704));
    await dispatchCommand(pg.client, jobId, "receipt_upsert", {
      id: receiptId,
      allocation_id: allocationId,
      usable_quantity: 6,
      damaged_quantity: 0,
      location: "yard",
      evidence: "Received at yard",
    }, id(1705));
    await assertRejects(
      () =>
        dispatchCommand(pg.client, jobId, "receipt_transfer", {
          id: receiptId,
          quantity: 2,
          location: "site",
          evidence: "Partial delivery",
        }, id(1706)),
      DispatchError,
      "Invalid UUID",
    );
    const transfer = {
      id: receiptId,
      new_id: splitId,
      quantity: 2,
      location: "site",
      evidence: "Partial delivery",
    };
    const beforeTransfer = await dispatchJob(pg.client, jobId);
    const transferEnvelope = {
      job_id: jobId,
      expected_version: beforeTransfer.version,
      source_version: beforeTransfer.source_version,
      request_id: id(1707),
      command: "receipt_transfer",
      payload: transfer,
    };
    const transferred = await dispatchEnvelope(pg.client, transferEnvelope);
    const replayed = await dispatchEnvelope(pg.client, transferEnvelope);
    assertEquals(replayed.version, transferred.version);
    const after = await dispatchJob(pg.client, jobId);
    assertEquals(after.receipts.length, 2);
    assertEquals(
      after.receipts.map((r: any) => ({
        id: r.id,
        usable: r.usable_quantity,
        damaged: r.damaged_quantity,
        location: r.location,
        split_from: r.split_from || null,
        transfers: (r.transfers || []).length,
      })),
      [
        {
          id: receiptId,
          usable: 4,
          damaged: 0,
          location: "yard",
          split_from: null,
          transfers: 0,
        },
        {
          id: splitId,
          usable: 2,
          damaged: 0,
          location: "site",
          split_from: receiptId,
          transfers: 1,
        },
      ],
    );
    assertEquals(after.receipts[1].transfers[0].from_location, "yard");
    assertEquals(after.receipts[1].transfers[0].to_location, "site");
  } finally {
    await pg.close();
  }
});

Deno.test("handler SQL moving all usable with retained damage still requires split id", async () => {
  const pg = await openDispatchPg();
  try {
    const jobId = id(711), requirementId = id(712), stockId = id(713);
    const allocationId = id(714), receiptId = id(715), splitId = id(716);
    await insertAcceptedJob(pg, jobId);
    await setupReviewedRequirement(pg.client, jobId, requirementId, 6);
    await dispatchCommand(pg.client, jobId, "stock_record", {
      id: stockId,
      description: "Counted sheets",
      quantity: 6,
      unit: "each",
      location: "yard",
      evidence: "Photo count",
    }, id(1713));
    await dispatchCommand(pg.client, jobId, "allocation_upsert", {
      id: allocationId,
      requirement_id: requirementId,
      supply_id: `stock:${stockId}`,
      quantity: 6,
    }, id(1714));
    await dispatchCommand(pg.client, jobId, "receipt_upsert", {
      id: receiptId,
      allocation_id: allocationId,
      usable_quantity: 4,
      damaged_quantity: 2,
      location: "yard",
      evidence: "Received with damage",
    }, id(1715));
    await assertRejects(
      () =>
        dispatchCommand(pg.client, jobId, "receipt_transfer", {
          id: receiptId,
          quantity: 4,
          location: "site",
          evidence: "Delivered usable sheets",
        }, id(1716)),
      DispatchError,
      "Invalid UUID",
    );
    await dispatchCommand(pg.client, jobId, "receipt_transfer", {
      id: receiptId,
      new_id: splitId,
      quantity: 4,
      location: "site",
      evidence: "Delivered usable sheets",
    }, id(1717));
    const after = await dispatchJob(pg.client, jobId);
    assertEquals(
      after.receipts.map((
        r: any,
      ) => [
        r.id,
        r.usable_quantity,
        r.damaged_quantity,
        r.location,
        r.split_from || null,
      ]),
      [
        [receiptId, 0, 2, "yard", null],
        [splitId, 4, 0, "site", receiptId],
      ],
    );
  } finally {
    await pg.close();
  }
});

Deno.test("handler SQL prepared coverage subtracts other job reservations", async () => {
  const pg = await openDispatchPg();
  try {
    const jobA = id(721), jobB = id(722), reqA = id(723), reqB = id(724);
    const originalPo = id(725), replacementPo = id(726), allocationB = id(727);
    await insertAcceptedJob(pg, jobA);
    await insertAcceptedJob(pg, jobB);
    await setupReviewedRequirement(pg.client, jobA, reqA, 10);
    await setupReviewedRequirement(pg.client, jobB, reqB, 10);
    await dispatchCommand(pg.client, jobA, "order_prepare", {
      id: originalPo,
      supplier_name: "Supplier A",
      delivery_address: "Fixture site",
      requirement_ids: [reqA],
      existing_supply_reviewed: true,
    }, id(1725));
    const ordered = await pg.query(
      `update purchase_orders set status='confirmed' where id=${
        literal(originalPo)
      } returning jsonb_build_object('status',status)`,
    );
    if (ordered.error) throw new Error(ordered.error.message);
    await dispatchCommand(pg.client, jobB, "allocation_upsert", {
      id: allocationB,
      requirement_id: reqB,
      supply_id: `po:${originalPo}:0`,
      quantity: 10,
    }, id(1727));
    await dispatchCommand(pg.client, jobA, "requirement_review", {
      id: reqA,
    }, id(3723));
    const result = await dispatchCommand(pg.client, jobA, "order_prepare", {
      id: replacementPo,
      supplier_name: "Supplier B",
      delivery_address: "Fixture site",
      requirement_ids: [reqA],
      existing_supply_reviewed: true,
      quantities: { [reqA]: 10 },
    }, id(1726));
    const replacement = result.order_drafts.find((p: any) =>
      p.id === replacementPo
    );
    assertEquals(replacement.line_items[0].quantity, 10);
    const reservation = await pg.client.rpc("dispatch_order_reservations", {
      p_org: org,
      p_job: jobA,
    });
    if (reservation.error) throw new Error(reservation.error.message);
    assertEquals(reservation.data, [{
      supply_id: `po:${originalPo}:0`,
      reserved_quantity: 10,
    }]);
  } finally {
    await pg.close();
  }
});

Deno.test("handler SQL rejects alternate PO identity and conserves capacity", async () => {
  const pg = await openDispatchPg();
  try {
    const jobA = id(731), jobB = id(732), reqA = id(733), reqB = id(734);
    const po = "abcdefab-cdef-4abc-8def-abcdefabcdef",
      allocationA = id(736),
      allocationB = id(737);
    await insertAcceptedJob(pg, jobA);
    await insertAcceptedJob(pg, jobB);
    await setupReviewedRequirement(pg.client, jobA, reqA, 10);
    await setupReviewedRequirement(pg.client, jobB, reqB, 10);
    const poResult = await pg.query(
      `insert into purchase_orders(id,org_id,job_id,status,line_items,supplier_name,notes) values(${
        literal(po)
      },${literal(org)},${
        literal(jobA)
      },'confirmed','[{"description":"Sheets","quantity":10,"unit":"each"}]'::jsonb,'Supplier','Deliver to: Site') returning jsonb_build_object('id',id)`,
    );
    if (poResult.error) throw new Error(poResult.error.message);
    await assertRejects(
      () =>
        dispatchCommand(pg.client, jobA, "allocation_upsert", {
          id: allocationA,
          requirement_id: reqA,
          supply_id: `po:${po}:00`,
          quantity: 8,
        }, id(1736)),
      DispatchError,
      "Invalid PO supply identity",
    );
    await assertRejects(
      () =>
        dispatchCommand(pg.client, jobA, "allocation_upsert", {
          id: allocationA,
          requirement_id: reqA,
          supply_id: `po:${po.toUpperCase()}:0`,
          quantity: 8,
        }, id(1739)),
      DispatchError,
      "Invalid PO supply identity",
    );
    const rawAlternate = await pg.query(
      `select dispatch_commit(${literal(org)}::uuid,${literal(jobA)}::uuid,2,${
        literal(id(1740))
      }::uuid,'raw-alternate','handler-sql-test','allocation_upsert',dispatch_source_version(${
        literal(org)
      }::uuid,${
        literal(jobA)
      }::uuid),jsonb_build_object('allocations',jsonb_build_array(jsonb_build_object('id',${
        literal(allocationA)
      },'requirement_id',${literal(reqA)},'supply_id',${
        literal(`po:${po}:00`)
      },'quantity',8,'unit','each'))),jsonb_build_array(jsonb_build_object('id',${
        literal(`po:${po}:00`)
      },'quantity',10,'unit','each','source_version','raw','source_snapshot','{"description":"Sheets","quantity":10,"unit":"each"}'::jsonb,'source_ref',jsonb_build_object('kind','purchase_order_line','po_id',${
        literal(po)
      },'index',0,'job_id',${
        literal(jobA)
      },'po_lines','[{"description":"Sheets","quantity":10,"unit":"each"}]'::jsonb))))`,
    );
    assertEquals(rawAlternate.error?.message, "noncanonical_supply_identity");
    await dispatchCommand(pg.client, jobA, "allocation_upsert", {
      id: allocationA,
      requirement_id: reqA,
      supply_id: `po:${po}:0`,
      quantity: 8,
    }, id(1737));
    await assertRejects(
      () =>
        dispatchCommand(pg.client, jobB, "allocation_upsert", {
          id: allocationB,
          requirement_id: reqB,
          supply_id: `po:${po}:0`,
          quantity: 3,
        }, id(1738)),
      DispatchError,
      "supply_overallocated",
    );
    const conserved = await pg.query(
      `select jsonb_build_object('reserved',coalesce(sum(quantity),0),'rows',count(*)) from dispatch_reservations where org_id=${
        literal(org)
      } and supply_id=${literal(`po:${po}:0`)}`,
    );
    if (conserved.error) throw new Error(conserved.error.message);
    assertEquals(conserved.data, { reserved: 8, rows: 1 });
  } finally {
    await pg.close();
  }
});

Deno.test("handler SQL expires interrupted send then recovers exact sent immutable receipt without resend", async () => {
  const pg = await openDispatchPg();
  try {
    const action = id(741), jobId = id(742), draft = id(743);
    await insertAcceptedJob(pg, jobId);
    const inserted = await pg.query(
      `insert into dispatch_executions(org_id,id,job_id,draft_id,content_hash,source_version,snapshot,status,receipt,last_error,lease_token,lease_until) values(${
        literal(org)
      },${literal(action)},${literal(jobId)},${
        literal(draft)
      },'hash-741','source-741','{}','sending',jsonb_build_object('mailbox','ops@example.test','draft_id','immutable-readback-741','change_key','ck-741'),'process stopped after send request',gen_random_uuid(),now()-interval '1 second') returning jsonb_build_object('status',status)`,
    );
    if (inserted.error) throw new Error(inserted.error.message);
    const calls: Array<{ method: string; path: string }> = [];
    let missing = true;
    const provider = outlookDispatchProvider(pg.client, ["ops@example.test"], {
      guard: () => Promise.resolve(),
      verify: () => Promise.resolve(),
      attachment: () => Promise.reject(Error("unused")),
      request: (path, options) => {
        calls.push({ method: options?.method || "GET", path });
        if (missing) {
          throw new GraphProviderError(404, "Graph request failed: 404", false);
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "immutable-readback-741",
              isDraft: false,
              internetMessageId: "<sent@example.test>",
              sentDateTime: "2026-09-13T02:00:00Z",
              changeKey: "ck-sent",
            }),
            { status: 200 },
          ),
        );
      },
    });
    const first = await readbackDispatchExecution(
      pg.client,
      org,
      action,
      provider,
    );
    assertEquals(first.action.status, "outcome_unknown");
    assertEquals(first.action.lease_until, null);
    assertEquals(first.readback_required, true);
    assertEquals(first.action.receipt.readback, {
      verified: false,
      status: 404,
    });
    missing = false;
    const second = await readbackDispatchExecution(
      pg.client,
      org,
      action,
      provider,
    );
    assertEquals(second.action.status, "accepted_not_delivered");
    assertEquals(second.readback_required, false);
    assertEquals(second.action.receipt.readback, {
      verified: true,
      id: "immutable-readback-741",
      is_draft: false,
      internet_message_id: "<sent@example.test>",
      sent_at: "2026-09-13T02:00:00Z",
      delivered: null,
    });
    assertEquals(calls.every((call) => call.method === "GET"), true);
    assertEquals(calls.some((call) => call.path.endsWith("/send")), false);
    const persisted = await pg.query(
      `select jsonb_build_object('status',status,'delivered',receipt#>'{readback,delivered}','sent_at',receipt#>>'{readback,sent_at}') from dispatch_executions where org_id=${
        literal(org)
      } and id=${literal(action)}`,
    );
    if (persisted.error) throw new Error(persisted.error.message);
    assertEquals(persisted.data, {
      status: "accepted_not_delivered",
      delivered: null,
      sent_at: "2026-09-13T02:00:00Z",
    });
  } finally {
    await pg.close();
  }
});

// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decideAttachedWorkOrderIdentityRefresh,
  refreshMakesafeIdentityAfterWorkOrderAttach,
} from "./makesafe_work_order_identity_refresh.ts";

function refreshClient(input: {
  externalRef: string | null;
  metadata: Record<string, unknown>;
}) {
  const detail = {
    job_id: "job-1",
    external_ref: input.externalRef,
    requesting_company_slug: "mlb",
  };
  const job = { id: "job-1", metadata: structuredClone(input.metadata) };
  const events: any[] = [];
  const from = (table: string) => {
    const query: any = {
      select: () => query,
      eq: () => query,
      maybeSingle: () =>
        Promise.resolve({
          data: table === "makesafe_job_details"
            ? detail
            : table === "jobs"
            ? job
            : null,
          error: null,
        }),
      update: (patch: any) => ({
        eq: () => {
          if (table === "makesafe_job_details") Object.assign(detail, patch);
          if (table === "jobs") Object.assign(job, patch);
          return Promise.resolve({ error: null });
        },
      }),
      insert: (row: any) => {
        events.push(row);
        return Promise.resolve({ error: null });
      },
    };
    return query;
  };
  return { client: { from }, detail, job, events };
}

Deno.test("attach identity refresh fills a missing key from the new builder WO", () => {
  const decision = decideAttachedWorkOrderIdentityRefresh({
    fileName: "MLB-RR-26836PO-57514.pdf",
    requestingCompanySlug: "mlb",
    metadata: { external_ref: null },
    detailExternalRef: "unknown",
  });
  assertEquals(decision.action, "correct");
  assertEquals(decision.incomingKey, "MLB-RR-26836PO-57514");
});

Deno.test("attach identity refresh never overwrites a good conflicting key", () => {
  const decision = decideAttachedWorkOrderIdentityRefresh({
    fileName: "MLB-27002PO-57002.pdf",
    requestingCompanySlug: "mlb",
    metadata: {
      external_ref: "MLB-27001PO-57001",
      builder_claim_ref: "MLB-27001",
      builder_work_order_number: "MLB-27001PO-57001",
      builder_po_number: "PO-57001",
    },
    detailExternalRef: "MLB-27001PO-57001",
  });
  assertEquals(decision.action, "conflict");
  assertEquals(decision.reason, "good_key_disagrees");
  assertEquals(decision.currentKeys, ["MLB-27001PO-57001"]);
});

Deno.test("attach identity refresh resolves only an internal conflict corroborated by the new WO", () => {
  const decision = decideAttachedWorkOrderIdentityRefresh({
    fileName: "AJBR-70062.pdf",
    requestingCompanySlug: "aj",
    metadata: { external_ref: "AJBR-70062" },
    detailExternalRef: "AJBR-70063",
  });
  assertEquals(decision.action, "correct");
  assertEquals(decision.reason, "internally_conflicting");
  assertEquals(decision.incomingKey, "AJ-70062");
});

Deno.test("attach identity refresh ignores the SecureWorks cover sheet", () => {
  const decision = decideAttachedWorkOrderIdentityRefresh({
    fileName: "work-order-SWMS-26998.pdf",
    requestingCompanySlug: "aj",
    metadata: { external_ref: null },
    detailExternalRef: null,
  });
  assertEquals(decision.action, "none");
  assertEquals(decision.reason, "self_generated");
});

Deno.test("attach identity refresh persists a correction and its visible event", async () => {
  const db = refreshClient({ externalRef: null, metadata: {} });
  const decision = await refreshMakesafeIdentityAfterWorkOrderAttach(
    db.client,
    {
      jobId: "job-1",
      documentId: "document-1",
      fileName: "MLB-RR-26836PO-57514.pdf",
    },
  );
  assertEquals(decision?.action, "correct");
  assertEquals(db.detail.external_ref, "MLB-RR-26836PO-57514");
  assertEquals(db.job.metadata.external_ref, "MLB-RR-26836PO-57514");
  assertEquals(
    db.events[0].event_type,
    "makesafe_work_order_identity_corrected",
  );
});

Deno.test("attach identity refresh records conflict without changing a good key", async () => {
  const existing = "MLB-27001PO-57001";
  const db = refreshClient({
    externalRef: existing,
    metadata: {
      external_ref: existing,
      builder_claim_ref: "MLB-27001",
      builder_work_order_number: existing,
      builder_po_number: "PO-57001",
    },
  });
  const decision = await refreshMakesafeIdentityAfterWorkOrderAttach(
    db.client,
    {
      jobId: "job-1",
      documentId: "document-2",
      fileName: "MLB-27002PO-57002.pdf",
    },
  );
  assertEquals(decision?.action, "conflict");
  assertEquals(db.detail.external_ref, existing);
  assertEquals(db.job.metadata.external_ref, existing);
  assertEquals(
    db.events[0].event_type,
    "makesafe_work_order_identity_conflict",
  );
  assertEquals(db.events[0].detail_json.identity_changed, false);
});

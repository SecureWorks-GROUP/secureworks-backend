// deno-lint-ignore-file no-explicit-any no-import-prefix

import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  excludeInsuranceRepairs,
  insuranceRepairStage,
  isInsuranceRepairFamily,
  loadInsuranceRepairJobIds,
  projectInsuranceRepairPipelineRow,
} from "./insurance_repairs_board.ts";

Deno.test("repair authority accepts only the reviewed family anchors", () => {
  assertEquals(
    isInsuranceRepairFamily({ metadata: { makesafe_job_family: "repair" } }),
    true,
  );
  assertEquals(
    isInsuranceRepairFamily({ metadata: { ses_family: "REPAIR" } }),
    true,
  );
  assertEquals(
    isInsuranceRepairFamily({
      metadata: { makesafe_job_family: "general_makesafe" },
      makesafe_details: { report_type: "repair" },
    }),
    true,
  );
  assertEquals(
    isInsuranceRepairFamily({
      metadata: { makesafe_job_family: "general_makesafe" },
      notes: "Rapid repair appears only in prose",
    }),
    false,
  );
});

Deno.test("Midland 261029 leaves MakeSafe and lands On Site in Repairs", () => {
  const midland = {
    id: "0993f001-9e5e-420f-afdd-1cd1415084a1",
    job_number: "SWMS-261029",
    type: "makesafe",
    status: "processing",
    canonical_stage: "report_ready",
    metadata: {
      makesafe_job_family: "repair",
      // Live SWMS-261029 vintage: builder_work_order_number fuses WO+PO while
      // external_ref carries the bare builder reference. The card must show the
      // bare reference, never the fused string.
      external_ref: "MLB-25147",
      builder_work_order_number: "MLB-25147PO-56236",
      builder_po_number: "PO-56236",
      builder_claim_ref: "MLB-25147",
      requesting_company: { slug: "mlb", name: "ML Builders" },
    },
  };
  const makesafe = {
    id: "physical-1",
    job_number: "SWMS-261179",
    type: "makesafe",
    status: "processing",
    canonical_stage: "report_ready",
    ses_family: "physical_makesafe",
  };

  assertEquals(excludeInsuranceRepairs([midland, makesafe]), [makesafe]);
  const repair = projectInsuranceRepairPipelineRow(midland);
  assertEquals(repair.type, "repair");
  assertEquals(repair.ses_family, "repair");
  assertEquals(repair.repair_stage, "on_site");
  assertEquals(repair.source_type, "makesafe");
  assertEquals("metadata" in repair, false);
  assertEquals(repair.builder_work_order_ref, "MLB-25147");
  assertEquals(repair.builder_po_number, "PO-56236");
  assertEquals(repair.builder_company_name, "ML Builders");
  assertEquals(repair.builder_company_slug, "mlb");
});

Deno.test("repair card ref fields fall back and fail to null, never fabricate", () => {
  // SWMS-261192 vintage: only external_ref is stamped.
  const bareRef = projectInsuranceRepairPipelineRow({
    id: "bare",
    type: "makesafe",
    status: "processing",
    metadata: { makesafe_job_family: "repair", external_ref: "MLB-27249" },
  });
  assertEquals(bareRef.builder_work_order_ref, "MLB-27249");
  assertEquals(bareRef.builder_po_number, null);
  assertEquals(bareRef.builder_company_name, null);

  // Pingelly-shaped mint: no external_ref, WO/PO stamped separately.
  const pingelly = projectInsuranceRepairPipelineRow({
    id: "pingelly",
    type: "repair",
    status: "accepted",
    metadata: {
      makesafe_job_family: "repair",
      repair_stage: "wo_in",
      builder_work_order_number: "MLB-24645",
      builder_po_number: "PO-59875",
      requesting_company: { slug: "mlb", name: "ML Builders" },
    },
  });
  assertEquals(pingelly.builder_work_order_ref, "MLB-24645");
  assertEquals(pingelly.builder_po_number, "PO-59875");
  assertEquals(pingelly.builder_company_name, "ML Builders");
  assertEquals(pingelly.repair_stage, "wo_in");

  // No metadata at all: every ref field projects null, nothing throws.
  const noMeta = projectInsuranceRepairPipelineRow({
    id: "no-meta",
    type: "repair",
    status: "processing",
  });
  assertEquals(noMeta.builder_work_order_ref, null);
  assertEquals(noMeta.builder_po_number, null);
  assertEquals(noMeta.builder_company_name, null);
  assertEquals(noMeta.builder_company_slug, null);
});

Deno.test("explicit Repairs stage wins and lawful job statuses cover all nine lanes", () => {
  assertEquals(
    insuranceRepairStage({
      status: "processing",
      metadata: { repair_stage: "variation" },
    }),
    "variation",
  );
  assertEquals(insuranceRepairStage({ status: "draft" }), "wo_in");
  assertEquals(insuranceRepairStage({ status: "scoping" }), "scoping");
  assertEquals(insuranceRepairStage({ status: "quoted" }), "quoted");
  assertEquals(insuranceRepairStage({ status: "accepted" }), "approved");
  assertEquals(
    insuranceRepairStage({ status: "order_materials" }),
    "materials",
  );
  assertEquals(insuranceRepairStage({ status: "scheduled" }), "scheduled");
  assertEquals(insuranceRepairStage({ status: "processing" }), "on_site");
  assertEquals(insuranceRepairStage({ status: "invoiced" }), "complete");
});

function repairIdClient(options: { failFamilyRead?: boolean } = {}) {
  const calls: Array<{ table: string; filters: Array<[string, string]> }> = [];
  return {
    calls,
    from(table: string) {
      const filters: Array<[string, string]> = [];
      calls.push({ table, filters });
      const query: any = {
        select() {
          return query;
        },
        eq(column: string, value: string) {
          filters.push([column, value]);
          return query;
        },
        then(resolve: (value: any) => unknown) {
          const last = filters.at(-1);
          if (
            options.failFamilyRead &&
            last?.[0] === "metadata->>makesafe_job_family"
          ) {
            return Promise.resolve(resolve({
              data: null,
              error: { message: "column drift" },
            }));
          }
          const data = table === "makesafe_job_details"
            ? [{ job_id: "detail-repair" }]
            : last?.[0] === "type"
            ? []
            : last?.[0] === "metadata->>makesafe_job_family"
            ? [{ id: "family-repair" }]
            : [{ id: "detail-repair" }];
          return Promise.resolve(resolve({ data, error: null }));
        },
      };
      return query;
    },
  };
}

Deno.test("repair id discovery unions every authority without duplicates", async () => {
  const client = repairIdClient();
  assertEquals(
    await loadInsuranceRepairJobIds(client, "org-1"),
    ["family-repair", "detail-repair"],
  );
  assertEquals(client.calls.length, 4);
});

Deno.test("repair id discovery fails loud instead of painting a false empty board", async () => {
  await assertRejects(
    () =>
      loadInsuranceRepairJobIds(
        repairIdClient({ failFamilyRead: true }),
        "org-1",
      ),
    Error,
    "insurance repairs authority read failed",
  );
});

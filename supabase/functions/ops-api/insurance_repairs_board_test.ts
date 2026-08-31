// deno-lint-ignore-file no-explicit-any no-import-prefix

import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  excludeInsuranceRepairs,
  insuranceRepairStage,
  isInsuranceRepairFamily,
  loadInsuranceRepairJobDetails,
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

Deno.test("a fused WO+PO value never reaches the work-order slot", () => {
  // The fused vintage stamped with NO external_ref: the preference alone does
  // not defend the slot, the split does. Both numbers still land, separately.
  const fusedOnly = projectInsuranceRepairPipelineRow({
    id: "fused-only",
    type: "makesafe",
    status: "processing",
    metadata: {
      makesafe_job_family: "repair",
      builder_work_order_number: "MLB-25147PO-56236",
    },
  });
  assertEquals(fusedOnly.builder_work_order_ref, "MLB-25147");
  assertEquals(fusedOnly.builder_po_number, "PO-56236");

  // SWMS-261118 vintage: external_ref itself carries the fused form.
  const fusedExternal = projectInsuranceRepairPipelineRow({
    id: "fused-external",
    type: "repair",
    status: "processing",
    metadata: {
      makesafe_job_family: "repair",
      external_ref: "MLB-26344PO-57087",
    },
  });
  assertEquals(fusedExternal.builder_work_order_ref, "MLB-26344");
  assertEquals(fusedExternal.builder_po_number, "PO-57087");

  // A stored PO always outranks one read back out of a fused string.
  const stamped = projectInsuranceRepairPipelineRow({
    id: "stamped-po",
    type: "repair",
    status: "processing",
    metadata: {
      makesafe_job_family: "repair",
      builder_work_order_number: "MLB-25147PO-56236",
      builder_po_number: "PO-99999",
    },
  });
  assertEquals(stamped.builder_work_order_ref, "MLB-25147");
  assertEquals(stamped.builder_po_number, "PO-99999");
});

Deno.test("a PO is never paired with a work order from another claim", () => {
  // external_ref names MLB-27249; the fused builder_work_order_number names a
  // DIFFERENT claim (MLB-25147). Its PO belongs to that other job, so the card
  // shows the reference it chose and no purchase order at all.
  const contradictory = projectInsuranceRepairPipelineRow({
    id: "contradictory",
    type: "repair",
    status: "processing",
    metadata: {
      makesafe_job_family: "repair",
      external_ref: "MLB-27249",
      builder_work_order_number: "MLB-25147PO-56236",
    },
  });
  assertEquals(contradictory.builder_work_order_ref, "MLB-27249");
  assertEquals(contradictory.builder_po_number, null);

  // Same shape, but the card carries its OWN stored PO key: that one is the
  // card's own purchase order and is trusted independently.
  const ownPo = projectInsuranceRepairPipelineRow({
    id: "own-po",
    type: "repair",
    status: "processing",
    metadata: {
      makesafe_job_family: "repair",
      external_ref: "MLB-27249",
      builder_work_order_number: "MLB-25147PO-56236",
      builder_po_number: "PO-60002",
    },
  });
  assertEquals(ownPo.builder_work_order_ref, "MLB-27249");
  assertEquals(ownPo.builder_po_number, "PO-60002");

  // A metadata external_ref that is not a builder reference at all still wins
  // the slot, and the fused fallback's PO stays off the card.
  const opaque = projectInsuranceRepairPipelineRow({
    id: "opaque",
    type: "repair",
    status: "processing",
    metadata: {
      makesafe_job_family: "repair",
      external_ref: "JOB REF 8891",
      builder_claim_ref: "MLB-25147PO-56236",
    },
  });
  assertEquals(opaque.builder_work_order_ref, "JOB REF 8891");
  assertEquals(opaque.builder_po_number, null);
});

Deno.test("makesafe_job_details supplies ref and company when metadata is empty", () => {
  // Legacy card admitted by makesafe_job_details.report_type='repair' with no
  // jobs.metadata at all: the detail row is the only identity it has.
  const detailOnly = projectInsuranceRepairPipelineRow({
    id: "detail-only",
    type: "makesafe",
    status: "processing",
  }, {
    job_id: "detail-only",
    external_ref: "MLB-24645PO-59875",
    requesting_company_name: "ML Builders",
    requesting_company_slug: "mlb",
  });
  assertEquals(detailOnly.builder_work_order_ref, "MLB-24645");
  assertEquals(detailOnly.builder_po_number, "PO-59875");
  assertEquals(detailOnly.builder_company_name, "ML Builders");
  assertEquals(detailOnly.builder_company_slug, "mlb");

  // Company falls through the joined makesafe_companies row, mirroring the
  // make-safe board's detail-first resolution.
  const joined = projectInsuranceRepairPipelineRow({
    id: "joined",
    type: "repair",
    status: "processing",
    metadata: { makesafe_job_family: "repair" },
  }, {
    job_id: "joined",
    makesafe_companies: { slug: "ajs", name: "AJS Build" },
  });
  assertEquals(joined.builder_company_name, "AJS Build");
  assertEquals(joined.builder_company_slug, "ajs");
  assertEquals(joined.builder_work_order_ref, null);

  // Metadata still wins for the reference when it is populated.
  const both = projectInsuranceRepairPipelineRow({
    id: "both",
    type: "repair",
    status: "processing",
    metadata: {
      makesafe_job_family: "repair",
      external_ref: "MLB-27249",
      builder_po_number: "PO-60001",
    },
  }, {
    job_id: "both",
    external_ref: "MLB-00000",
    requesting_company_name: "ML Builders",
  });
  assertEquals(both.builder_work_order_ref, "MLB-27249");
  assertEquals(both.builder_po_number, "PO-60001");
});

Deno.test("non-scalar stored refs project null rather than [object Object]", () => {
  const junk = projectInsuranceRepairPipelineRow({
    id: "junk",
    type: "repair",
    status: "processing",
    metadata: {
      makesafe_job_family: "repair",
      external_ref: { value: "MLB-24645" },
      builder_work_order_number: ["MLB-24645"],
      builder_po_number: { value: "PO-59875" },
      requesting_company: { name: { first: "ML" }, slug: 7 },
    },
  });
  assertEquals(junk.builder_work_order_ref, null);
  assertEquals(junk.builder_po_number, null);
  assertEquals(junk.builder_company_name, null);
  assertEquals(junk.builder_company_slug, "7");
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

function repairDetailClient(
  options: { fail?: boolean; failChunkIndex?: number } = {},
) {
  const chunks: string[][] = [];
  return {
    chunks,
    from(_table: string) {
      const query: any = {
        select() {
          return query;
        },
        in(_column: string, values: string[]) {
          chunks.push(values);
          return query;
        },
        then(resolve: (value: any) => unknown) {
          if (
            options.fail || options.failChunkIndex === chunks.length - 1
          ) {
            return Promise.resolve(resolve({
              data: null,
              error: { message: "column drift" },
            }));
          }
          return Promise.resolve(resolve({
            data: chunks.at(-1)!.map((id) => ({
              job_id: id,
              external_ref: `MLB-${id}`,
              requesting_company_name: "ML Builders",
            })),
            error: null,
          }));
        },
      };
      return query;
    },
  };
}

Deno.test("repair detail read is de-duplicated, chunked and keyed by job id", async () => {
  const client = repairDetailClient();
  const ids = Array.from({ length: 51 }, (_, i) => `job-${i}`);
  const details = await loadInsuranceRepairJobDetails(
    client,
    [...ids, ids[0], "", ids[1]],
  );

  assertEquals(details.size, 51);
  assertEquals(details.get("job-0")?.external_ref, "MLB-job-0");
  assertEquals(client.chunks.map((chunk) => chunk.length), [50, 1]);
  assertEquals(client.chunks.flat().includes(""), false);
});

Deno.test("repair detail read degrades instead of taking the Repairs tab down", async () => {
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const details = await loadInsuranceRepairJobDetails(
      repairDetailClient({ fail: true }),
      ["a", "b"],
    );
    assertEquals(details.size, 0);
  } finally {
    console.error = original;
  }
  assertEquals(errors.length, 1);
  assertEquals(
    String(errors[0][0]).includes("insurance repairs detail read failed"),
    true,
  );

  // A card whose metadata IS populated is unaffected by the failed read: the
  // projection still serves both instruction numbers off jobs.metadata.
  const card = projectInsuranceRepairPipelineRow({
    id: "a",
    type: "repair",
    status: "processing",
    metadata: {
      makesafe_job_family: "repair",
      external_ref: "MLB-24645",
      builder_po_number: "PO-59875",
      requesting_company: { slug: "mlb", name: "ML Builders" },
    },
  }, undefined);
  assertEquals(card.builder_work_order_ref, "MLB-24645");
  assertEquals(card.builder_po_number, "PO-59875");
  assertEquals(card.builder_company_name, "ML Builders");
});

Deno.test("repair detail read keeps the chunks that did succeed", async () => {
  const client = repairDetailClient({ failChunkIndex: 0 });
  const original = console.error;
  console.error = () => {};
  let details: Map<string, any>;
  try {
    details = await loadInsuranceRepairJobDetails(
      client,
      Array.from({ length: 51 }, (_, i) => `job-${i}`),
    );
  } finally {
    console.error = original;
  }
  assertEquals(details.size, 1);
  assertEquals(details.get("job-50")?.external_ref, "MLB-job-50");
});

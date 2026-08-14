// deno-lint-ignore-file no-import-prefix require-await
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SesAssemblerInputV1 } from "./ses_docket_envelope.ts";
import {
  generateAttachMakesafeSwms,
  normalizeSesSwmsAttachRequest,
  type SesSwmsAttachDependencies,
  SesSwmsAttachError,
} from "./ses_swms_attach_action.ts";
import {
  SES_SWMS_GENERATION_PLAN_VERSION,
  SES_SWMS_TEMPLATE_VERSION,
  type SesSwmsGenerationPlan,
} from "./ses_swms_template.ts";

function input(
  builder: "MLB" | "AJS" = "MLB",
  family: "physical_makesafe" | "ordinary_roof_portal" = "physical_makesafe",
  hrcw = false,
): SesAssemblerInputV1 {
  const reportOnly = family === "ordinary_roof_portal";
  return {
    identity: {
      job_id: "job-1",
      job_number: "SWMS-261190",
    },
    attendance: {
      current_attendance_cycle_id: "cycle-1",
    },
    classification: {
      builder_key: builder,
      family,
      report_only: reportOnly,
      report_delivery: reportOnly ? "portal" : null,
      subtype: null,
      strata: false,
      own_template_requested: false,
    },
    source: { site_suburb: "Noranda" },
    hrcw: {
      hrcw,
      categories: hrcw ? ["work_at_height"] : [],
      source_hazard_terms: [],
    },
  } as unknown as SesAssemblerInputV1;
}

const plan = {
  contract_version: SES_SWMS_GENERATION_PLAN_VERSION,
  template_version: SES_SWMS_TEMPLATE_VERSION,
  template: { kind: "general_makesafe" },
  output_file_name: "SWMS - MLB-1 - Noranda.pdf",
  provenance: { attendance_cycle_id: "cycle-1" },
} as unknown as SesSwmsGenerationPlan;

function dependencies(
  live = input(),
  calls: string[] = [],
): SesSwmsAttachDependencies {
  return {
    resolveInput: async () => live,
    planSwms: () => ({ ok: true, plan }),
    renderSwms: async () => ({
      file_name: plan.output_file_name,
      media_type: "application/pdf",
      bytes: new Uint8Array([37, 80, 68, 70]),
      render_hash: "render-1",
      provenance: { exact: true },
    }),
    attachDocument: async (body, trusted) => {
      calls.push("attach");
      assertEquals(body.type, "swms");
      assertEquals(body.job_id, "job-1");
      assertEquals(body.visible_to_trades, true);
      assertEquals(atob(String(body.pdf_base64)), "%PDF");
      assertEquals(trusted.attendance_cycle_id, "cycle-1");
      assertEquals(trusted.cycle_attribution, "bound");
      assertEquals(
        trusted.data_snapshot_json.source,
        "ops-api:generate_attach_makesafe_swms",
      );
      return { document_id: "doc-swms" };
    },
    ensurePack: async () => {
      calls.push("ensure-pack");
    },
    bindPackSwms: async (_jobId, _packKind, documentId) => {
      calls.push("bind-pack");
      assertEquals(documentId, "doc-swms");
    },
    readBack: async () => {
      calls.push("read-back");
      return {
        document_id: "doc-swms",
        document_type: "swms",
        attendance_cycle_id: "cycle-1",
        cycle_attribution: "bound",
        pack_swms_doc_id: "doc-swms",
        pack_status: "drafted",
      };
    },
    actor: "skill-test",
  };
}

Deno.test("normalizer accepts one exact card selector and rejects batches", async () => {
  assertEquals(
    normalizeSesSwmsAttachRequest({
      selection: { mode: "job_number", job_number: "SWMS-261190" },
    }),
    { selection: { mode: "job_number", job_number: "SWMS-261190" } },
  );
  await assertRejects(
    async () =>
      normalizeSesSwmsAttachRequest({
        selection: { mode: "board_batch", limit: 3 },
      }),
    SesSwmsAttachError,
    "exactly one",
  );
});

Deno.test("MLB physical generates, attaches current-cycle SWMS, then binds and reads back the main pack", async () => {
  const calls: string[] = [];
  const result = await generateAttachMakesafeSwms(
    { selection: { mode: "job_number", job_number: "SWMS-261190" } },
    dependencies(input("MLB", "physical_makesafe"), calls),
  );
  assertEquals(calls, ["attach", "ensure-pack", "bind-pack", "read-back"]);
  assertEquals(result.document_id, "doc-swms");
  assertEquals(result.pack_swms_doc_id, "doc-swms");
  assertEquals(result.pack_kind, "main");
  assertEquals(result.pack_status, "drafted");
  assertEquals(result.no_send, true);
  assertEquals(result.invoice_writes, false);
  assertEquals(result.notifications_sent, false);
  assertEquals(result.board_stage_changed, false);
});

Deno.test("AJS physical and MLB roof both generate the included scope-correct SWMS", async () => {
  for (
    const live of [
      input("AJS", "physical_makesafe"),
      input("MLB", "ordinary_roof_portal"),
    ]
  ) {
    const calls: string[] = [];
    const result = await generateAttachMakesafeSwms(
      { selection: { mode: "job_number", job_number: "SWMS-1" } },
      dependencies(live, calls),
    );
    assertEquals(result.document_id, "doc-swms");
    assertEquals(calls, ["attach", "ensure-pack", "bind-pack", "read-back"]);
  }
});

Deno.test("AJS physical HRCW uses the same generated SWMS path", async () => {
  const calls: string[] = [];
  await generateAttachMakesafeSwms(
    { selection: { mode: "job_number", job_number: "AJBR-1" } },
    dependencies(input("AJS", "physical_makesafe", true), calls),
  );
  assert(calls.includes("attach"));
});

Deno.test("typed planner blocker prevents every attachment and pack write", async () => {
  const calls: string[] = [];
  const deps = dependencies(input(), calls);
  deps.planSwms = () => ({
    ok: false,
    reason_code: "swms_generation_facts_missing",
    reason: "crew is missing",
    recovery_action: "recover crew",
    facts: { missing_facts: ["crew"] },
  });
  const error = await assertRejects(
    () =>
      generateAttachMakesafeSwms(
        { selection: { mode: "job_number", job_number: "SWMS-261190" } },
        deps,
      ),
    SesSwmsAttachError,
    "crew is missing",
  );
  assertEquals(error.code, "swms_generation_facts_missing");
  assertEquals(calls, []);
});

Deno.test("read-back mismatch fails instead of claiming the pack is aligned", async () => {
  const calls: string[] = [];
  const deps = dependencies(input(), calls);
  deps.readBack = async () => ({
    document_id: "doc-swms",
    document_type: "swms",
    attendance_cycle_id: "cycle-1",
    cycle_attribution: "bound",
    pack_swms_doc_id: null,
    pack_status: "drafted",
  });
  const error = await assertRejects(
    () =>
      generateAttachMakesafeSwms(
        { selection: { mode: "job_number", job_number: "SWMS-261190" } },
        deps,
      ),
    SesSwmsAttachError,
    "both the current-cycle document and main pack paths",
  );
  assertEquals(error.code, "swms_attachment_readback_failed");
});

Deno.test("HTTP route is routine-visible, deploy-declared, and structurally excludes outbound and invoice paths", async () => {
  const indexSource = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  const manifest = await Deno.readTextFile(
    new URL("../../../scripts/_ops-api-required-actions.txt", import.meta.url),
  );
  assertStringIncludes(indexSource, "'generate_attach_makesafe_swms'");
  assertStringIncludes(
    manifest,
    "generate_attach_makesafe_swms # probe=source-only",
  );
  const route = indexSource.slice(
    indexSource.indexOf("case 'generate_attach_makesafe_swms':"),
    indexSource.indexOf("case 'bind_current_cycle_curated_makesafe_report':"),
  );
  assertStringIncludes(route, "attachMakesafeDocument");
  assertStringIncludes(route, "_patchPackStrict");
  for (
    const forbidden of [
      "notifySesDocsReadySms",
      "sendSmsViaGhl",
      "makesafe_send_pack",
      "_createDraftInvoice",
      "create_ses_invoice_draft",
      "updateMakesafeSubstatus",
      "_markReady",
    ]
  ) {
    assert(!route.includes(forbidden), `route must not reference ${forbidden}`);
  }
});

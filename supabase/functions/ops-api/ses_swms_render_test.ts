// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SesAssemblerInputV1 } from "./ses_docket_envelope.ts";
import {
  buildSesSwmsGenerationPlan,
  SES_SWMS_TEMPLATE_VERSION,
} from "./ses_swms_template.ts";
import { renderSesSwmsPdf, sesSwmsRenderHash } from "./ses_swms_render.ts";

const FIXED_HASH =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;

function input(
  overrides: {
    report?: Record<string, unknown> | null;
    hrcw?: SesAssemblerInputV1["hrcw"];
    instruction?: string;
  } = {},
): SesAssemblerInputV1 {
  return {
    contract_version: "ses.assembler-input/v1",
    identity: {
      source_instruction_id: "source:mlb-70062",
      source_version: "1",
      source_content_hash: FIXED_HASH,
      lineage_id: "lineage:mlb-70062",
      case_id: "case-70062",
      job_id: "job-70062",
      job_number: "SWMS-270062",
      card_id: "card-70062",
      property_id: "property-70062",
    },
    attendance: {
      attendance_cycle_ids: ["cycle-70062"],
      current_attendance_cycle_id: "cycle-70062",
      cycle_number: 1,
      attribution: "bound",
    },
    classification: {
      builder_key: "MLB",
      builder_label: "ML Builders",
      family: "physical_makesafe",
      subtype: null,
      report_only: false,
      report_delivery: "own_document",
      delivery_render_route: "secureworks_own_letterhead",
      delivery_render_route_reason_code: "fixture",
      delivery_render_route_reason: "fixture",
      delivery_render_route_evidence: ["fixture"],
      strata: false,
      own_template_requested: false,
      workflow: "active",
      lineage_kind: "none",
      family_matrix_version: "fixture",
      assessment_outbound_recipe_version: null,
    },
    source: {
      work_order_sender: "workorders@example.test",
      builder_reference: "WO-70062",
      po_or_external_ref: "PO-70062",
      site_address: "10 Example Street",
      site_suburb: "Wangara WA 6065",
      instruction_text: overrides.instruction ??
        "Install temporary fencing and make the damaged boundary safe.",
      deliverables: [],
      attachment_pointers: ["email:source-70062/attachment:work-order.pdf"],
      portal_links: [],
    },
    cycle_facts: {
      trade_report: overrides.report === undefined
        ? {
          id: "trade-report-70062",
          submitted_at: "2026-07-28T02:30:00.000Z",
          checklist_json: {
            works_completed:
              "Installed temporary fencing and isolated the damaged boundary.",
            attendance_date: "2026-07-28",
            arrival_time: "10:30",
            crew_name: "Field crew",
            site_contact: "Site representative",
          },
        }
        : overrides.report,
      photos: [
        {
          id: "photo-1",
          path_or_key: "jobs/job-70062/photo-1.jpg",
          order: 1,
        },
      ],
      roof_report_fields: null,
      hours_and_materials: null,
      prior_release: {
        released: false,
        release_revision_id: null,
        cycle_set_hash: null,
      },
    },
    operational_evidence: {
      facts: [],
      triage: {
        disposition: "evidence_inconclusive",
        reason_code: "positive_staff_action_evidence_missing",
        staff_action_allowed: false,
        consulted_fact_ids: [],
      },
    },
    hrcw: overrides.hrcw ?? {
      hrcw: false,
      categories: [],
      source_hazard_terms: [],
    },
    routing_seed: {
      report_to: "reports@example.test",
      invoice_to: "invoices@example.test",
    },
    readiness: {
      readiness_revision: null,
      dependency_generation: null,
    },
  };
}

Deno.test("sealed SWMS generation plan selects only the matching standard control set", () => {
  const general = buildSesSwmsGenerationPlan(input());
  assert(general.ok);
  assertEquals(general.plan.template.kind, "general_makesafe");

  const roof = buildSesSwmsGenerationPlan(input({
    instruction: "Roof make-safe and temporary tarp above 2 metres.",
    hrcw: {
      hrcw: true,
      categories: ["work_at_height"],
      source_hazard_terms: ["work at height over 2m"],
    },
  }));
  assert(roof.ok);
  assertEquals(roof.plan.template.kind, "roof_makesafe");

  const hardie = buildSesSwmsGenerationPlan(input({
    instruction: "Make safe damaged Hardie fibre-cement fence.",
    hrcw: {
      hrcw: true,
      categories: ["asbestos"],
      source_hazard_terms: ["suspected asbestos fence"],
    },
  }));
  assert(hardie.ok);
  assertEquals(hardie.plan.template.kind, "hardie_fence");

  const unsupported = buildSesSwmsGenerationPlan(input({
    instruction: "Install temporary load-bearing structural support.",
    hrcw: {
      hrcw: true,
      categories: ["structural"],
      source_hazard_terms: ["temporary load-bearing support"],
    },
  }));
  assertEquals(unsupported.ok, false);
  if (unsupported.ok) throw new Error("structural template must fail closed");
  assertEquals(
    unsupported.reason_code,
    "swms_generation_template_unavailable",
  );

  const unclassifiedHrcw = buildSesSwmsGenerationPlan(input({
    hrcw: {
      hrcw: true,
      categories: [],
      source_hazard_terms: [],
    },
  }));
  assertEquals(unclassifiedHrcw.ok, false);
  if (unclassifiedHrcw.ok) {
    throw new Error("unclassified HRCW must fail closed");
  }
  assertEquals(
    unclassifiedHrcw.reason_code,
    "swms_generation_facts_missing",
  );
});

Deno.test("SWMS generation blocks when any required real fact is absent", () => {
  const blocked = buildSesSwmsGenerationPlan(input({
    report: {
      id: "trade-report-70062",
      checklist_json: {
        works_completed: "Installed temporary fencing.",
      },
    },
  }));
  assertEquals(blocked.ok, false);
  if (blocked.ok) throw new Error("missing SWMS facts must block generation");
  assertEquals(blocked.reason_code, "swms_generation_facts_missing");
  assertEquals(blocked.facts.missing_facts, [
    "works date",
    "arrival time",
    "crew",
    "site contact",
    "trade report submission time",
  ]);
  assert(!blocked.reason.includes("works_date"));
  assert(!blocked.reason.includes("site_contact"));
  assert(!blocked.reason.includes("trade_report_submitted_at"));
});

Deno.test("SWMS renderer emits a stable four-page provenance-bound PDF", async () => {
  const built = buildSesSwmsGenerationPlan(input());
  assert(built.ok);

  const first = await renderSesSwmsPdf(built.plan);
  const second = await renderSesSwmsPdf(built.plan);
  const pdfText = new TextDecoder("latin1").decode(first.bytes);

  assertStringIncludes(pdfText.slice(0, 8), "%PDF-");
  assertEquals(
    [...pdfText.matchAll(/\/Type\s*\/Page\b/g)].length,
    4,
  );
  assert(first.bytes.length > 20_000);
  assertEquals(first.file_name, built.plan.output_file_name);
  assertEquals(first.media_type, "application/pdf");
  assertEquals(first.render_hash, await sesSwmsRenderHash(built.plan));
  assertEquals(first.render_hash, second.render_hash);
  assertEquals(first.bytes, second.bytes);
  assertEquals(
    first.provenance.template_version,
    SES_SWMS_TEMPLATE_VERSION,
  );
  assertEquals(first.provenance.trade_report_id, "trade-report-70062");
  assertEquals(first.provenance.work_order_pointers, [
    "email:source-70062/attachment:work-order.pdf",
  ]);
});

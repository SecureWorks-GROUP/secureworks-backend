// deno-lint-ignore-file no-import-prefix require-await
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import fixture from "./fixtures/ses_u4_swms_26980_live_snapshot.json" with {
  type: "json",
};
import {
  buildSesAssemblerInput,
  normalizeSesPrepareRequest,
  SesAssemblerAdapterError,
  type SesAssemblerLiveSnapshot,
} from "./ses_assembler_input_adapter.ts";
import {
  SES_ASSEMBLER_VERSION,
  SES_INPUT_CONTRACT_VERSION,
} from "./ses_docket_envelope.ts";
import {
  prepare_ses_docket_revision,
  SES_ASSESSMENT_RECIPE_PENDING,
} from "./ses_prepare_docket_revision.ts";

function snapshot(): SesAssemblerLiveSnapshot {
  const {
    captured_from: _capturedFrom,
    ...liveSnapshot
  } = structuredClone(fixture);
  return liveSnapshot as SesAssemblerLiveSnapshot;
}

function sourceResolver(input: ReturnType<typeof buildSesAssemblerInput>) {
  return input.source.attachment_pointers.map((source_pointer) => ({
    source_pointer,
    file_name: "MLB-26567PO-56164-work-order.pdf",
    media_type: "application/pdf",
    bytes: new Uint8Array([37, 80, 68, 70, 1]),
  }));
}

function blockerCodes(result: { blockers: Array<{ reason_code: string }> }) {
  return result.blockers.map((item) => item.reason_code);
}

Deno.test("SWMS-26980 live fixture builds canonical v1 input without inventing U1 spine facts", () => {
  const input = buildSesAssemblerInput(snapshot());
  assertEquals(input.contract_version, SES_INPUT_CONTRACT_VERSION);
  assertEquals(input.identity.job_id, "5383e3c4-eb32-41cf-8e3c-63a754c16d05");
  assertEquals(input.identity.job_number, "SWMS-26980");
  assertEquals(input.identity.source_instruction_id, "");
  assertEquals(input.identity.lineage_id, "");
  assertEquals(input.attendance, {
    attendance_cycle_ids: ["c7f8f100-3120-4534-880b-bd4bb58928fa"],
    current_attendance_cycle_id: "c7f8f100-3120-4534-880b-bd4bb58928fa",
    cycle_number: 1,
    attribution: "bound",
  });
  assertEquals(input.classification.builder_key, "MLB");
  assertEquals(input.classification.family, "ordinary_roof_portal");
  assertEquals(input.source.builder_reference, "");
  assertEquals(input.source.po_or_external_ref, null);
  assertEquals(input.source.deliverables, []);
  assertEquals(input.source.portal_links, [{
    role: "roof_report",
    url: "https://primeeco.tech/share/2ef11c67-8f63-48cb-9ff4-61bf71848f17",
    source: "job_detail",
  }]);
  assertEquals(input.source.attachment_pointers, [
    "job_document:205d0d18-a40f-4617-9e41-0fa0934a112b",
  ]);
});

Deno.test("public U4 request defaults sealed versions but requires explicit dry-run and one selector", () => {
  assertEquals(
    normalizeSesPrepareRequest({
      selection: { mode: "job_number", job_number: "SWMS-26980" },
      idempotency_key: "proof-swms-26980-20260727",
      dry_run: true,
    }),
    {
      selection: { mode: "job_number", job_number: "SWMS-26980" },
      idempotency_key: "proof-swms-26980-20260727",
      assembler_version: SES_ASSEMBLER_VERSION,
      dry_run: true,
      force_refresh: false,
    },
  );
  for (
    const invalid of [
      {
        selection: { mode: "job_number", job_number: "SWMS-26980" },
        idempotency_key: "key",
      },
      {
        selection: {
          mode: "job_number",
          job_number: "SWMS-26980",
          job_id: "also-present",
        },
        idempotency_key: "key",
        dry_run: true,
      },
    ]
  ) {
    try {
      normalizeSesPrepareRequest(invalid);
      throw new Error("expected request rejection");
    } catch (error) {
      assert(error instanceof SesAssemblerAdapterError);
      assertEquals(error.status, 400);
    }
  }
});

Deno.test("SWMS-26980 production-shape dry-run is HTTP-envelope ready, write-free and specifically blocked", async () => {
  const input = buildSesAssemblerInput(snapshot());
  let persistCalls = 0;
  const response = await prepare_ses_docket_revision({
    selection: {
      mode: "job_id",
      job_id: "5383e3c4-eb32-41cf-8e3c-63a754c16d05",
    },
    idempotency_key: "proof-swms-26980-20260727",
    assembler_version: SES_ASSEMBLER_VERSION,
    dry_run: true,
    force_refresh: true,
  }, {
    resolveInput: async () => input,
    resolveSourceArtifacts: async () => sourceResolver(input),
    persist: async () => {
      persistCalls++;
      return { committed_at: "2026-07-27T08:00:00.000Z" };
    },
    now: () => new Date("2026-07-27T08:00:00.000Z"),
  });
  assertEquals(response.action, "prepare_ses_docket_revision");
  assertEquals(response.dry_run, true);
  assertEquals(response.results.length, 1);
  const result = response.results[0];
  assertEquals(result.state, "blocked");
  assertEquals(result.persisted, false);
  assertEquals(persistCalls, 0);
  const codes = blockerCodes(result);
  assert(codes.includes("spine_missing_source"));
  assert(codes.includes("spine_missing_lineage"));
  assert(codes.includes("capability_portal_degraded"));
  assert(codes.includes("pricing_evidence_missing"));
  assert(!codes.includes("recovery-not-run"));
});

Deno.test("live adapter applies the Captain AJS physical-makesafe rule before report wording", () => {
  const live = snapshot();
  live.detail!.requesting_company_slug = "aj";
  live.detail!.requesting_company_name = "AJS";
  live.detail!.report_type = "roof_report";
  live.job.metadata.requesting_company = { slug: "aj", name: "AJS" };
  live.job.metadata.job_family = "roof_report";
  const input = buildSesAssemblerInput(live);
  assertEquals(input.classification.builder_key, "AJS");
  assertEquals(input.classification.family, "physical_makesafe");
  assertEquals(input.classification.report_only, false);
});

Deno.test("live adapter leaves an unclassified non-AJS card explicitly unknown", () => {
  const live = snapshot();
  live.detail!.requesting_company_slug = "unsealed-builder";
  live.detail!.requesting_company_name = "Unsealed Builder";
  live.detail!.report_type = null;
  live.job.metadata = {};
  const input = buildSesAssemblerInput(live);
  assertEquals(input.classification.family, "unknown");
  assertEquals(input.source.builder_reference, "");
  assertEquals(input.source.deliverables, []);
});

Deno.test("live adapter keeps assessment family held on the named Captain recipe blocker", async () => {
  const live = snapshot();
  live.job.metadata.job_family = "assessment";
  live.detail!.report_type = "assessment_report_quote";
  live.detail!.external_links = [
    { kind: "assessment_report", url: "https://portal.example.test/report" },
    { kind: "photos", url: "https://portal.example.test/photos" },
    { kind: "scope", url: "https://portal.example.test/scope" },
  ];
  const input = buildSesAssemblerInput(live);
  assertEquals(
    input.classification.assessment_outbound_recipe_version,
    SES_ASSESSMENT_RECIPE_PENDING,
  );
  const response = await prepare_ses_docket_revision({
    selection: { mode: "job_id", job_id: input.identity.job_id },
    idempotency_key: "assessment-held-fixture",
    assembler_version: SES_ASSEMBLER_VERSION,
    dry_run: true,
    force_refresh: true,
  }, {
    resolveInput: async () => input,
    resolveSourceArtifacts: async () => sourceResolver(input),
    now: () => new Date("2026-07-27T08:00:00.000Z"),
  });
  assert(
    blockerCodes(response.results[0]).includes(
      "assessment_recipe_unapproved",
    ),
  );
});

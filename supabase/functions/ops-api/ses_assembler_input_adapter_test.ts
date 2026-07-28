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
  createSesAssemblerRuntimeDependencies,
  normalizeSesPrepareRequest,
  physicalReportRenderJob,
  SesAssemblerAdapterError,
  type SesAssemblerLiveSnapshot,
  summarizeSesPrepareResponseForHttp,
} from "./ses_assembler_input_adapter.ts";
import {
  SES_ASSEMBLER_VERSION,
  SES_INPUT_CONTRACT_VERSION,
} from "./ses_docket_envelope.ts";
import {
  prepare_ses_docket_revision,
  SES_ASSESSMENT_RECIPE_VERSION,
} from "./ses_prepare_docket_revision.ts";

function snapshot(): SesAssemblerLiveSnapshot {
  const { captured_from: _capturedFrom, ...liveSnapshot } = structuredClone(
    fixture,
  );
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

function liveSnapshotClient(live: SesAssemblerLiveSnapshot) {
  const rows: Record<string, unknown> = {
    jobs: [live.job],
    makesafe_job_details: [live.detail],
    makesafe_intake_cases: live.cases,
    makesafe_attendance_cycles: live.cycles,
    job_service_reports: live.reports,
    job_assignments: live.assignments,
    job_media: live.media,
    job_documents: live.documents,
    makesafe_roof_report_drafts: live.roof_draft ? [live.roof_draft] : [],
    makesafe_readiness_current: live.readiness ? [live.readiness] : [],
    makesafe_report_packs: live.legacy_packs,
  };
  return {
    from(table: string) {
      let single = false;
      const query = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        neq() {
          return query;
        },
        order() {
          return query;
        },
        limit() {
          return query;
        },
        maybeSingle() {
          single = true;
          return query;
        },
        then(
          resolve: (value: { data: unknown; error: null }) => unknown,
        ) {
          const data = rows[table] ?? [];
          return Promise.resolve({
            data: single && Array.isArray(data) && data.length === 1
              ? data[0]
              : single
              ? null
              : data,
            error: null,
          }).then(resolve);
        },
      };
      return query;
    },
  };
}

Deno.test(
  "SWMS-26980 live fixture builds canonical v1 input without inventing U1 spine facts",
  () => {
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
    assertEquals(input.classification.family, "own_template_roof");
    assertEquals(
      input.classification.delivery_render_route,
      "secureworks_own_letterhead",
    );
    assertEquals(
      input.classification.delivery_render_route_reason_code,
      "client_relationship_requires_own_letterhead",
    );
    assertEquals(input.classification.delivery_render_route_evidence, [
      "jobs.client_name#relationship:strata",
    ]);
    assertEquals(input.source.builder_reference, "");
    assertEquals(input.source.po_or_external_ref, null);
    assertEquals(input.source.deliverables, []);
    assertEquals(input.source.portal_links, [
      {
        role: "assessment",
        url: "https://primeeco.tech/share/2ef11c67-8f63-48cb-9ff4-61bf71848f17",
        source: "job_detail",
      },
    ]);
    assertEquals(input.source.attachment_pointers, [
      "job_document:205d0d18-a40f-4617-9e41-0fa0934a112b",
    ]);
  },
);

Deno.test(
  "public U4 request defaults sealed versions but requires explicit dry-run and one selector",
  () => {
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
  },
);

Deno.test(
  "SWMS-26980 production-shape dry-run is HTTP-envelope ready, write-free and specifically blocked",
  async () => {
    const input = buildSesAssemblerInput(snapshot());
    let persistCalls = 0;
    const response = await prepare_ses_docket_revision(
      {
        selection: {
          mode: "job_id",
          job_id: "5383e3c4-eb32-41cf-8e3c-63a754c16d05",
        },
        idempotency_key: "proof-swms-26980-20260727",
        assembler_version: SES_ASSEMBLER_VERSION,
        dry_run: true,
        force_refresh: true,
      },
      {
        resolveInput: async () => input,
        resolveSourceArtifacts: async () => sourceResolver(input),
        persist: async () => {
          persistCalls++;
          return { committed_at: "2026-07-27T08:00:00.000Z" };
        },
        now: () => new Date("2026-07-27T08:00:00.000Z"),
      },
    );
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
    assert(codes.includes("trade_evidence_missing"));
    assert(!codes.includes("family_unknown"));
    assert(!codes.includes("delivery_route_unroutable"));
    assert(!codes.some((code) => code.startsWith("portal_")));
    assert(!codes.includes("capability_portal_degraded"));
    assertEquals(
      result.envelope.v2.classification.delivery_render_route,
      "secureworks_own_letterhead",
    );
    assertEquals(
      result.envelope.v2.classification.delivery_render_route_reason_code,
      "client_relationship_requires_own_letterhead",
    );
    assert(!codes.includes("recovery-not-run"));
  },
);

Deno.test(
  "live adapter maps the canonical board family without an AJS physical shortcut",
  () => {
    const live = snapshot();
    live.detail!.requesting_company_slug = "aj";
    live.detail!.requesting_company_name = "AJS";
    live.detail!.report_type = null;
    live.job.metadata.requesting_company = { slug: "aj", name: "AJS" };
    live.job.metadata.makesafe_job_family = "temp_fence_makesafe";
    const input = buildSesAssemblerInput(live);
    assertEquals(input.classification.builder_key, "AJS");
    assertEquals(input.classification.family, "temporary_fencing");
    assertEquals(input.classification.report_only, false);
  },
);

Deno.test(
  "live adapter consumes the trade checklist keys written by submit_makesafe_report",
  () => {
    const live = snapshot();
    live.job.client_name = "The Owners of Tranby Villas";
    live.job.site_address = "U24/28 Peninsula Road";
    live.job.site_suburb = "Maylands";
    live.job.metadata.makesafe_job_family = "general_makesafe";
    live.detail!.report_type = null;
    live.detail!.external_links = [];
    live.reports[0].submitted_at = "2026-07-22T04:00:00.000Z";
    live.reports[0].notes = "Trade completion note";
    live.reports[0].checklist_json = {
      arrival_time: "2026-07-20 14:09",
      damage_description:
        "Unsecured bricks on the patio roof and broken plastic sheeting.",
      damage_cause: "Storm / wind",
      work_done:
        "Removed unsecured broken sheeting and screws, then moved the bricks to ground.",
      materials: [],
      materials_used: ["Tarps / roof materials", "Fixings / consumables"],
      labour_hours: 2,
      trade_count: 2,
      access_issues: "Gate code did not work on arrival.",
      follow_up_required: true,
      invoice_notes: "Two trades attended for two hours each.",
    };

    const input = buildSesAssemblerInput(live);
    assertEquals(input.cycle_facts.hours_and_materials, {
      trades: 2,
    });
    const renderJob = physicalReportRenderJob(live, input);
    assertEquals(renderJob, {
      ref: "",
      address: "U24/28 Peninsula Road",
      contact: "The Owners of Tranby Villas",
      date: "2026-07-20",
      arrival: "14:09",
      crew: "2 trades",
      billing_note: "Two trades attended for two hours each.",
      scope: "Unsecured bricks on the patio roof and broken plastic sheeting.",
      findings: "Storm / wind",
      works:
        "Removed unsecured broken sheeting and screws, then moved the bricks to ground.",
      materials: "Tarps / roof materials, Fixings / consumables",
      access_issues: "Gate code did not work on arrival.",
      follow_up_required: "Follow-up required.",
      photos: [],
    });
    assertEquals(
      Object.hasOwn(input.cycle_facts.hours_and_materials || {}, "materials"),
      false,
    );
    assertEquals(
      Object.hasOwn(
        input.cycle_facts.hours_and_materials || {},
        "hours_per_trade",
      ),
      false,
    );
    const renderJobWithPhoto = physicalReportRenderJob(live, input, [
      {
        photo_id: input.cycle_facts.photos[0]?.id || "photo-1",
        source_pointer: input.cycle_facts.photos[0]?.path_or_key ||
          "job_media:photo-1",
        file_name: "completion.jpg",
        media_type: "image/jpeg",
        bytes: new Uint8Array([65, 66]),
      },
    ]);
    assertEquals(renderJobWithPhoto.photos, [
      {
        bytesBase64: "QUI=",
        contentType: "image/jpeg",
        caption: undefined,
      },
    ]);

    live.reports[0].checklist_json.invoice_notes = "";
    assertEquals(
      physicalReportRenderJob(live, buildSesAssemblerInput(live)).billing_note,
      "Trade submission recorded 2 labour hours and 2 trades.",
    );
    live.reports[0].checklist_json.access_issues = "";
    live.reports[0].checklist_json.follow_up_required = false;
    const negativeFacts = physicalReportRenderJob(
      live,
      buildSesAssemblerInput(live),
    );
    assertEquals(negativeFacts.access_issues, "No access issues reported.");
    assertEquals(
      negativeFacts.follow_up_required,
      "No further works required.",
    );
    delete live.reports[0].checklist_json.access_issues;
    delete live.reports[0].checklist_json.follow_up_required;
    const unknownFacts = physicalReportRenderJob(
      live,
      buildSesAssemblerInput(live),
    );
    assertEquals(
      unknownFacts.access_issues,
      "Access constraints: not recorded in trade submission.",
    );
    assertEquals(
      unknownFacts.follow_up_required,
      "Follow-up status: not recorded in trade submission.",
    );
  },
);

Deno.test(
  "physical U4 dry-run blocks instead of rendering without a canonical builder reference",
  async () => {
    const live = snapshot();
    live.job.metadata.makesafe_job_family = "general_makesafe";
    live.detail!.report_type = null;
    live.detail!.external_links = [];
    live.reports[0].checklist_json = {
      damage_description: "Patio roof damage",
      work_done: "Removed loose material",
      labour_hours: 2,
      trade_count: 2,
    };
    live.media = [
      {
        id: "30ad0e72-351c-4f2b-8987-e490c9ffb774",
        job_id: live.job.id,
        type: "photo",
        phase: "completion",
        attendance_cycle_id: live.detail!.attendance_cycle_id,
        cycle_attribution: "bound",
      },
    ];
    const input = buildSesAssemblerInput(live);
    let renderCalls = 0;
    const response = await prepare_ses_docket_revision(
      {
        selection: { mode: "job_id", job_id: input.identity.job_id },
        idempotency_key: "physical-missing-reference",
        assembler_version: SES_ASSEMBLER_VERSION,
        dry_run: true,
        force_refresh: true,
      },
      {
        resolveInput: async () => input,
        resolveSourceArtifacts: async () => sourceResolver(input),
        resolvePhotoProofs: async () => [
          {
            photo_id: input.cycle_facts.photos[0].id,
            source_pointer: input.cycle_facts.photos[0].path_or_key,
            file_name: "completion.jpg",
            media_type: "image/jpeg",
            content_hash:
              "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            size_bytes: 3,
          },
        ],
        renderPhysicalReport: async () => {
          renderCalls++;
          throw new Error(
            "must not render without a canonical builder reference",
          );
        },
        resolveSwmsArtifact: async () => ({
          file_name: "SWMS.pdf",
          media_type: "application/pdf",
          bytes: new Uint8Array([37, 80, 68, 70]),
        }),
        now: () => new Date("2026-07-27T08:00:00.000Z"),
      },
    );

    assertEquals(response.results[0].state, "blocked");
    assertEquals(renderCalls, 0);
    assert(blockerCodes(response.results[0]).includes("spine_missing_source"));
  },
);

Deno.test(
  "11-photo U4 dry-run stays bounded, lists proof metadata and never resolves or renders binary photos",
  async () => {
    const live = snapshot();
    live.job.metadata.makesafe_job_family = "general_makesafe";
    live.detail!.report_type = null;
    live.detail!.external_links = [];
    live.reports[0].checklist_json = {
      damage_description: "Patio roof damage",
      work_done: "Removed loose material",
      access_issues: "",
      follow_up_required: false,
      labour_hours: 2,
      trade_count: 2,
    };
    const realPhotoSizes = [
      649_349,
      532_950,
      528_799,
      499_275,
      898_197,
      286_155,
      298_089,
      554_457,
      537_395,
      522_251,
      442_430,
    ];
    live.media = realPhotoSizes.map((size, index) => ({
      id: `30ad0e72-351c-4f2b-8987-${String(index).padStart(12, "0")}`,
      job_id: live.job.id,
      type: "photo",
      phase: "completion",
      attendance_cycle_id: live.detail!.attendance_cycle_id,
      cycle_attribution: "bound",
      label: `Completion photo ${index + 1}`,
      size,
      storage_url: `https://storage.example.test/photo-${index + 1}.jpg`,
    }));
    const input = buildSesAssemblerInput(live);
    const client = liveSnapshotClient(live);
    const dependencies = createSesAssemblerRuntimeDependencies(client, {
      org_id: "org-test",
      created_by: "user-test",
    });
    const originalFetch = globalThis.fetch;
    let activeFetches = 0;
    let maxActiveFetches = 0;
    const fetchedSizes: number[] = [];
    const expectedPhotoHashes: string[] = [];
    globalThis.fetch = async () => {
      activeFetches++;
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
      const index = fetchedSizes.length;
      const bytes = new Uint8Array(realPhotoSizes[index]);
      bytes.fill(index + 1);
      fetchedSizes.push(bytes.byteLength);
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", bytes),
      );
      expectedPhotoHashes.push(
        `sha256:${
          Array.from(digest).map((byte) => byte.toString(16).padStart(2, "0"))
            .join("")
        }`,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      activeFetches--;
      return new Response(bytes.buffer, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    };
    let renderCalls = 0;
    try {
      const started = performance.now();
      const response = await prepare_ses_docket_revision(
        {
          selection: { mode: "job_id", job_id: input.identity.job_id },
          idempotency_key: "physical-http-artifact-summary",
          assembler_version: SES_ASSEMBLER_VERSION,
          dry_run: true,
          force_refresh: true,
        },
        {
          ...dependencies,
          resolveSourceArtifacts: async () => sourceResolver(input),
          resolvePhotoArtifacts: async () => {
            throw new Error("dry-run must not resolve retained photo bytes");
          },
          renderPhysicalReport: async () => {
            renderCalls++;
            throw new Error("dry-run must not render the report PDF");
          },
          resolveSwmsArtifact: async () => null,
        },
      );
      const elapsedMs = performance.now() - started;
      const proofs = response.results[0].artifacts.filter((artifact) =>
        artifact.role === "completion_photo_proof"
      );
      assertEquals(fetchedSizes, realPhotoSizes);
      assertEquals(maxActiveFetches, 1);
      assertEquals(renderCalls, 0);
      assertEquals(proofs.length, 11);
      assertEquals(
        proofs.map((proof) => ({
          photo_id: proof.metadata.photo_id,
          caption: proof.metadata.caption,
          content_hash: proof.metadata.content_hash,
          size_bytes: proof.metadata.size_bytes,
        })),
        input.cycle_facts.photos.map((photo, index) => ({
          photo_id: photo.id,
          caption: photo.caption || null,
          content_hash: expectedPhotoHashes[index],
          size_bytes: realPhotoSizes[index],
        })),
      );
      assertEquals(
        response.results[0].artifacts.some((artifact) =>
          artifact.role === "completion_photo" ||
          artifact.role === "supporting_report_pdf"
        ),
        false,
      );
      const httpResponse = summarizeSesPrepareResponseForHttp(response);
      assert(!JSON.stringify(httpResponse).includes('"bytes"'));
      assert(JSON.stringify(httpResponse).length < 100_000);
      assert(
        elapsedMs < 5_000,
        `11-photo dry-run took ${elapsedMs.toFixed(1)}ms`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "live adapter maps every canonical board family token exactly",
  () => {
    for (
      const [signal, expected] of [
        ["general_makesafe", "physical_makesafe"],
        ["temp_fence_makesafe", "temporary_fencing"],
        ["assessment_report_quote", "assessment_quote"],
        ["restoration", "restoration"],
      ] as const
    ) {
      const live = snapshot();
      live.detail!.report_type = null;
      live.job.metadata.makesafe_job_family = signal;
      const input = buildSesAssemblerInput(live);
      assertEquals(input.classification.family, expected, signal);
    }

    const portalRoof = snapshot();
    portalRoof.detail!.report_type = null;
    portalRoof.job.metadata.makesafe_job_family = "roof_report";
    portalRoof.job.client_name = "Ordinary insured";
    const portalInput = buildSesAssemblerInput(portalRoof);
    assertEquals(
      portalInput.classification.family,
      "ordinary_roof_portal",
    );
    assertEquals(
      portalInput.classification.delivery_render_route,
      "builder_portal",
    );
    assertEquals(
      portalInput.classification.delivery_render_route_reason_code,
      "portal_builder_family",
    );

    const ownTemplateRoof = snapshot();
    ownTemplateRoof.detail!.report_type = null;
    ownTemplateRoof.detail!.external_links = [];
    ownTemplateRoof.job.metadata.makesafe_job_family = "roof_report";
    ownTemplateRoof.job.metadata.report_delivery = "own_document";
    assertEquals(
      buildSesAssemblerInput(ownTemplateRoof).classification.family,
      "own_template_roof",
    );
  },
);

Deno.test(
  "unsupported roof builder is typed unroutable before any portal capture",
  async () => {
    const live = snapshot();
    live.job.client_name = "Ordinary insured";
    live.job.metadata = {
      makesafe_job_family: "roof_report",
      requesting_company: {
        slug: "unsealed-builder",
        name: "Unsealed Builder",
      },
    };
    live.detail!.requesting_company_slug = "unsealed-builder";
    live.detail!.requesting_company_name = "Unsealed Builder";
    live.detail!.external_ref = "REF-UNSEALED";
    live.detail!.report_type = null;
    live.detail!.makesafe_companies = {
      slug: "unsealed-builder",
      name: "Unsealed Builder",
      report_recipient: "reports@unsealed-builder.test",
    };
    const input = buildSesAssemblerInput(live);
    assertEquals(input.classification.family, "ordinary_roof_portal");
    assertEquals(input.classification.delivery_render_route, "unroutable");
    assertEquals(
      input.classification.delivery_render_route_reason_code,
      "roof_builder_family_unsealed",
    );

    let captureCalls = 0;
    const result = (await prepare_ses_docket_revision(
      {
        selection: { mode: "job_id", job_id: live.job.id },
        idempotency_key: "unroutable-roof-proof",
        assembler_version: SES_ASSEMBLER_VERSION,
        dry_run: true,
        force_refresh: true,
      },
      {
        resolveInput: async () => input,
        capturePortal: async () => {
          captureCalls++;
          throw new Error("unroutable card must not capture a portal");
        },
        now: () => new Date("2026-07-28T08:00:00.000Z"),
      },
    )).results[0];

    const routeBlocker = result.blockers.find((blocker) =>
      blocker.reason_code === "delivery_route_unroutable"
    );
    assert(routeBlocker);
    assert(routeBlocker.reason.includes("Builder UNKNOWN"));
    assertEquals(
      routeBlocker.facts?.route_reason_code,
      "roof_builder_family_unsealed",
    );
    assertEquals(captureCalls, 0);
  },
);

Deno.test(
  "conflicting persisted roof delivery facts fail closed before route selection",
  () => {
    const live = snapshot();
    live.detail!.report_type = null;
    live.job.metadata.makesafe_job_family = "roof_report";
    live.job.metadata.report_delivery = "own_document";
    live.detail!.report_delivery = "portal";
    const input = buildSesAssemblerInput(live);
    assertEquals(input.classification.delivery_render_route, "unroutable");
    assertEquals(
      input.classification.delivery_render_route_reason_code,
      "conflicting_roof_delivery_facts",
    );
    assertEquals(input.classification.delivery_render_route_evidence, [
      "jobs.metadata.report_delivery=own_document",
      "makesafe_job_details.report_delivery=portal",
    ]);
  },
);

Deno.test(
  "conflicting persisted roof modes fail closed before route selection",
  () => {
    const live = snapshot();
    live.detail!.report_type = null;
    live.job.metadata.makesafe_job_family = "roof_report";
    live.job.metadata.roof_report_mode = "builder_portal";
    live.detail!.roof_report_mode = "own_template";
    const input = buildSesAssemblerInput(live);
    assertEquals(input.classification.delivery_render_route, "unroutable");
    assertEquals(
      input.classification.delivery_render_route_reason_code,
      "conflicting_roof_delivery_facts",
    );
    assertEquals(input.classification.delivery_render_route_evidence, [
      "jobs.metadata.roof_report_mode=builder_portal",
      "makesafe_job_details.roof_report_mode=own_template",
    ]);
  },
);

Deno.test(
  "unsupported persisted report delivery fails closed with field evidence",
  () => {
    const live = snapshot();
    live.detail!.report_type = null;
    live.job.metadata.makesafe_job_family = "roof_report";
    live.job.metadata.report_delivery = "email";
    const input = buildSesAssemblerInput(live);
    assertEquals(input.classification.delivery_render_route, "unroutable");
    assertEquals(
      input.classification.delivery_render_route_reason_code,
      "delivery_route_unroutable",
    );
    assertEquals(input.classification.delivery_render_route_evidence, [
      "jobs.metadata.report_delivery=email",
    ]);
  },
);

Deno.test(
  "own-template roof preserves legacy portal-link role binding",
  () => {
    const live = snapshot();
    live.detail!.report_type = null;
    live.job.metadata.makesafe_job_family = "roof_report";
    live.detail!.external_links = [{
      kind: "photos",
      label: "Prime photos",
      url: "https://primeeco.tech/share/photos",
    }];
    const input = buildSesAssemblerInput(live);
    assertEquals(input.classification.family, "own_template_roof");
    assertEquals(input.source.portal_links, [{
      role: "photos",
      url: "https://primeeco.tech/share/photos",
      source: "job_detail",
    }]);
  },
);

Deno.test("SWMS-26980 seeded authority preserves the identity spine in U4", () => {
  const live = snapshot();
  live.identity_revision = {
    authority_kind: "legacy_job_record",
    source_instruction_id: "legacy-job:5383e3c4-eb32-41cf-8e3c-63a754c16d05",
    source_version: 1,
    source_content_hash: `sha256:${"a".repeat(64)}`,
    lineage_id: "5383e3c4-eb32-41cf-8e3c-63a754c16d05",
    effective_case_id: null,
  };
  const input = buildSesAssemblerInput(live);
  assertEquals(
    input.identity.source_instruction_id,
    live.identity_revision.source_instruction_id,
  );
  assertEquals(input.identity.source_version, "1");
  assertEquals(input.identity.lineage_id, live.identity_revision.lineage_id);
});

Deno.test(
  "real restoration card shape dry-runs to the typed unsealed-recipe blocker",
  async () => {
    const live = snapshot();
    live.job.id = "7dea664a-e0d7-4263-ab0c-bacea9e1d65d";
    live.job.job_number = "SWMS-26936";
    live.job.type = "insurance";
    live.job.status = "accepted";
    live.job.metadata = {
      ...live.job.metadata,
      insurance_job_type: "restoration",
      insurance_job_type_label: "Restoration Insurance Work",
      // The real converted card still carries this stale compatibility token.
      // Insurance restoration authority must win.
      makesafe_job_family: "general_makesafe",
      external_ref: "MLB-MW-26873",
    };
    live.detail!.job_id = live.job.id;
    live.detail!.external_ref = "MLB-MW-26873";
    live.detail!.substatus = "company_contact_required";
    live.detail!.report_type = null;
    live.identity_revision = {
      authority_kind: "legacy_job_record",
      source_instruction_id: `legacy-job:${live.job.id}`,
      source_version: 1,
      source_content_hash: `sha256:${"c".repeat(64)}`,
      lineage_id: live.job.id,
      effective_case_id: null,
    };
    live.cycles = [];
    live.reports = [];
    live.media = [];

    const client = liveSnapshotClient(live);
    const deps = createSesAssemblerRuntimeDependencies(client, {
      org_id: "org-test",
      created_by: "user-test",
    });
    const response = await prepare_ses_docket_revision(
      {
        selection: { mode: "job_number", job_number: "SWMS-26936" },
        idempotency_key: "restoration-real-card-proof-20260728",
        assembler_version: SES_ASSEMBLER_VERSION,
        dry_run: true,
        force_refresh: true,
      },
      deps,
    );
    const result = response.results[0];
    const codes = blockerCodes(result);
    assertEquals(result.state, "blocked");
    assert(codes.includes("restoration_recipe_unsealed"));
    assert(!codes.includes("family_unknown"));
    assertEquals(result.envelope.v2.classification.family, "restoration");
    assertEquals(result.envelope.v2.classification.job_type, "restoration");
    assertEquals(result.envelope.v2.classification.recipe_selected, false);
    assertEquals(
      result.blockers.find((blocker) =>
        blocker.reason_code === "restoration_recipe_unsealed"
      )?.facts?.job_number,
      "SWMS-26936",
    );
    assertEquals(result.invoice_proposal, null);
    assertEquals(result.email_drafts, {});
  },
);

Deno.test(
  "live adapter leaves an unmapped canonical family unknown without falling through to prose or legacy fields",
  () => {
    const live = snapshot();
    live.job.metadata.makesafe_job_family = "unsealed_new_family";
    live.job.metadata.job_family = "roof_report";
    live.detail!.report_type = "roof_report";
    const input = buildSesAssemblerInput(live);
    assertEquals(input.classification.family, "unknown");
  },
);

Deno.test(
  "live adapter ignores legacy family fields when the canonical family is absent",
  () => {
    const live = snapshot();
    live.job.metadata = { report_delivery: "own_document" };
    live.detail!.report_type = "roof_report";
    const input = buildSesAssemblerInput(live);
    assertEquals(input.classification.family, "unknown");
  },
);

Deno.test(
  "live adapter keeps canonical roof family ordinary unless typed own-template evidence is present",
  () => {
    const live = snapshot();
    live.job.metadata.makesafe_job_family = "roof_report";
    live.detail!.report_type = "assessment_report";
    live.detail!.report_delivery = "own_document";
    const input = buildSesAssemblerInput(live);
    assertEquals(input.classification.family, "own_template_roof");
  },
);

Deno.test(
  "live adapter leaves an unclassified non-AJS card explicitly unknown",
  () => {
    const live = snapshot();
    live.detail!.requesting_company_slug = "unsealed-builder";
    live.detail!.requesting_company_name = "Unsealed Builder";
    live.detail!.report_type = null;
    live.job.metadata = {};
    const input = buildSesAssemblerInput(live);
    assertEquals(input.classification.family, "unknown");
    assertEquals(input.source.builder_reference, "");
    assertEquals(input.source.deliverables, []);
  },
);

Deno.test(
  "live adapter seals the assessment recipe and leaves only truthful source blockers",
  async () => {
    const live = snapshot();
    live.job.metadata.makesafe_job_family = "assessment_report_quote";
    live.detail!.report_type = null;
    live.detail!.external_links = [
      { kind: "assessment_report", url: "https://portal.example.test/report" },
      { kind: "photos", url: "https://portal.example.test/photos" },
      { kind: "scope", url: "https://portal.example.test/scope" },
    ];
    const input = buildSesAssemblerInput(live);
    assertEquals(
      input.classification.assessment_outbound_recipe_version,
      SES_ASSESSMENT_RECIPE_VERSION,
    );
    const response = await prepare_ses_docket_revision(
      {
        selection: { mode: "job_id", job_id: input.identity.job_id },
        idempotency_key: "assessment-held-fixture",
        assembler_version: SES_ASSEMBLER_VERSION,
        dry_run: true,
        force_refresh: true,
      },
      {
        resolveInput: async () => input,
        resolveSourceArtifacts: async () => sourceResolver(input),
        now: () => new Date("2026-07-27T08:00:00.000Z"),
      },
    );
    const codes = blockerCodes(response.results[0]);
    assert(!codes.includes("assessment_recipe_unapproved"));
    assert(codes.includes("spine_missing_source"));
  },
);
Deno.test("live adapter resolves only the exact synthetic-livefire company profile", () => {
  const exact = snapshot();
  exact.detail!.requesting_company_slug = "synthetic-livefire";
  exact.detail!.requesting_company_name =
    "SecureWorks Synthetic Live-Fire Builder";
  exact.detail!.makesafe_companies = {
    slug: "synthetic-livefire",
    name: "SecureWorks Synthetic Live-Fire Builder",
    report_recipient: "marnin@secureworkswa.com.au",
  };
  exact.job.metadata.job_family = "roof_report";
  assertEquals(
    buildSesAssemblerInput(exact).classification.builder_key,
    "SYNTHETIC",
  );

  const lookalike = snapshot();
  lookalike.detail!.requesting_company_slug = "synthetic-livefire-lookalike";
  lookalike.detail!.requesting_company_name = "synthetic-livefire";
  lookalike.detail!.external_ref = null;
  lookalike.detail!.makesafe_companies = {
    slug: "not-synthetic-livefire",
    name: "synthetic-livefire",
    report_recipient: "marnin@secureworkswa.com.au",
  };
  lookalike.job.metadata.requesting_company = {
    slug: "synthetic-livefire",
    name: "synthetic-livefire",
  };
  assertEquals(
    buildSesAssemblerInput(lookalike).classification.builder_key,
    "UNKNOWN",
  );
});

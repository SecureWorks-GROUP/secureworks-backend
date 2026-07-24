// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyAjIntakePrefill,
  assertAjExistingJobBinding,
  deriveAjIntakePrefill,
} from "./makesafe_aj_intake_reconciliation.ts";

const body = [
  "Hi Team,",
  "",
  "Address: 12 Railton Place, Dianella WA 6059",
  "Contact: Emma Clingan",
  "Phone:",
  "Mobile: 0448855228",
].join("\n");

Deno.test("AJ 70062 labelled email derives deterministic review prefill and canonical identity", () => {
  const prefill = deriveAjIntakePrefill({
    fromEmail: "workorders@ajs.build",
    subject: "Make Safe - Dianella - Job No 70062",
    bodyText: body,
  });
  assertEquals(prefill, {
    external_ref: "70062",
    client_name: "Emma Clingan",
    client_phone: "0448855228",
    site_address: "12 Railton Place, Dianella WA 6059",
    site_suburb: "Dianella",
    builder_claim_ref: "AJBR-70062",
    builder_work_order_number: "AJBR-70062",
    deterministic_source: "aj_labelled_email",
  });
  const applied = applyAjIntakePrefill(
    { extraction_degraded: true, confidence: "low" },
    prefill,
  );
  assertEquals(applied.extraction.extraction_degraded, true);
  assertEquals(applied.extraction.confidence, "low");
  assertEquals(applied.extraction.external_ref, "70062");
  assertEquals(
    applied.extraction.deterministic_prefill_source,
    "aj_labelled_email",
  );
});

Deno.test("AJ deterministic prefill fails closed for forwarded or lookalike sources", () => {
  for (
    const input of [
      {
        fromEmail: "workorders@ajs.build.example",
        subject: "Make Safe - Dianella - Job No 70062",
        bodyText: body,
      },
      {
        fromEmail: "workorders@ajs.build",
        subject: "FW: Make Safe - Dianella - Job No 70062",
        bodyText: body,
      },
      {
        fromEmail: "workorders@ajs.build",
        subject: "Make Safe - Dianella - Job No 70062",
        bodyText: "Contact: Emma Clingan",
      },
    ]
  ) {
    assertEquals(deriveAjIntakePrefill(input), null);
  }
});

function bindingFixture() {
  const prefill = deriveAjIntakePrefill({
    fromEmail: "workorders@ajs.build",
    subject: "Make Safe - Dianella - Job No 70062",
    bodyText: body,
  });
  return {
    correction: {
      org_id: "org-1",
      source_post_id: "mailbox-aj-70062",
      target_job_id: "job-261055",
      correction_kind: "existing_job_binding",
      expected_identity_key: "wo:AJBR-70062",
    },
    draft: {
      org_id: "org-1",
      graph_message_id: "mailbox-aj-70062",
    },
    prefill,
    approvedFields: {
      requesting_company_slug: "aj",
      requesting_company_name: "AJ Building & Restoration",
      external_ref: "70062",
      client_name: "Emma Clingan",
      site_address: "12 Railton Place, Dianella WA 6059",
    },
    approvedJobFamily: "general_makesafe",
    targetJob: {
      id: "job-261055",
      job_number: "SWMS-261055",
      status: "processing",
      type: "makesafe",
      client_name: "Emma Clingan",
      site_address: "12 Railton Place, Dianella WA 6059",
      metadata: {
        external_ref: "70062",
        makesafe_job_family: "general_makesafe",
      },
    },
    targetDetails: {
      job_id: "job-261055",
      external_ref: "70062",
      requesting_company_slug: "aj",
      requesting_company_name: "AJ Building & Restoration",
    },
  };
}

Deno.test("AJ source correction may link only to the matching live existing job", () => {
  assertEquals(assertAjExistingJobBinding(bindingFixture()), undefined);
});

Deno.test("AJ source correction never revives the cancelled SWMS-261054 duplicate", () => {
  const fixture = bindingFixture();
  fixture.correction.target_job_id = "job-261054";
  fixture.targetJob.id = "job-261054";
  fixture.targetJob.job_number = "SWMS-261054";
  fixture.targetJob.status = "cancelled";
  fixture.targetDetails.job_id = "job-261054";
  assertThrows(
    () => assertAjExistingJobBinding(fixture),
    Error,
    "existing_job_binding_reconciliation_required: target job is cancelled",
  );
});

Deno.test("AJ source correction rejects reviewed fields that drift from the email", () => {
  const fixture = bindingFixture();
  fixture.approvedFields.site_address = "99 Different Road, Perth WA 6000";
  assertThrows(
    () => assertAjExistingJobBinding(fixture),
    Error,
    "existing_job_binding_reconciliation_required: source, reviewed fields and target address disagree",
  );
});

Deno.test("review approval isolates existing-job linking before duplicate/create paths", async () => {
  const index = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  assertStringIncludes(index, "loadExistingJobBindingForDraft(client, draft)");
  assertStringIncludes(index, "_assertAjExistingJobBinding({");
  assertStringIncludes(index, "linked_existing_job: true");
  const bindingBranch = index.indexOf("if (existingJobBinding) {");
  const duplicateGuard = index.indexOf("// Duplicate guard (Wave 0 H4)");
  const createCall = index.indexOf("const jobResult = await createMakesafeJob");
  assert(bindingBranch >= 0 && bindingBranch < duplicateGuard);
  assert(duplicateGuard < createCall);
});

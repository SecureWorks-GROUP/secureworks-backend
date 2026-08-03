// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  correlateIntakeApprovalIdentity,
  intakeIdentityAttachmentNames,
} from "./makesafe_intake_approval_identity.ts";

Deno.test("approval correlation persists a source-proven PO before mint", () => {
  const decision = correlateIntakeApprovalIdentity({
    extraction: {
      external_ref: "MLB-10001",
      builder_claim_ref: "MLB-10001",
    },
    approved_external_ref: "MLB-10001",
    requesting_company_slug: "mlb",
    family: "general_makesafe",
    attachment_names: ["MLB-10001PO-40001.pdf"],
  });
  assertEquals(decision.action, "ready");
  if (decision.action !== "ready") return;
  assertEquals(decision.identity_completed, true);
  assertEquals(decision.instruction_key, "MLB:PO-40001");
  assertEquals(decision.extraction.builder_claim_ref, "MLB-10001");
  assertEquals(decision.extraction.builder_po_number, "PO-40001");
});

Deno.test("approval correlation refuses two PO-grain obligations", () => {
  const decision = correlateIntakeApprovalIdentity({
    extraction: { external_ref: "MLB-10001" },
    approved_external_ref: "MLB-10001",
    requesting_company_slug: "mlb",
    family: "general_makesafe",
    attachment_names: [
      "MLB-10001PO-40001.pdf",
      "MLB-10001PO-40002.pdf",
    ],
  });
  assertEquals(decision, {
    action: "refuse",
    reason: "multiple_instruction_keys",
    instruction_keys: ["MLB:PO-40001", "MLB:PO-40002"],
  });
});

Deno.test("approval correlation refuses a source PO that conflicts with typed identity", () => {
  const decision = correlateIntakeApprovalIdentity({
    extraction: {
      external_ref: "MLB-10001PO-40001",
      builder_claim_ref: "MLB-10001",
      builder_work_order_number: "MLB-10001PO-40001",
      builder_po_number: "PO-40001",
    },
    approved_external_ref: "MLB-10001",
    requesting_company_slug: "mlb",
    family: "general_makesafe",
    attachment_names: ["MLB-10001PO-40002.pdf"],
  });
  assertEquals(decision, {
    action: "refuse",
    reason: "typed_identity_not_persistable",
    instruction_keys: ["MLB:PO-40001", "MLB:PO-40002"],
  });
});

Deno.test("approval correlation refuses a stale typed WO group", () => {
  const decision = correlateIntakeApprovalIdentity({
    extraction: {
      builder_claim_ref: "MLB-10000",
      builder_po_number: "PO-40001",
    },
    approved_external_ref: "MLB-10001",
    requesting_company_slug: "mlb",
    family: "general_makesafe",
    attachment_names: ["MLB-10001PO-40001.pdf"],
  });
  assertEquals(decision, {
    action: "refuse",
    reason: "typed_identity_not_persistable",
    instruction_keys: ["MLB:PO-40001"],
  });
});

Deno.test("approval correlation refuses a stale typed composite WO", () => {
  const decision = correlateIntakeApprovalIdentity({
    extraction: {
      builder_work_order_number: "MLB-10000PO-40001",
      builder_po_number: "PO-40001",
    },
    approved_external_ref: "MLB-10001",
    requesting_company_slug: "mlb",
    family: "general_makesafe",
    attachment_names: ["MLB-10001PO-40001.pdf"],
  });
  assertEquals(decision, {
    action: "refuse",
    reason: "typed_identity_not_persistable",
    instruction_keys: ["MLB:PO-40001"],
  });
});

Deno.test("approval correlation refuses two source WO groups even when the PO agrees", () => {
  const decision = correlateIntakeApprovalIdentity({
    extraction: {},
    approved_external_ref: "MLB-10001",
    requesting_company_slug: "mlb",
    family: "general_makesafe",
    attachment_names: ["MLB-10002PO-40001.pdf"],
  });
  assertEquals(decision, {
    action: "refuse",
    reason: "source_identity_conflict",
    instruction_keys: ["MLB:PO-40001"],
  });
});

Deno.test("approval correlation combines the approved WO with every PO-only attachment before refusing ambiguity", () => {
  const decision = correlateIntakeApprovalIdentity({
    extraction: {},
    approved_external_ref: "MLB-10001",
    requesting_company_slug: null,
    family: "general_makesafe",
    attachment_names: ["PO-40001.pdf", "PO-40002.pdf"],
  });
  assertEquals(decision, {
    action: "refuse",
    reason: "multiple_instruction_keys",
    instruction_keys: ["MLB:PO-40001", "MLB:PO-40002"],
  });
});

Deno.test("approval correlation refuses PO-only attachment ambiguity with an unknown slug", () => {
  const decision = correlateIntakeApprovalIdentity({
    extraction: {},
    approved_external_ref: "MLB-10001",
    requesting_company_slug: "unknown",
    family: "general_makesafe",
    attachment_names: ["PO-40001.pdf", "PO-40002.pdf"],
  });
  assertEquals(decision, {
    action: "refuse",
    reason: "multiple_instruction_keys",
    instruction_keys: ["MLB:PO-40001", "MLB:PO-40002"],
  });
});

Deno.test("approval correlation includes unavailable attachment identity in ambiguity proof", () => {
  const attachmentNames = intakeIdentityAttachmentNames([
    {
      file_name: "MLB-10001PO-40001.pdf",
      storage_url: "typed-source-one",
    },
    {
      file_name: "MLB-10001PO-40002.pdf",
      pdf_unavailable: true,
    },
  ]);
  const decision = correlateIntakeApprovalIdentity({
    extraction: {},
    approved_external_ref: "MLB-10001",
    requesting_company_slug: "mlb",
    family: "general_makesafe",
    attachment_names: attachmentNames,
  });
  assertEquals(decision, {
    action: "refuse",
    reason: "multiple_instruction_keys",
    instruction_keys: ["MLB:PO-40001", "MLB:PO-40002"],
  });
});

Deno.test("approval correlation refuses two PO tokens in one attachment name", () => {
  const decision = correlateIntakeApprovalIdentity({
    extraction: {},
    approved_external_ref: "MLB-10001",
    requesting_company_slug: null,
    family: "general_makesafe",
    attachment_names: ["MLB-10001_PO-40001_PO-40002.pdf"],
  });
  assertEquals(decision, {
    action: "refuse",
    reason: "multiple_instruction_keys",
    instruction_keys: ["MLB:PO-40001", "MLB:PO-40002"],
  });
});

Deno.test("approval correlation refuses a parsed PO without a resolvable builder scope", () => {
  const decision = correlateIntakeApprovalIdentity({
    extraction: {},
    approved_external_ref: "27037",
    requesting_company_slug: null,
    family: "general_makesafe",
    attachment_names: ["PO-40001.pdf"],
  });
  assertEquals(decision, {
    action: "refuse",
    reason: "typed_identity_not_persistable",
    instruction_keys: [],
  });
});

Deno.test("approval correlation refuses an unparseable PO-shaped source name", () => {
  const decision = correlateIntakeApprovalIdentity({
    extraction: {},
    approved_external_ref: "MLB-10001",
    requesting_company_slug: "mlb",
    family: "general_makesafe",
    attachment_names: ["MLB-10001_P.O.40001.pdf"],
  });
  assertEquals(decision, {
    action: "refuse",
    reason: "source_identity_conflict",
    instruction_keys: [],
  });
});

Deno.test("approval correlation combines one PO-only attachment with the approved WO", () => {
  const decision = correlateIntakeApprovalIdentity({
    extraction: {},
    approved_external_ref: "MLB-10001",
    requesting_company_slug: null,
    family: "general_makesafe",
    attachment_names: ["PO-40001.pdf"],
  });
  assertEquals(decision.action, "ready");
  if (decision.action !== "ready") return;
  assertEquals(decision.instruction_key, "MLB:PO-40001");
  assertEquals(decision.extraction.builder_claim_ref, "MLB-10001");
  assertEquals(decision.extraction.builder_po_number, "PO-40001");
});

Deno.test("approval correlation is idempotent for already-typed identity", () => {
  const extraction = {
    external_ref: "MLB-10001PO-40001",
    builder_claim_ref: "MLB-10001",
    builder_work_order_number: "MLB-10001PO-40001",
    builder_po_number: "PO-40001",
  };
  const decision = correlateIntakeApprovalIdentity({
    extraction,
    approved_external_ref: "MLB-10001",
    requesting_company_slug: "mlb",
    family: "general_makesafe",
    attachment_names: ["MLB-10001PO-40001.pdf"],
  });
  assertEquals(decision.action, "ready");
  if (decision.action !== "ready") return;
  assertEquals(decision.instruction_key, "MLB:PO-40001");
  assertEquals(decision.identity_completed, false);
  const repeated = correlateIntakeApprovalIdentity({
    extraction: decision.extraction,
    approved_external_ref: "MLB-10001",
    requesting_company_slug: "mlb",
    family: "general_makesafe",
    attachment_names: ["MLB-10001PO-40001.pdf"],
  });
  assertEquals(repeated, decision);
});

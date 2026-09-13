// Isolated Build Pack continuation after trigger prepare.
// Retained Marangaroo pointers are fixtures. No live bind, mint, or send.
import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyIsolatedSesPackContinuation,
  planSesBuildPackContinuation,
  pointerViewAfterIsolatedApply,
  type SesPackPointerView,
  type SesRetainedArtifacts,
} from "./ses_build_pack_continuation.ts";

const MARANGAROO: SesRetainedArtifacts = {
  job_id: "642574e0-b5d5-4cb8-9d75-0e1d0f1334c7",
  report_doc_id: "9e3a5dc5-7c24-48c5-a29a-3b93ab366919",
  invoice_number: "INV-1515",
  invoice_doc_id: "4221d6e0-5aa7-4056-9a5b-7a3b99cda029",
  invoice_status: "DRAFT",
  pdf_sha256: "75481a2805132ff532707380b395dfe1b3313f8404a2771e95b6048cfdb3e8f5",
  photo_count: 13,
  tenant_ok: true,
};

function thornliePrepared(): SesPackPointerView {
  return {
    job_id: "24ea7afb-974a-4e94-afec-324d5d9b91fd",
    job_number: "SWMS-261399",
    required_documents: { report: true, invoice: true, swms: false },
    pack: {
      report_doc_id: null,
      invoice_doc_id: null,
      swms_doc_id: null,
      sent_at: null,
    },
    xero_binding: null,
    invoice: { number: null, status: null, doc_id: null },
  };
}

function marangarooUnbound(): SesPackPointerView {
  return {
    job_id: MARANGAROO.job_id,
    job_number: "SWMS-261403",
    required_documents: { report: true, invoice: true, swms: false },
    pack: {
      report_doc_id: null,
      invoice_doc_id: null,
      swms_doc_id: null,
      sent_at: null,
    },
    xero_binding: {
      invoice_number: "INV-1515",
      status: "DRAFT",
      xero_invoice_id: "7ca47741-bff7-4170-8824-fe029637b85b",
    },
    invoice: { number: "INV-1515", status: "DRAFT", doc_id: null },
  };
}

function marangarooReady(): SesPackPointerView {
  return {
    job_id: MARANGAROO.job_id,
    job_number: "SWMS-261403",
    required_documents: { report: true, invoice: true, swms: false },
    pack: {
      report_doc_id: MARANGAROO.report_doc_id!,
      invoice_doc_id: MARANGAROO.invoice_doc_id!,
      swms_doc_id: null,
      sent_at: null,
    },
    xero_binding: {
      invoice_number: "INV-1515",
      status: "DRAFT",
      xero_invoice_id: "7ca47741-bff7-4170-8824-fe029637b85b",
    },
    invoice: {
      number: "INV-1515",
      status: "DRAFT",
      doc_id: MARANGAROO.invoice_doc_id,
    },
  };
}

Deno.test("Marangaroo retained pointers are Docs Ready unsent, never a send", () => {
  const plan = planSesBuildPackContinuation(marangarooReady(), MARANGAROO);
  assertEquals(plan.kind, "docs_ready_unsent");
  assertEquals(plan.live_send, false);
  assertEquals(plan.live_mint, false);
  assertEquals(plan.report_doc_id, MARANGAROO.report_doc_id);
  assertEquals(plan.invoice_doc_id, MARANGAROO.invoice_doc_id);
});

Deno.test("existing INV-1515 is reused; never mint", () => {
  const plan = planSesBuildPackContinuation(marangarooUnbound(), MARANGAROO);
  assertEquals(plan.kind, "reuse_invoice_and_bind");
  assertEquals(plan.reuse_invoice_number, "INV-1515");
  assertEquals(plan.live_mint, false);
  assertEquals(plan.live_bind, false);
});

Deno.test("isolated apply copies retained pointers without live doors", () => {
  const view = marangarooUnbound();
  const plan = planSesBuildPackContinuation(view, MARANGAROO);
  const applied = applyIsolatedSesPackContinuation(view, plan, MARANGAROO);
  assertEquals(applied.report_doc_id, MARANGAROO.report_doc_id);
  assertEquals(applied.invoice_doc_id, MARANGAROO.invoice_doc_id);
  const after = pointerViewAfterIsolatedApply(view, applied);
  assertEquals(planSesBuildPackContinuation(after, MARANGAROO).kind, "docs_ready_unsent");
  assertEquals(after.pack.sent_at, null);
});

Deno.test("Thornlie prepared docket without pointers awaits Build Pack, no mint", () => {
  const plan = planSesBuildPackContinuation(thornliePrepared());
  assertEquals(plan.kind, "awaiting_pack");
  assertEquals(plan.live_mint, false);
  assertEquals(plan.live_bind, false);
});

Deno.test("duplicate overlapping inspect of complete pointers stays one unsent Docs Ready", () => {
  const a = planSesBuildPackContinuation(marangarooReady(), MARANGAROO);
  const b = planSesBuildPackContinuation(marangarooReady(), MARANGAROO);
  assertEquals(a.kind, "docs_ready_unsent");
  assertEquals(b.kind, "docs_ready_unsent");
});

Deno.test("interrupted bind (report only) still reuses invoice, does not mint", () => {
  const view = marangarooUnbound();
  view.pack.report_doc_id = MARANGAROO.report_doc_id!;
  const plan = planSesBuildPackContinuation(view, MARANGAROO);
  assertEquals(plan.kind, "reuse_invoice_and_bind");
  assertEquals(plan.reuse_invoice_number, "INV-1515");
});

Deno.test("stale sent pack is already_sent; continuation must not send", () => {
  const view = marangarooReady();
  view.pack.sent_at = "2026-09-10T14:16:33.216024+00:00";
  const plan = planSesBuildPackContinuation(view, MARANGAROO);
  assertEquals(plan.kind, "already_sent");
  assertEquals(plan.live_send, false);
});

Deno.test("missing photos hold; unsupported family hold", () => {
  const view = marangarooUnbound();
  assertEquals(
    planSesBuildPackContinuation(view, { ...MARANGAROO, missing_photos: true }).kind,
    "hold_missing_photos",
  );
  assertEquals(
    planSesBuildPackContinuation(view, { ...MARANGAROO, unsupported_family: true }).kind,
    "hold_unsupported_family",
  );
});

Deno.test("SWMS owed but missing parks awaiting_pack; does not mint", () => {
  const view = marangarooReady();
  view.required_documents = { report: true, invoice: true, swms: true };
  view.pack.swms_doc_id = null;
  const plan = planSesBuildPackContinuation(view, MARANGAROO);
  assertEquals(plan.kind, "awaiting_pack");
  assertEquals(plan.live_mint, false);
});

Deno.test("cross-job retained artifacts refuse; tenant refuse", () => {
  const view = marangarooUnbound();
  assertEquals(
    planSesBuildPackContinuation(view, { ...MARANGAROO, job_id: thornliePrepared().job_id }).kind,
    "refuse_cross_job",
  );
  assertEquals(
    planSesBuildPackContinuation(view, { ...MARANGAROO, tenant_ok: false }).kind,
    "refuse_tenant",
  );
  assertThrows(
    () =>
      applyIsolatedSesPackContinuation(
        view,
        planSesBuildPackContinuation(view, MARANGAROO),
        { ...MARANGAROO, job_id: thornliePrepared().job_id },
      ),
    Error,
    "cross-job",
  );
});

// ════════════════════════════════════════════════════════════
// M-A2 / W2-B — TWO-EMAIL LATE WORK-ORDER-PDF LANDING TESTS
// Mission: makesafe-system wave-2-hardening-2026-07-07 (section W2-B)
// ════════════════════════════════════════════════════════════
//
// The fixture is the REAL MLB two-email sequence:
//   Email 1 — "NEW WORK ORDER - MLB-25096 ..." with NO PDF -> a dirty intake
//             draft (missing_work_order_pdf).
//   Email 2 — a later "PO-53582" email carrying the WO PDF (work_order_MLB-
//             25096PO-53582.pdf), extracted WITH the PDF (client fields land).
//
// Pure decision + merge are tested directly; the orchestration is driven with a
// hand-rolled table-aware stub client (model: makesafe_reextract_test.ts) so no
// network/model/storage is needed. Regression: the single-email path (no matching
// dirty draft) must return { kind: "none" } so normal minting is untouched.
//
// RUN: deno test --no-check --allow-all supabase/functions/ops-api/makesafe_intake_late_pdf_test.ts

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  draftIsWorkOrderPdfDirty,
  type LatePdfCandidate,
  type LatePdfDraftRow,
  mergeLateWorkOrderPdfIntoDraft,
  selectLatePdfLandingTarget,
} from "./makesafe_intake_late_pdf.ts";
import {
  _landLateWorkOrderPdfOntoDraftForTest,
  _shouldAutoApproveCleanIntakeDraftRowForTest,
} from "./index.ts";

const WO_PDF = {
  name: "work_order_MLB-25096PO-53582.pdf",
  file_name: "work_order_MLB-25096PO-53582.pdf",
  pdf_url: "https://x/wo.pdf",
  storage_url: "makesafe-intake/h/wo.pdf",
  is_work_order: true,
};

// Email 1: the ANNOUNCEMENT draft — ref + company + address, but NO WO PDF and no PO.
function announcementDraft(
  over: Partial<LatePdfDraftRow> = {},
): LatePdfDraftRow {
  return {
    id: "d-announce",
    status: "draft",
    external_ref: "MLB-25096",
    requesting_company_slug: "mlb",
    requesting_company_name: "ML Builders",
    makesafe_job_family: "general_makesafe",
    builder_work_order_number: null,
    builder_po_number: null,
    attachments_json: [],
    extraction_json: {
      external_ref: "MLB-25096",
      makesafe_job_family: "general_makesafe",
    },
    missing_fields: ["missing_work_order_pdf", "client_name"],
    client_name: null,
    client_phone: null,
    site_address: "12 Foo St",
    site_suburb: "Perth",
    description: "Make safe",
    safety_requirements: null,
    confidence: "low",
    report_type: null,
    subject: "NEW WORK ORDER - MLB-25096 12 Foo St",
    ...over,
  };
}

// Email 2: the later PO email, already extracted WITH the WO PDF.
function poCandidate(over: Partial<LatePdfCandidate> = {}): LatePdfCandidate {
  return {
    external_ref: "MLB-25096",
    requesting_company_slug: "mlb",
    requesting_company_name: "ML Builders",
    makesafe_job_family: "general_makesafe",
    builder_work_order_number: "MLB-25096",
    builder_po_number: "53582",
    graph_message_id: "AAMk-email2",
    confidence: "high",
    attachments: [WO_PDF],
    extraction: {
      external_ref: "MLB-25096",
      client_name: "Jane Homeowner",
      client_phone: "0400111222",
      site_address: "12 Foo St",
      builder_work_order_number: "MLB-25096",
      builder_po_number: "53582",
      makesafe_job_family: "general_makesafe",
    },
    missingFields: [],
    ...over,
  };
}

// ── draftIsWorkOrderPdfDirty ──
Deno.test("dirty check: no servable PDF is dirty; a real pdf_url is clean; pdf_unavailable is dirty", () => {
  assert(draftIsWorkOrderPdfDirty([]));
  assert(draftIsWorkOrderPdfDirty([{ pdf_unavailable: true, pdf_url: null }]));
  assert(!draftIsWorkOrderPdfDirty([{ pdf_url: "https://x/wo.pdf" }]));
  assert(!draftIsWorkOrderPdfDirty([{ storage_url: "path/wo.pdf" }]));
});

// ── selectLatePdfLandingTarget ──
Deno.test("select: the classic two-email case lands on the sole dirty announcement", () => {
  const r = selectLatePdfLandingTarget(poCandidate(), [announcementDraft()]);
  assertEquals(r.kind, "target");
  if (r.kind === "target") assertEquals(r.target.id, "d-announce");
});

Deno.test("select: a dirty draft with the SAME builder WO/PO identity is the target", () => {
  const withId = announcementDraft({
    id: "d-id",
    builder_work_order_number: "MLB-25096",
    builder_po_number: "53582",
    extraction_json: {
      builder_work_order_number: "MLB-25096",
      builder_po_number: "53582",
    },
  });
  const r = selectLatePdfLandingTarget(poCandidate(), [withId]);
  assertEquals(r.kind, "target");
  if (r.kind === "target") assertEquals(r.target.id, "d-id");
});

Deno.test("select: TWO dirty drafts for the same ref -> ambiguous (fail closed)", () => {
  const a = announcementDraft({ id: "d1" });
  const b = announcementDraft({ id: "d2" });
  const r = selectLatePdfLandingTarget(poCandidate(), [a, b]);
  assertEquals(r.kind, "ambiguous");
});

Deno.test("select: single-email regression — no matching dirty draft -> none", () => {
  // A genuinely-new WO (no existing draft for this ref) must not trigger landing.
  const other = announcementDraft({ id: "x", external_ref: "MLB-99999" });
  assertEquals(selectLatePdfLandingTarget(poCandidate(), [other]).kind, "none");
  assertEquals(selectLatePdfLandingTarget(poCandidate(), []).kind, "none");
});

Deno.test("select: an existing draft that ALREADY has a servable PDF is not a target -> none", () => {
  const clean = announcementDraft({
    attachments_json: [{
      pdf_url: "https://x/existing.pdf",
      is_work_order: true,
    }],
  });
  assertEquals(selectLatePdfLandingTarget(poCandidate(), [clean]).kind, "none");
});

Deno.test("select: a dirty draft carrying a DIFFERENT WO/PO identity is a new WO -> none", () => {
  const otherWo = announcementDraft({
    id: "d-po-b",
    builder_work_order_number: "MLB-25096",
    builder_po_number: "53583",
    extraction_json: {
      builder_work_order_number: "MLB-25096",
      builder_po_number: "53583",
    },
  });
  assertEquals(
    selectLatePdfLandingTarget(poCandidate(), [otherWo]).kind,
    "none",
  );
});

Deno.test("select: a family mismatch (assessment vs general) is excluded -> none", () => {
  const assessment = announcementDraft({
    makesafe_job_family: "assessment_report_quote",
    extraction_json: { makesafe_job_family: "assessment_report_quote" },
  });
  assertEquals(
    selectLatePdfLandingTarget(poCandidate(), [assessment]).kind,
    "none",
  );
});

Deno.test("select: candidate with a PDF but no parseable identity lands only when exactly one dirty draft exists", () => {
  const noId = poCandidate({
    builder_work_order_number: null,
    builder_po_number: null,
    extraction: {
      external_ref: "MLB-25096",
      client_name: "Jane",
      site_address: "12 Foo St",
    },
  });
  assertEquals(
    selectLatePdfLandingTarget(noId, [announcementDraft()]).kind,
    "target",
  );
  assertEquals(
    selectLatePdfLandingTarget(noId, [
      announcementDraft({ id: "a" }),
      announcementDraft({ id: "b" }),
    ]).kind,
    "ambiguous",
  );
});

// ── mergeLateWorkOrderPdfIntoDraft ──
Deno.test("merge: lands the PDF, fills null client_name, strips WO-PDF + dedup-review markers, upgrades confidence", () => {
  const draft = announcementDraft({
    missing_fields: [
      "missing_work_order_pdf",
      "client_name",
      "work_order_identity_needs_review",
    ],
  });
  const m = mergeLateWorkOrderPdfIntoDraft(draft, poCandidate());
  assertEquals(m.available_wo_count, 1);
  assertEquals(m.attachments_json.length, 1);
  assertEquals(m.client_name, "Jane Homeowner");
  assertEquals(m.site_address, "12 Foo St"); // existing kept
  assert(m.filled_fields.includes("client_name"));
  assertEquals(m.confidence, "high");
  assert(!m.missing_fields.includes("missing_work_order_pdf"));
  assert(!m.missing_fields.includes("work_order_identity_needs_review"));
  assert(!m.missing_fields.includes("client_name"));
  assertEquals(m.missing_fields.length, 0);
  // identity + provenance carried onto the draft's extraction
  assertEquals(m.extraction_json.builder_po_number, "53582");
  assertEquals(m.extraction_json.late_pdf_landed, true);
  assertEquals(
    m.extraction_json.late_pdf_source_graph_message_id,
    "AAMk-email2",
  );
});

Deno.test("merge: NEVER overwrites an existing (non-null) client field from the candidate", () => {
  const draft = announcementDraft({
    client_name: "Original Name",
    missing_fields: ["missing_work_order_pdf"],
  });
  const m = mergeLateWorkOrderPdfIntoDraft(draft, poCandidate());
  assertEquals(m.client_name, "Original Name");
  assert(!m.filled_fields.includes("client_name"));
});

Deno.test("merge: a GENUINE candidate review marker (reply_forward_risk) is carried so it can't auto-approve", () => {
  const m = mergeLateWorkOrderPdfIntoDraft(
    announcementDraft(),
    poCandidate({ missingFields: ["reply_forward_risk"] }),
  );
  assert(m.missing_fields.includes("reply_forward_risk"));
});

Deno.test("merge: a known-family PDF does not resolve an unknown draft family", () => {
  const m = mergeLateWorkOrderPdfIntoDraft(
    announcementDraft({
      makesafe_job_family: null,
      extraction_json: { external_ref: "MLB-25096" },
    }),
    poCandidate(),
  );
  assert(m.missing_fields.includes("work_order_family_needs_review"));
  assertEquals(m.extraction_json.makesafe_job_family, undefined);
});

// ── merged row passes / fails the UNCHANGED strict auto-approve gate ──
Deno.test("gate: a clean merged draft row passes shouldAutoApproveCleanIntakeDraftRow", () => {
  const draft = announcementDraft();
  const m = mergeLateWorkOrderPdfIntoDraft(draft, poCandidate());
  const mergedRow = {
    ...draft,
    attachments_json: m.attachments_json,
    extraction_json: m.extraction_json,
    missing_fields: m.missing_fields,
    confidence: m.confidence,
    client_name: m.client_name,
    site_address: m.site_address,
  };
  const decision = _shouldAutoApproveCleanIntakeDraftRowForTest(mergedRow);
  assertEquals(decision.ok, true, decision.reason);
});

Deno.test("gate: a merged draft that gained no client_name still blocks (missing_client_name)", () => {
  const draft = announcementDraft();
  const m = mergeLateWorkOrderPdfIntoDraft(
    draft,
    poCandidate({
      extraction: {
        external_ref: "MLB-25096",
        site_address: "12 Foo St",
        builder_po_number: "53582",
      },
    }),
  );
  const mergedRow = {
    ...draft,
    attachments_json: m.attachments_json,
    missing_fields: m.missing_fields,
    confidence: m.confidence,
    client_name: m.client_name,
    site_address: m.site_address,
  };
  const decision = _shouldAutoApproveCleanIntakeDraftRowForTest(mergedRow);
  assertEquals(decision.ok, false);
});

// ── orchestration (stub client) ──
function makeClient(cfg: { drafts: LatePdfDraftRow[] }) {
  const captured: {
    update: any;
    updateId: string | null;
    events: any[];
    inserts: any[];
  } = { update: null, updateId: null, events: [], inserts: [] };
  const make = (table: string) => {
    const state: { op: string; updateRow: any; eqId: string | null } = {
      op: "select",
      updateRow: null,
      eqId: null,
    };
    const chain: any = {
      select: () => chain,
      update: (row: any) => {
        state.op = "update";
        state.updateRow = row;
        return chain;
      },
      insert: (row: any) => {
        if (table === "business_events") captured.events.push(row);
        else captured.inserts.push({ table, row });
        return Promise.resolve({ error: null });
      },
      eq: (col: string, val: any) => {
        if (col === "id") state.eqId = val;
        return chain;
      },
      in: () => chain,
      // fetchAllRows appends `.order(uniqueKey)` before `.range()`; the mock must
      // expose it so the chain reaches the range terminal.
      order: () => chain,
      // fetchAllRows terminal: one page under PAGE_SIZE so it stops after one call.
      range: () =>
        Promise.resolve({
          data: table === "makesafe_intake_drafts" && state.op === "select"
            ? cfg.drafts
            : [],
          error: null,
        }),
      single: async () => {
        if (table === "makesafe_intake_drafts" && state.op === "update") {
          captured.update = state.updateRow;
          captured.updateId = state.eqId;
          const target = cfg.drafts.find((d) => d.id === state.eqId) || {};
          return { data: { ...target, ...state.updateRow }, error: null };
        }
        return { data: null, error: null };
      },
    };
    return chain;
  };
  return { from: make, _captured: captured };
}

Deno.test("orchestration: explicit false brake parks the two-email update without auto-file", async () => {
  // Captain Amendment 46 made an absent env value default ON. Only the exact
  // deployment brake "false" disables advancement; deleting the variable here
  // was stale contract logic and accidentally exercised the live default.
  Deno.env.set("MAKESAFE_AUTO_APPROVE_CLEAN_INTAKE", "false");
  try {
    const client = makeClient({ drafts: [announcementDraft()] });
    const r = await _landLateWorkOrderPdfOntoDraftForTest(client as any, {
      candidate: poCandidate(),
      autoFileEnabled: true,
      extractionDegraded: false,
      subject: "PO-53582 MLB-25096",
    });
    assertEquals(r.outcome, "landed");
    if (r.outcome === "landed") {
      assertEquals(r.draft_id, "d-announce");
      assertEquals(r.status, "needs_review"); // all required present -> review-ready
      assertEquals(r.auto_filed, null); // explicit brake -> no promotion
    }
    // UPDATE captured against the existing id; NEVER an INSERT into makesafe_intake_drafts.
    assertEquals(client._captured.updateId, "d-announce");
    assertEquals(client._captured.update.client_name, "Jane Homeowner");
    assertEquals(client._captured.update.attachments_json.length, 1);
    assertEquals(client._captured.inserts.length, 0);
    // landing breadcrumb emitted
    assert(
      client._captured.events.some((e: any) =>
        e.event_type === "makesafe.intake_late_pdf_landed"
      ),
    );
  } finally {
    Deno.env.delete("MAKESAFE_AUTO_APPROVE_CLEAN_INTAKE");
  }
});

Deno.test("orchestration: auto-files through the UNCHANGED gate when the flag is ON and the merged draft is clean", async () => {
  Deno.env.set("MAKESAFE_AUTO_APPROVE_CLEAN_INTAKE", "true");
  try {
    const client = makeClient({ drafts: [announcementDraft()] });
    let approvedWith: any = null;
    const r = await _landLateWorkOrderPdfOntoDraftForTest(client as any, {
      candidate: poCandidate(),
      autoFileEnabled: true,
      extractionDegraded: false,
    }, {
      approve: (async (_c: any, body: any) => {
        approvedWith = body;
        return { job: { id: "job-1" } };
      }) as any,
    });
    assertEquals(r.outcome, "landed");
    if (r.outcome === "landed") {
      assertEquals(r.auto_filed?.job_id, "job-1");
    }
    assertEquals(approvedWith?.draft_id, "d-announce");
    assertEquals(approvedWith?.approved_by, "auto-intake-late-pdf");
  } finally {
    Deno.env.delete("MAKESAFE_AUTO_APPROVE_CLEAN_INTAKE");
  }
});

Deno.test("orchestration: degraded extraction never auto-files even with the flag ON", async () => {
  Deno.env.set("MAKESAFE_AUTO_APPROVE_CLEAN_INTAKE", "true");
  try {
    const client = makeClient({ drafts: [announcementDraft()] });
    let approveCalled = false;
    const r = await _landLateWorkOrderPdfOntoDraftForTest(client as any, {
      candidate: poCandidate(),
      autoFileEnabled: true,
      extractionDegraded: true,
    }, {
      approve: (async () => {
        approveCalled = true;
        return { job: { id: "x" } };
      }) as any,
    });
    assertEquals(r.outcome, "landed");
    if (r.outcome === "landed") assertEquals(r.auto_filed, null);
    assertEquals(approveCalled, false);
  } finally {
    Deno.env.delete("MAKESAFE_AUTO_APPROVE_CLEAN_INTAKE");
  }
});

Deno.test("orchestration: unknown-family target accepts the PDF but never auto-files", async () => {
  Deno.env.set("MAKESAFE_AUTO_APPROVE_CLEAN_INTAKE", "true");
  try {
    const client = makeClient({
      drafts: [announcementDraft({
        makesafe_job_family: null,
        extraction_json: { external_ref: "MLB-25096" },
      })],
    });
    let approveCalled = false;
    const r = await _landLateWorkOrderPdfOntoDraftForTest(client as any, {
      candidate: poCandidate(),
      autoFileEnabled: true,
      extractionDegraded: false,
    }, {
      approve: (async () => {
        approveCalled = true;
        return { job: { id: "x" } };
      }) as any,
    });
    assertEquals(r.outcome, "landed");
    if (r.outcome === "landed") assertEquals(r.auto_filed, null);
    assertEquals(approveCalled, false);
    assert(
      client._captured.update.missing_fields.includes(
        "work_order_family_needs_review",
      ),
    );
  } finally {
    Deno.env.delete("MAKESAFE_AUTO_APPROVE_CLEAN_INTAKE");
  }
});

Deno.test("orchestration: ambiguous (two dirty drafts) fails closed — no update, breadcrumb written", async () => {
  const client = makeClient({
    drafts: [announcementDraft({ id: "d1" }), announcementDraft({ id: "d2" })],
  });
  const r = await _landLateWorkOrderPdfOntoDraftForTest(client as any, {
    candidate: poCandidate(),
    autoFileEnabled: true,
    extractionDegraded: false,
  });
  assertEquals(r.outcome, "ambiguous");
  assertEquals(client._captured.update, null);
  assertEquals(client._captured.inserts.length, 0);
  assert(
    client._captured.events.some((e: any) =>
      e.event_type === "makesafe.intake_late_pdf_ambiguous"
    ),
  );
});

Deno.test("orchestration: no matching dirty draft -> none (falls through to normal minting)", async () => {
  const client = makeClient({
    drafts: [announcementDraft({ external_ref: "MLB-99999" })],
  });
  const r = await _landLateWorkOrderPdfOntoDraftForTest(client as any, {
    candidate: poCandidate(),
    autoFileEnabled: true,
    extractionDegraded: false,
  });
  assertEquals(r.outcome, "none");
  assertEquals(client._captured.update, null);
});

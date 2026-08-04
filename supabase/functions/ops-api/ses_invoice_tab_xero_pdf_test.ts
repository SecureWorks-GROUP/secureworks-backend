// deno-lint-ignore-file no-explicit-any no-import-prefix
/**
 * Invoice tab must present the real Xero DRAFT PDF, never a local HTML
 * tax-invoice invention, when a DRAFT is bound.
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  getSesReviewablePackAction,
  resolveSesBoundDraftInvoicePdfArtifact,
  storeSesXeroInvoicePdfBytes,
} from "./ses_reporting_actions.ts";

const JOB_ID = "00000000-0000-4000-8000-0000000000b1";
const DOCKET_ID = "00000000-0000-4000-8000-0000000000d1";
const OBLIGATION_ID = "00000000-0000-4000-8000-0000000000o1";
const XERO_ID = "d01b0ef1-c6e8-4cc3-9396-e43a9ee671d2";

function pdfBytes(): Uint8Array {
  return new TextEncoder().encode("%PDF-1.4 real-xero-draft-fixture");
}

function packClient(opts: {
  binding?: Record<string, unknown>;
  artifacts?: Array<Record<string, unknown>>;
  storedPath?: string;
} = {}) {
  const binding = {
    xero_invoice_id: XERO_ID,
    invoice_number: "INV-1102",
    status: "DRAFT",
    total: 737,
    ...(opts.binding || {}),
  };
  const review = {
    docket_revision_id: DOCKET_ID,
    docket_output_content_hash: `sha256:${"a".repeat(64)}`,
    assembler_version: "ses-pack-assembler/v1",
    family_matrix_version: "family-matrix-fixture",
  };
  const docket = {
    id: DOCKET_ID,
    org_id: "org-fixture",
    job_id: JOB_ID,
    output_content_hash: review.docket_output_content_hash,
    assembler_version: review.assembler_version,
    family_matrix_version: review.family_matrix_version,
    stage: "pre_xero",
    committed_at: "2026-08-04T00:00:00.000Z",
    envelope: {
      v2: { classification: { family: "assessment_quote" } },
    },
    blockers: [],
    email_drafts: {},
    review_spec: {},
    local_invoice_proposal: {
      line_items: [{ description: "local concoction", quantity: 1 }],
      subtotal_ex_gst: 999,
      total_inc_gst: 1098.9,
    },
    xero_binding: null,
    invoice_obligation_revision_id: OBLIGATION_ID,
    artifact_count: (opts.artifacts || []).length,
    artifact_size_bytes: 0,
  };
  const obligation = {
    id: OBLIGATION_ID,
    xero_binding: binding,
    pricing_disposition: "priced_from_canon",
    state: "create_executed",
  };
  const rows: Record<string, unknown> = {
    ses_docket_review_current: review,
    makesafe_docket_revisions: docket,
    makesafe_docket_artifacts: opts.artifacts || [],
    makesafe_invoice_obligation_revisions: obligation,
    makesafe_invoice_obligation_revisions_current: obligation,
    ses_docket_review_events: [],
  };
  const uploads: Array<{ path: string; size: number }> = [];
  const signedPaths: string[] = [];
  const client = {
    storage: {
      from() {
        return {
          upload: (path: string, bytes: Uint8Array) => {
            uploads.push({ path, size: bytes.byteLength });
            return Promise.resolve({ data: { path }, error: null });
          },
          createSignedUrl: (path: string) => {
            signedPaths.push(path);
            return Promise.resolve({
              data: { signedUrl: `https://signed.example.test/${path}` },
              error: null,
            });
          },
          download: () =>
            Promise.resolve({
              data: new Blob([new Uint8Array(pdfBytes())]),
              error: null,
            }),
        };
      },
    },
    from(table: string) {
      let mode = "select";
      let updatePayload: any = null;
      const query: any = {
        select: () => query,
        eq: () => query,
        order: () => query,
        limit: () => query,
        update: (payload: any) => {
          mode = "update";
          updatePayload = payload;
          return query;
        },
        maybeSingle: () => {
          if (mode === "update") {
            if (table.includes("obligation")) {
              Object.assign(obligation, updatePayload || {});
              Object.assign(obligation.xero_binding || {}, updatePayload?.xero_binding || {});
            }
            return Promise.resolve({ data: { id: OBLIGATION_ID }, error: null });
          }
          const value = rows[table];
          return Promise.resolve({
            data: Array.isArray(value) ? value[0] || null : value,
            error: null,
          });
        },
        then: (resolve: (value: unknown) => unknown) => {
          const value = rows[table];
          return Promise.resolve({
            data: value,
            error: null,
          }).then(resolve);
        },
      };
      return query;
    },
  } as any;
  return { client, uploads, signedPaths, binding, obligation };
}

Deno.test("storeSesXeroInvoicePdfBytes refuses non-PDF concoctions", async () => {
  const { client } = packClient();
  let failed = false;
  try {
    await storeSesXeroInvoicePdfBytes(client, {
      job_id: JOB_ID,
      invoice: {
        xero_invoice_id: XERO_ID,
        invoice_number: "INV-1102",
        status: "DRAFT",
      },
      pdf: new TextEncoder().encode("<html>fake tax invoice</html>"),
    });
  } catch (error) {
    failed = true;
    assertStringIncludes(String((error as Error).message), "PDF");
  }
  assertEquals(failed, true);
});

Deno.test("bound DRAFT with stored binding PDF projects a signed xero_invoice_pdf", async () => {
  const stored = await storeSesXeroInvoicePdfBytes(packClient().client, {
    job_id: JOB_ID,
    invoice: {
      xero_invoice_id: XERO_ID,
      invoice_number: "INV-1102",
      status: "DRAFT",
    },
    pdf: pdfBytes(),
  });
  const { client, signedPaths } = packClient({
    binding: {
      pdf_object_key: stored.pdf_object_key,
      pdf_content_hash: stored.pdf_content_hash,
      pdf_size_bytes: stored.pdf_size_bytes,
      pdf_stored_at: stored.pdf_stored_at,
    },
  });
  const resolved = await resolveSesBoundDraftInvoicePdfArtifact(client, {
    job_id: JOB_ID,
    docket: { id: DOCKET_ID, stage: "pre_xero", xero_binding: null },
    obligation: {
      id: OBLIGATION_ID,
      xero_binding: {
        xero_invoice_id: XERO_ID,
        invoice_number: "INV-1102",
        status: "DRAFT",
        ...stored,
      },
    },
    artifacts: [],
  });
  assertEquals(resolved.source, "stored_binding");
  assertEquals(resolved.artifact.role, "xero_invoice_pdf");
  assertEquals(resolved.artifact.pdf_unavailable, false);
  assertStringIncludes(String(resolved.artifact.signed_url), "signed.example.test");
  assertEquals(objectMeta(resolved.artifact).xero_invoice_id, XERO_ID);
  assertEquals(objectMeta(resolved.artifact).invoice_number, "INV-1102");
  assertEquals(signedPaths.length >= 1, true);
});

Deno.test("bound DRAFT without stored PDF live-fetches Xero bytes and never invents HTML", async () => {
  const { client, uploads } = packClient();
  let fetchCalls = 0;
  const resolved = await resolveSesBoundDraftInvoicePdfArtifact(client, {
    job_id: JOB_ID,
    docket: { id: DOCKET_ID, stage: "pre_xero", xero_binding: null },
    obligation: {
      id: OBLIGATION_ID,
      xero_binding: {
        xero_invoice_id: XERO_ID,
        invoice_number: "INV-1102",
        status: "DRAFT",
      },
    },
    artifacts: [
      // Stale local-looking role must not win over the bound DRAFT identity.
      {
        role: "invoice_proposal",
        object_key: "makesafe-docket-artifacts/job/2-Invoice-fake.pdf",
        media_type: "application/pdf",
        signed_url: "https://fake.example/2-Invoice-fake.pdf",
      },
    ],
    fetchInvoicePdfBytes: async () => {
      fetchCalls++;
      return pdfBytes();
    },
  });
  assertEquals(fetchCalls, 1);
  assertEquals(resolved.source, "live_fetch");
  assertEquals(resolved.artifact.role, "xero_invoice_pdf");
  assertEquals(resolved.artifact.pdf_unavailable, false);
  assertStringIncludes(String(resolved.artifact.signed_url), "signed.example.test");
  assertEquals(uploads.length >= 1, true);
  assertStringIncludes(uploads[0].path, "xero-invoice-pdfs/");
});

Deno.test("bound DRAFT with unfetchable PDF reports unavailable — no fake artifact URL", async () => {
  const { client } = packClient();
  const resolved = await resolveSesBoundDraftInvoicePdfArtifact(client, {
    job_id: JOB_ID,
    docket: { id: DOCKET_ID, stage: "pre_xero", xero_binding: null },
    obligation: {
      id: OBLIGATION_ID,
      xero_binding: {
        xero_invoice_id: XERO_ID,
        invoice_number: "INV-1102",
        status: "DRAFT",
      },
    },
    artifacts: [],
    fetchInvoicePdfBytes: async () => {
      throw new Error("Xero PDF temporarily unavailable");
    },
  });
  assertEquals(resolved.source, "unavailable");
  assertEquals(resolved.artifact.pdf_unavailable, true);
  assertEquals(resolved.artifact.signed_url, null);
  assertEquals(objectMeta(resolved.artifact).reason, "xero_draft_pdf_unavailable");
});

Deno.test("get_ses_reviewable_pack injects bound DRAFT Xero PDF and drops non-matching invoice pdf roles", async () => {
  const stored = await storeSesXeroInvoicePdfBytes(packClient().client, {
    job_id: JOB_ID,
    invoice: {
      xero_invoice_id: XERO_ID,
      invoice_number: "INV-1102",
      status: "DRAFT",
    },
    pdf: pdfBytes(),
  });
  const { client } = packClient({
    binding: stored,
    artifacts: [
      {
        role: "xero_invoice_pdf",
        object_key: "makesafe-docket-artifacts/job/2-Invoice-concoction.pdf",
        media_type: "application/pdf",
        content_hash: `sha256:${"b".repeat(64)}`,
        size_bytes: 12,
        metadata: {
          xero_invoice_id: "other-invoice",
          invoice_number: "INV-FAKE",
        },
      },
    ],
  });
  // Point the stored path through the client's sign helper: re-store is not
  // required because binding already carries the object key.
  const pack = await getSesReviewablePackAction(
    client,
    { mode: "api_key", user: null },
    DOCKET_ID,
    {
      fetchInvoicePdfBytes: async () => pdfBytes(),
    },
  );
  const invoicePdfs = (pack.artifacts || []).filter((a: any) =>
    a.role === "xero_invoice_pdf"
  );
  assertEquals(invoicePdfs.length, 1);
  assertEquals(invoicePdfs[0].pdf_unavailable, false);
  assertStringIncludes(String(invoicePdfs[0].signed_url), "signed.example.test");
  assertEquals(invoicePdfs[0].metadata.xero_invoice_id, XERO_ID);
  assertEquals(invoicePdfs[0].metadata.invoice_number, "INV-1102");
  // The concoction object key must not remain as the sole invoice artifact.
  assertEquals(
    String(invoicePdfs[0].object_key || "").includes("2-Invoice-concoction"),
    false,
  );
  assertEquals(pack.invoice_pdf?.pdf_unavailable, false);
  assertEquals(pack.invoice_pdf?.xero_invoice_id, XERO_ID);
  assertEquals(pack.invoice_pdf?.invoice_number, "INV-1102");
});

function objectMeta(artifact: Record<string, any>): Record<string, any> {
  return artifact.metadata && typeof artifact.metadata === "object"
    ? artifact.metadata
    : {};
}

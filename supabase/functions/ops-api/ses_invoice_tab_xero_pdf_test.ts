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
  getSesReviewablePackAction as getSesReviewablePackActionStrict,
  querySesReviewCockpitAction,
  resetSesDraftPdfFetchBackoff,
  resolveSesBoundDraftInvoicePdfArtifact,
  storeSesXeroInvoicePdfBytes,
} from "./ses_reporting_actions.ts";
import { sesSha256Bytes } from "./ses_docket_envelope.ts";
import { SES_WORKFLOW_CONTRACT_CANONICAL_HASH } from "./ses_workflow_registry.ts";

function getSesReviewablePackAction(
  ...args: Parameters<typeof getSesReviewablePackActionStrict>
) {
  const [client, auth, docketRevisionId, deps] = args;
  return getSesReviewablePackActionStrict(client, auth, docketRevisionId, {
    ...deps,
    assertWorkflowContract: deps?.assertWorkflowContract ||
      (async () => SES_WORKFLOW_CONTRACT_CANONICAL_HASH),
  });
}

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
  obligationState?: string;
  obligationReadError?: boolean;
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
    state: opts.obligationState || "create_executed",
  };
  const rows: Record<string, unknown> = {
    ses_docket_review_current: review,
    makesafe_docket_revisions: docket,
    makesafe_docket_revisions_current: docket,
    makesafe_readiness_current_v2: {
      readiness_revision: "readiness-fixture",
      dependency_generation: 1,
      ready: true,
      blockers: [],
    },
    makesafe_docket_artifacts: opts.artifacts || [],
    makesafe_invoice_obligation_revisions: obligation,
    makesafe_invoice_obligation_revisions_current: obligation,
    ses_docket_review_events: [],
    job_assignments: [],
    job_service_reports: [],
  };
  const uploads: Array<{ path: string; size: number }> = [];
  const signedPaths: string[] = [];
  const updates: Array<{
    table: string;
    payload: any;
    filters: Array<{ op: string; column: string; value: unknown }>;
  }> = [];
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
      const filters: Array<{ op: string; column: string; value: unknown }> = [];
      const query: any = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          filters.push({ op: "eq", column, value });
          return query;
        },
        in: (column: string, value: unknown) => {
          filters.push({ op: "in", column, value });
          return query;
        },
        order: () => query,
        limit: () => query,
        update: (payload: any) => {
          mode = "update";
          updatePayload = payload;
          return query;
        },
        maybeSingle: () => {
          if (mode === "update") {
            updates.push({ table, payload: updatePayload, filters });
            if (table.includes("obligation")) {
              Object.assign(obligation, updatePayload || {});
              Object.assign(
                obligation.xero_binding || {},
                updatePayload?.xero_binding || {},
              );
            }
            return Promise.resolve({
              data: { id: OBLIGATION_ID },
              error: null,
            });
          }
          if (opts.obligationReadError && table.includes("obligation")) {
            return Promise.resolve({
              data: null,
              error: { message: "obligation read exploded" },
            });
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
  return { client, uploads, signedPaths, updates, binding, obligation };
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

Deno.test("a stored binding PDF is re-fetched, never served as current", async () => {
  resetSesDraftPdfFetchBackoff();
  const staleBytes = new TextEncoder().encode("%PDF-1.4 yesterday's draft");
  const stored = await storeSesXeroInvoicePdfBytes(packClient().client, {
    job_id: JOB_ID,
    invoice: {
      xero_invoice_id: XERO_ID,
      invoice_number: "INV-1102",
      status: "DRAFT",
    },
    pdf: staleBytes,
  });
  const { client, signedPaths, uploads } = packClient({ binding: stored });
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
        ...stored,
      },
    },
    fetchInvoicePdfBytes: () => {
      fetchCalls++;
      return Promise.resolve(pdfBytes());
    },
  });
  // A DRAFT is editable in Xero until it is authorised, so the stored pointer
  // is re-proved against Xero on every read rather than trusted as current.
  assertEquals(fetchCalls, 1);
  assertEquals(resolved.source, "live_fetch");
  assertEquals(resolved.artifact.role, "xero_invoice_pdf");
  assertEquals(resolved.artifact.pdf_unavailable, false);
  assertEquals(
    resolved.artifact.content_hash !== stored.pdf_content_hash,
    true,
  );
  assertEquals(uploads.length, 1);
  assertStringIncludes(
    String(resolved.artifact.signed_url),
    "signed.example.test",
  );
  assertEquals(objectMeta(resolved.artifact).xero_invoice_id, XERO_ID);
  assertEquals(objectMeta(resolved.artifact).invoice_number, "INV-1102");
  assertEquals(signedPaths.length >= 1, true);
});

Deno.test("a stored binding PDF is withheld when the live re-fetch fails", async () => {
  resetSesDraftPdfFetchBackoff();
  const stored = await storeSesXeroInvoicePdfBytes(packClient().client, {
    job_id: JOB_ID,
    invoice: {
      xero_invoice_id: XERO_ID,
      invoice_number: "INV-1102",
      status: "DRAFT",
    },
    pdf: pdfBytes(),
  });
  const { client, signedPaths } = packClient({ binding: stored });
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
    fetchInvoicePdfBytes: () => {
      throw new Error("Xero PDF temporarily unavailable");
    },
  });
  // Honest unavailable beats serving stored bytes as though they were live.
  assertEquals(resolved.source, "unavailable");
  assertEquals(resolved.artifact.pdf_unavailable, true);
  assertEquals(resolved.artifact.signed_url, null);
  assertEquals(resolved.artifact.object_key, undefined);
  assertEquals(signedPaths.length, 0);
  resetSesDraftPdfFetchBackoff();
});

Deno.test("bound DRAFT without stored PDF live-fetches Xero bytes and never invents HTML", async () => {
  resetSesDraftPdfFetchBackoff();
  const { client, uploads, updates } = packClient();
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
    fetchInvoicePdfBytes: async () => {
      fetchCalls++;
      return pdfBytes();
    },
  });
  assertEquals(fetchCalls, 1);
  assertEquals(resolved.source, "live_fetch");
  assertEquals(resolved.artifact.role, "xero_invoice_pdf");
  assertEquals(resolved.artifact.pdf_unavailable, false);
  assertStringIncludes(
    String(resolved.artifact.signed_url),
    "signed.example.test",
  );
  assertEquals(uploads.length >= 1, true);
  assertStringIncludes(uploads[0].path, "xero-invoice-pdfs/");
  // The read-path stamp must carry the same guards as the mint-time binding.
  const stamp = updates.find((entry) => entry.table.includes("obligation"));
  assertEquals(!!stamp, true);
  assertEquals(
    stamp!.filters.some((f) =>
      f.op === "in" && f.column === "state" &&
      (f.value as string[]).includes("create_executed")
    ),
    true,
  );
  assertEquals(
    stamp!.filters.some((f) =>
      f.op === "eq" && f.column === "xero_binding->>xero_invoice_id" &&
      f.value === XERO_ID
    ),
    true,
  );
});

Deno.test("read-path stamp never overwrites an authorised obligation binding", async () => {
  resetSesDraftPdfFetchBackoff();
  const { client, updates } = packClient({
    obligationState: "authorised",
    binding: { status: "AUTHORISED" },
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
      },
    },
    fetchInvoicePdfBytes: () => Promise.resolve(pdfBytes()),
  });
  assertEquals(resolved.source, "live_fetch");
  assertEquals(
    updates.filter((entry) => entry.table.includes("obligation")).length,
    0,
  );
});

Deno.test("a failed live fetch is not retried on the next poll within the backoff window", async () => {
  resetSesDraftPdfFetchBackoff();
  const { client } = packClient();
  let fetchCalls = 0;
  const request = () =>
    resolveSesBoundDraftInvoicePdfArtifact(client, {
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
      fetchInvoicePdfBytes: () => {
        fetchCalls++;
        throw new Error("Xero PDF temporarily unavailable");
      },
    });
  const first = await request();
  const second = await request();
  assertEquals(fetchCalls, 1);
  assertEquals(first.source, "unavailable");
  assertEquals(second.source, "unavailable");
  assertEquals(second.artifact.pdf_unavailable, true);
  assertEquals(second.artifact.signed_url, null);
  assertEquals(
    objectMeta(second.artifact).reason,
    "xero_draft_pdf_fetch_cooling_down",
  );
  resetSesDraftPdfFetchBackoff();
});

Deno.test("bound DRAFT with unfetchable PDF reports unavailable — no fake artifact URL", async () => {
  resetSesDraftPdfFetchBackoff();
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
    fetchInvoicePdfBytes: async () => {
      throw new Error("Xero PDF temporarily unavailable");
    },
  });
  assertEquals(resolved.source, "unavailable");
  assertEquals(resolved.artifact.pdf_unavailable, true);
  assertEquals(resolved.artifact.signed_url, null);
  assertEquals(
    objectMeta(resolved.artifact).reason,
    "xero_draft_pdf_unavailable",
  );
});

Deno.test("get_ses_reviewable_pack injects bound DRAFT Xero PDF and drops non-matching invoice pdf roles", async () => {
  resetSesDraftPdfFetchBackoff();
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
  assertStringIncludes(
    String(invoicePdfs[0].signed_url),
    "signed.example.test",
  );
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
  // The displaced concoction is accounted for, never silently dropped.
  const displaced = (pack.suppressed_artifacts || []).filter((a: any) =>
    a.role === "xero_invoice_pdf"
  );
  assertEquals(displaced.length, 1);
  assertEquals(
    displaced[0].suppression_reason,
    "xero_invoice_pdf_not_bound_draft",
  );
  assertEquals(displaced[0].signed_url, null);
  assertStringIncludes(
    String(displaced[0].object_key),
    "2-Invoice-concoction",
  );
});

Deno.test("cockpit freezes the live DRAFT PDF hash while availability follows the pack projection", async () => {
  // A legacy DRAFT binding may carry no stored pointer, but once its live PDF
  // is fetched the cockpit must expose the exact reviewed hash for Option B.
  resetSesDraftPdfFetchBackoff();
  const reachable = packClient();
  const shown = await querySesReviewCockpitAction(
    reachable.client,
    JOB_ID,
    undefined,
    undefined,
    { fetchInvoicePdfBytes: () => Promise.resolve(pdfBytes()) },
  );
  const shownBound = (shown.sections.money as any).bound_invoice;
  assertEquals(shownBound.xero_invoice_id, XERO_ID);
  assertEquals(shownBound.pdf_content_hash, await sesSha256Bytes(pdfBytes()));
  assertEquals(shownBound.pdf_available, true);
  const shownPack = await getSesReviewablePackAction(
    reachable.client,
    { mode: "api_key", user: null },
    DOCKET_ID,
    { fetchInvoicePdfBytes: () => Promise.resolve(pdfBytes()) },
  );
  assertEquals(shownPack.invoice_pdf?.pdf_unavailable, false);

  resetSesDraftPdfFetchBackoff();
  const unreachable = packClient();
  const withheld = await querySesReviewCockpitAction(
    unreachable.client,
    JOB_ID,
    undefined,
    undefined,
    {
      fetchInvoicePdfBytes: () => {
        throw new Error("Xero PDF temporarily unavailable");
      },
    },
  );
  const withheldBound = (withheld.sections.money as any).bound_invoice;
  assertEquals(withheldBound.xero_invoice_id, XERO_ID);
  assertEquals(withheldBound.pdf_available, false);
  const withheldPack = await getSesReviewablePackAction(
    unreachable.client,
    { mode: "api_key", user: null },
    DOCKET_ID,
    {
      fetchInvoicePdfBytes: () => {
        throw new Error("Xero PDF temporarily unavailable");
      },
    },
  );
  assertEquals(withheldPack.invoice_pdf?.pdf_unavailable, true);
  resetSesDraftPdfFetchBackoff();
});

Deno.test("an AUTHORISED bind proves its PDF from the docket artifact, without a Xero fetch", async () => {
  // The other half of the availability ruling: an authorised invoice's real
  // rendered PDF is already a docket artifact, so the tab may claim it without
  // spending a Xero call. A non-matching artifact proves nothing.
  resetSesDraftPdfFetchBackoff();
  const boundArtifact = {
    role: "xero_invoice_pdf",
    object_key: "makesafe-docket-artifacts/job/authorised-INV-1102.pdf",
    media_type: "application/pdf",
    content_hash: `sha256:${"c".repeat(64)}`,
    size_bytes: 2048,
    metadata: { xero_invoice_id: XERO_ID, invoice_number: "INV-1102" },
  };
  let fetches = 0;
  const countingFetch = () => {
    fetches++;
    return Promise.resolve(pdfBytes());
  };
  const bound = packClient({
    binding: { status: "AUTHORISED" },
    artifacts: [boundArtifact],
  });
  const shown = await querySesReviewCockpitAction(
    bound.client,
    JOB_ID,
    undefined,
    undefined,
    { fetchInvoicePdfBytes: countingFetch },
  );
  const shownBound = (shown.sections.money as any).bound_invoice;
  assertEquals(shownBound.status, "AUTHORISED");
  assertEquals(shownBound.pdf_content_hash, null);
  assertEquals(shownBound.pdf_available, true);
  assertEquals(fetches, 0);

  // A stored hash with no matching artifact must not claim a document.
  const unbound = packClient({
    binding: {
      status: "AUTHORISED",
      pdf_content_hash: `sha256:${"d".repeat(64)}`,
    },
    artifacts: [{
      ...boundArtifact,
      metadata: { xero_invoice_id: "some-other-invoice" },
    }],
  });
  const withheld = await querySesReviewCockpitAction(
    unbound.client,
    JOB_ID,
    undefined,
    undefined,
    { fetchInvoicePdfBytes: countingFetch },
  );
  const withheldBound = (withheld.sections.money as any).bound_invoice;
  assertEquals(withheldBound.pdf_available, false);
  assertEquals(fetches, 0);
});

Deno.test("an unreadable obligation refuses the pack instead of degrading to the local proposal", async () => {
  resetSesDraftPdfFetchBackoff();
  const { client } = packClient({ obligationReadError: true });
  let status = 0;
  try {
    await getSesReviewablePackAction(
      client,
      { mode: "api_key", user: null },
      DOCKET_ID,
      { fetchInvoicePdfBytes: () => Promise.resolve(pdfBytes()) },
    );
  } catch (error) {
    status = Number((error as any).status);
    assertStringIncludes(String((error as Error).message), "obligation");
  }
  assertEquals(status, 503);
});

function objectMeta(artifact: Record<string, any>): Record<string, any> {
  return artifact.metadata && typeof artifact.metadata === "object"
    ? artifact.metadata
    : {};
}

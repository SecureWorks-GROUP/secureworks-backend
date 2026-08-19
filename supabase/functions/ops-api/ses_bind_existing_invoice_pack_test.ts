// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  canBindExistingMakesafeInvoicePack,
  selectExistingInvoiceForPackBind,
  selectNamedPriorCycleBoundInvoiceForPlacement,
  SesBindExistingInvoiceError,
} from "./ses_bind_existing_invoice_pack.ts";
import {
  _bindExistingInvoicePackStrictForTest,
  _bindExistingMakesafeInvoicePackForTest,
} from "./index.ts";

const JOB_ID = "job-26740";
const job = {
  id: JOB_ID,
  job_number: "SWMS-26740",
  metadata: { external_ref: "MLB-26740" },
};
const detail = {
  external_ref: "MLB-26740",
  reattend_count: 0,
  last_reattend_at: null,
};

Deno.test("bind-only route permits privileged ops and scoped routine credentials only", () => {
  assertEquals(canBindExistingMakesafeInvoicePack("api_key"), true);
  assertEquals(canBindExistingMakesafeInvoicePack("routine"), true);
  assertEquals(canBindExistingMakesafeInvoicePack("agent_read"), false);
  assertEquals(canBindExistingMakesafeInvoicePack("jwt"), false);
});

function invoice(over: Record<string, unknown> = {}) {
  return {
    xero_invoice_id: "xero-0817",
    invoice_number: "INV-0817",
    job_id: JOB_ID,
    invoice_type: "ACCREC",
    status: "DRAFT",
    reference: "MLB-26740",
    created_at: "2026-08-01T00:00:00Z",
    invoice_date: "2026-08-01",
    ...over,
  };
}

for (const status of ["DRAFT", "AUTHORISED", "PAID"]) {
  Deno.test(`bind-only selects exact current-card ${status} without lifecycle mutation`, () => {
    const selected = selectExistingInvoiceForPackBind({
      job,
      detail,
      invoices: [invoice({ status })],
      expected_invoice_number: "inv-0817",
    });
    assertEquals(selected.xero_invoice_id, "xero-0817");
    assertEquals(selected.status, status);
    assertEquals(selected.named_prior_cycle_bind, false);
  });
}

function refusalCode(rows: any[], expected = "INV-0817"): string {
  const error = assertThrows(
    () =>
      selectExistingInvoiceForPackBind({
        job,
        detail,
        invoices: rows,
        expected_invoice_number: expected,
      }),
    SesBindExistingInvoiceError,
  );
  return error.code;
}

Deno.test("bind-only refuses absence instead of minting a replacement", () => {
  assertEquals(refusalCode([]), "named_invoice_not_found");
});

Deno.test("bind-only refuses duplicate invoice-number rows", () => {
  assertEquals(
    refusalCode([invoice(), invoice({ xero_invoice_id: "xero-other" })]),
    "named_invoice_ambiguous",
  );
});

Deno.test("bind-only refuses reference-only and foreign-job matches", () => {
  assertEquals(
    refusalCode([invoice({ job_id: null })]),
    "named_invoice_wrong_job",
  );
  assertEquals(
    refusalCode([invoice({ job_id: "job-other" })]),
    "named_invoice_wrong_job",
  );
});

Deno.test("bind-only refuses wrong type, reference, and lifecycle", () => {
  assertEquals(
    refusalCode([invoice({ invoice_type: "ACCPAY" })]),
    "named_invoice_wrong_type",
  );
  assertEquals(
    refusalCode([invoice({ reference: "MLB-OTHER" })]),
    "named_invoice_not_current_card_receivable",
  );
  assertEquals(
    refusalCode([invoice({ status: "SUBMITTED" })]),
    "named_invoice_status_unsupported",
  );
});

Deno.test("bind-only allows the exact Captain-named prior-cycle invoice", () => {
  const selected = selectExistingInvoiceForPackBind({
    job,
    detail: {
      ...detail,
      reattend_count: 1,
      last_reattend_at: "2026-08-10T00:00:00Z",
    },
    invoices: [
      invoice({ created_at: "2026-08-01T00:00:00Z" }),
      invoice({
        xero_invoice_id: "xero-current",
        invoice_number: "INV-0999",
        created_at: "2026-08-12T00:00:00Z",
        invoice_date: "2026-08-12",
      }),
    ],
    expected_invoice_number: "INV-0817",
  });
  assertEquals(selected.xero_invoice_id, "xero-0817");
  assertEquals(selected.named_prior_cycle_bind, true);
});

Deno.test("bind-only still refuses unknown cycle attribution", () => {
  const error = assertThrows(
    () =>
      selectExistingInvoiceForPackBind({
        job,
        detail: {
          ...detail,
          reattend_count: 1,
          last_reattend_at: null,
        },
        invoices: [invoice()],
        expected_invoice_number: "INV-0817",
      }),
    SesBindExistingInvoiceError,
  );
  assertEquals(error.code, "named_invoice_not_current_card_receivable");
});

Deno.test("placement accepts only the exact durable named prior-cycle adoption", () => {
  const priorDetail = {
    ...detail,
    reattend_count: 4,
    last_reattend_at: "2026-08-06T00:00:00Z",
  };
  const pack = {
    xero_invoice_id: "xero-1140",
    invoice_doc_id: "invoice-doc-1140",
  };
  const document = {
    id: "invoice-doc-1140",
    job_id: JOB_ID,
    type: "invoice",
    bind_source: "bind_existing_makesafe_invoice_pack",
    bind_only: true,
    named_prior_cycle_bind: true,
    bound_xero_invoice_id: "xero-1140",
  };
  const bound = invoice({
    xero_invoice_id: "xero-1140",
    invoice_number: "INV-1140",
    created_at: "2026-08-05T00:00:00Z",
  });

  assertEquals(
    selectNamedPriorCycleBoundInvoiceForPlacement({
      job,
      detail: priorDetail,
      pack,
      documents: [document],
      invoices: [bound],
    })?.invoice_number,
    "INV-1140",
  );

  for (
    const [label, mutation] of [
      ["unnamed", { named_prior_cycle_bind: false }],
      ["wrong source", { bind_source: "other" }],
      ["not bind-only", { bind_only: false }],
      ["wrong document", { id: "other-doc" }],
      ["wrong invoice", { bound_xero_invoice_id: "xero-other" }],
    ] as const
  ) {
    assertEquals(
      selectNamedPriorCycleBoundInvoiceForPlacement({
        job,
        detail: priorDetail,
        pack,
        documents: [{ ...document, ...mutation }],
        invoices: [bound],
      }),
      null,
      label,
    );
  }

  for (const status of ["VOIDED", "DELETED"]) {
    assertEquals(
      selectNamedPriorCycleBoundInvoiceForPlacement({
        job,
        detail: priorDetail,
        pack,
        documents: [document],
        invoices: [{ ...bound, status }],
      }),
      null,
      status,
    );
  }
});

Deno.test("bind-only refuses an older named invoice when another row is current", () => {
  const older = invoice({
    xero_invoice_id: "xero-old",
    invoice_number: "INV-0817",
    invoice_date: "2026-08-01",
  });
  const current = invoice({
    xero_invoice_id: "xero-current",
    invoice_number: "INV-0999",
    invoice_date: "2026-08-12",
  });
  assertEquals(
    refusalCode([older, current]),
    "named_invoice_not_current_receivable",
  );
});

Deno.test("bind-only ranks PAID above AUTHORISED above DRAFT before recency", () => {
  for (
    const [preferred, lower] of [
      ["PAID", "AUTHORISED"],
      ["PAID", "DRAFT"],
      ["AUTHORISED", "DRAFT"],
    ] as const
  ) {
    const selected = selectExistingInvoiceForPackBind({
      job,
      detail,
      invoices: [
        invoice({
          status: preferred,
          invoice_date: "2026-08-01",
          created_at: "2026-08-01T00:00:00Z",
        }),
        invoice({
          xero_invoice_id: "xero-newer-lower-priority",
          invoice_number: "INV-0999",
          status: lower,
          invoice_date: "2026-08-12",
          created_at: "2026-08-12T00:00:00Z",
        }),
      ],
      expected_invoice_number: "INV-0817",
    });
    assertEquals(selected.invoice_number, "INV-0817", `${preferred}>${lower}`);
    assertEquals(selected.status, preferred, `${preferred}>${lower}`);
  }
});

Deno.test("bind-only keeps SUBMITTED as a blocker instead of exposing a newer DRAFT", () => {
  assertEquals(
    refusalCode([
      invoice({
        xero_invoice_id: "xero-submitted",
        invoice_number: "INV-0817",
        status: "SUBMITTED",
        invoice_date: "2026-08-01",
      }),
      invoice({
        xero_invoice_id: "xero-newer-draft",
        invoice_number: "INV-0999",
        status: "DRAFT",
        invoice_date: "2026-08-12",
      }),
    ], "INV-0999"),
    "named_invoice_not_current_receivable",
  );
});

Deno.test("bind-only current-cycle selection does not revive known prior-cycle paid money", () => {
  const selected = selectExistingInvoiceForPackBind({
    job,
    detail: {
      ...detail,
      reattend_count: 1,
      last_reattend_at: "2026-08-10T00:00:00Z",
    },
    invoices: [
      invoice({
        xero_invoice_id: "xero-prior-paid",
        invoice_number: "INV-0817",
        status: "PAID",
        invoice_date: "2026-08-01",
        created_at: "2026-08-01T00:00:00Z",
      }),
      invoice({
        xero_invoice_id: "xero-current-draft",
        invoice_number: "INV-0999",
        status: "DRAFT",
        invoice_date: "2026-08-12",
        created_at: "2026-08-12T00:00:00Z",
      }),
    ],
    expected_invoice_number: "INV-0999",
  });
  assertEquals(selected.xero_invoice_id, "xero-current-draft");
  assertEquals(selected.named_prior_cycle_bind, false);
});

Deno.test("bind-only ignores newer DELETED and VOIDED rows when selecting the named live invoice", () => {
  for (const status of ["DELETED", "VOIDED"]) {
    const selected = selectExistingInvoiceForPackBind({
      job,
      detail,
      invoices: [
        invoice({ status: "AUTHORISED", invoice_date: "2026-08-01" }),
        invoice({
          xero_invoice_id: `xero-${status.toLowerCase()}`,
          invoice_number: `INV-${status}`,
          status,
          invoice_date: "2026-08-12",
          created_at: "2026-08-12T00:00:00Z",
        }),
      ],
      expected_invoice_number: "INV-0817",
    });
    assertEquals(selected.invoice_number, "INV-0817", status);
  }
});

function actionClient(
  packOverrides: Record<string, unknown> = {},
  detailOverrides: Record<string, unknown> = {},
  jobEventRows: any[] = [],
  extraRows: Record<string, any> = {},
) {
  const rows: Record<string, any> = {
    jobs: { data: job, error: null },
    makesafe_job_details: {
      data: {
        ...detail,
        job_id: JOB_ID,
        attendance_cycle_id: "cycle-26740",
        ...detailOverrides,
      },
      error: null,
    },
    makesafe_report_packs: {
      data: {
        id: "pack-26740",
        status: "drafted",
        sent_at: null,
        send_started_at: null,
        failed_step: null,
        xero_invoice_id: null,
        invoice_doc_id: null,
        ...packOverrides,
      },
      error: null,
    },
    xero_invoices: { data: null, error: null },
    ...extraRows,
  };
  return {
    from(table: string) {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => rows[table],
        insert: async (values: any) => {
          if (table === "job_events") jobEventRows.push(values);
          return { data: null, error: null };
        },
      };
      return chain;
    },
  };
}

Deno.test("SWMS-26740 bind-only action attaches INV-0817 and dispatches no money or send", async () => {
  const calls = { attach: 0, ensure: 0, bind: 0 };
  const result = await _bindExistingMakesafeInvoicePackForTest(
    actionClient() as any,
    {
      job_id: JOB_ID,
      invoice_number: "INV-0817",
      actor: "captain@test",
    },
    {
      fetchAllAccrecInvoices: async () => [invoice()],
      fetchInvoicePdfBytes: async () => new Uint8Array([37, 80, 68, 70]),
      attachDocument: async (_client: any, body: any) => {
        calls.attach++;
        assertEquals(body.type, "invoice");
        assertEquals(body.file_name, "Xero Invoice - INV-0817.pdf");
        return {
          success: true,
          document_id: "invoice-doc-0817",
          type: "invoice",
          url: "https://example.test/invoice.pdf",
        };
      },
      ensurePack: async () => {
        calls.ensure++;
      },
      bindPack: async (
        _client: any,
        _jobId: string,
        selectedInvoice: any,
        invoiceDocId: string,
      ) => {
        calls.bind++;
        assertEquals(selectedInvoice.xero_invoice_id, "xero-0817");
        assertEquals(selectedInvoice.status, "DRAFT");
        assertEquals(invoiceDocId, "invoice-doc-0817");
      },
    },
  );
  assertEquals(calls, { attach: 1, ensure: 1, bind: 1 });
  assertEquals(result.state, "existing_invoice_pack_bound");
  assertEquals(result.dry_run, false);
  assertEquals(result.persisted, true);
  assertEquals(result.would_do, null);
  assertEquals(result.would_refuse, null);
  assertEquals(result.lineage_required, false);
  assertEquals(result.invoice_create_dispatched, false);
  assertEquals(result.invoice_authorise_dispatched, false);
  assertEquals(result.send_dispatched, false);
  assertEquals(result.external_mutations, { xero: 0, email: 0 });
});

Deno.test("dry_run previews bind without document, pack, or event writes", async () => {
  const calls = { attach: 0, ensure: 0, bind: 0, pdf: 0 };
  const jobEvents: any[] = [];
  const result = await _bindExistingMakesafeInvoicePackForTest(
    actionClient({}, {
      reattend_count: 4,
      last_reattend_at: "2026-08-06T00:00:00Z",
    }, jobEvents) as any,
    {
      job_id: JOB_ID,
      invoice_number: "INV-1140",
      actor: "captain@test",
      dry_run: true,
    },
    {
      fetchAllAccrecInvoices: async () => [invoice({
        xero_invoice_id: "xero-1140",
        invoice_number: "INV-1140",
        created_at: "2026-08-05T00:00:00Z",
      })],
      fetchInvoicePdfBytes: async () => {
        calls.pdf++;
        return new Uint8Array([37, 80, 68, 70]);
      },
      attachDocument: async () => {
        calls.attach++;
        return {
          success: true,
          document_id: "unexpected",
          type: "invoice",
          url: "https://example.test/unexpected.pdf",
        };
      },
      ensurePack: async () => {
        calls.ensure++;
      },
      bindPack: async () => {
        calls.bind++;
      },
    },
  );

  assertEquals(calls, { attach: 0, ensure: 0, bind: 0, pdf: 1 });
  assertEquals(jobEvents, []);
  assertEquals(result.success, true);
  assertEquals(result.dry_run, true);
  assertEquals(result.persisted, false);
  assertEquals(result.state, "would_bind_existing_invoice_pack");
  assertEquals(result.would_refuse, null);
  assertEquals(result.would_do, {
    attach_invoice_document: {
      type: "invoice",
      file_name: "Xero Invoice - INV-1140.pdf",
      xero_invoice_id: "xero-1140",
      invoice_number: "INV-1140",
      invoice_status: "DRAFT",
      named_prior_cycle_bind: true,
    },
    ensure_main_pack: true,
    bind_pack: {
      xero_invoice_id: "xero-1140",
      invoice_status: "DRAFT",
    },
    audit_named_prior_cycle_bind: true,
  });
  assertEquals(result.invoice.document_id, null);
  assertEquals(result.invoice.pdf_bytes, 4);
  assertEquals(result.invoice_create_dispatched, false);
  assertEquals(result.invoice_authorise_dispatched, false);
  assertEquals(result.send_dispatched, false);
  assertEquals(result.external_mutations, { xero: 0, email: 0 });
});

Deno.test("dry_run returns would_refuse for pack send-state without writes", async () => {
  const writes: string[] = [];
  const result = await _bindExistingMakesafeInvoicePackForTest(
    actionClient({
      status: "failed",
      failed_step: "money_review_gate",
    }) as any,
    {
      job_id: JOB_ID,
      invoice_number: "INV-0817",
      actor: "captain@test",
      dry_run: true,
    },
    {
      fetchAllAccrecInvoices: async () => {
        writes.push("accrec");
        return [invoice()];
      },
      attachDocument: async () => {
        writes.push("attach");
        return { document_id: "unexpected" } as any;
      },
    },
  );

  assertEquals(writes, []);
  assertEquals(result.success, false);
  assertEquals(result.dry_run, true);
  assertEquals(result.persisted, false);
  assertEquals(result.state, "would_refuse");
  assertEquals(result.would_do, null);
  assertEquals(result.would_refuse.code, "pack_send_state_blocks_bind");
  assertEquals(result.would_refuse.status, 409);
  assertEquals(
    String(result.would_refuse.message).includes(
      "refuses pack status 'failed'",
    ),
    true,
  );
});

Deno.test("dry_run returns would_refuse for named-invoice selection failures", async () => {
  const writes: string[] = [];
  const result = await _bindExistingMakesafeInvoicePackForTest(
    actionClient() as any,
    {
      job_id: JOB_ID,
      invoice_number: "INV-9999",
      actor: "captain@test",
      dry_run: true,
    },
    {
      fetchAllAccrecInvoices: async () => [invoice()],
      fetchInvoicePdfBytes: async () => {
        writes.push("pdf");
        return new Uint8Array([37, 80, 68, 70]);
      },
      attachDocument: async () => {
        writes.push("attach");
        return { document_id: "unexpected" } as any;
      },
    },
  );

  assertEquals(writes, []);
  assertEquals(result.success, false);
  assertEquals(result.dry_run, true);
  assertEquals(result.persisted, false);
  assertEquals(result.state, "would_refuse");
  assertEquals(result.would_refuse.code, "named_invoice_not_found");
});

Deno.test("dry_run already-bound path reports persisted:false and no writes", async () => {
  const writes: string[] = [];
  const result = await _bindExistingMakesafeInvoicePackForTest(
    actionClient({
      xero_invoice_id: "xero-0817",
      invoice_doc_id: "invoice-doc-0817",
    }) as any,
    {
      job_id: JOB_ID,
      invoice_number: "INV-0817",
      actor: "captain@test",
      dry_run: true,
    },
    {
      fetchAllAccrecInvoices: async () => [invoice()],
      fetchInvoicePdfBytes: async () => {
        writes.push("pdf");
        return new Uint8Array();
      },
      attachDocument: async () => {
        writes.push("attach");
        return { document_id: "unexpected" } as any;
      },
    },
  );

  assertEquals(writes, []);
  assertEquals(result.success, true);
  assertEquals(result.dry_run, true);
  assertEquals(result.persisted, false);
  assertEquals(result.state, "existing_invoice_pack_already_bound");
  assertEquals(result.would_do, null);
  assertEquals(result.would_refuse, null);
  assertEquals(result.invoice.document_id, "invoice-doc-0817");
});

Deno.test("named prior-cycle bind records the exception without minting or sending", async () => {
  const calls = { attach: 0, ensure: 0, bind: 0 };
  let snapshot: Record<string, unknown> = {};
  const jobEvents: any[] = [];
  const result = await _bindExistingMakesafeInvoicePackForTest(
    actionClient({}, {
      reattend_count: 4,
      last_reattend_at: "2026-08-06T00:00:00Z",
    }, jobEvents) as any,
    {
      job_id: JOB_ID,
      invoice_number: "INV-1140",
      actor: "captain@test",
    },
    {
      fetchAllAccrecInvoices: async () => [invoice({
        xero_invoice_id: "xero-1140",
        invoice_number: "INV-1140",
        created_at: "2026-08-05T00:00:00Z",
      })],
      fetchInvoicePdfBytes: async () => new Uint8Array([37, 80, 68, 70]),
      attachDocument: async (_client: any, _body: any, options: any) => {
        calls.attach++;
        snapshot = options.data_snapshot_json;
        return {
          success: true,
          document_id: "invoice-doc-1140",
          type: "invoice",
          url: "https://example.test/invoice.pdf",
        };
      },
      ensurePack: async () => {
        calls.ensure++;
      },
      bindPack: async () => {
        calls.bind++;
      },
    },
  );

  assertEquals(calls, { attach: 1, ensure: 1, bind: 1 });
  assertEquals(jobEvents, [{
    job_id: JOB_ID,
    event_type: "named_prior_cycle_bind",
    detail_json: {
      source: "bind_existing_makesafe_invoice_pack",
      actor: "captain@test",
      xero_invoice_id: "xero-1140",
      invoice_number: "INV-1140",
      invoice_status: "DRAFT",
      bind_only: true,
    },
  }]);
  assertEquals(snapshot.named_prior_cycle_bind, true);
  assertEquals(result.named_prior_cycle_bind, true);
  assertEquals(result.invoice_create_dispatched, false);
  assertEquals(result.invoice_authorise_dispatched, false);
  assertEquals(result.send_dispatched, false);
  assertEquals(result.external_mutations, { xero: 0, email: 0 });
});

Deno.test("bind-only PDF failure writes no document or pack", async () => {
  const writes: string[] = [];
  let message = "";
  try {
    await _bindExistingMakesafeInvoicePackForTest(
      actionClient() as any,
      {
        job_id: JOB_ID,
        invoice_number: "INV-0817",
        actor: "captain@test",
      },
      {
        fetchAllAccrecInvoices: async () => [invoice()],
        fetchInvoicePdfBytes: async () => {
          throw new Error("Xero unavailable");
        },
        attachDocument: async () => {
          writes.push("attach");
          return {
            success: true,
            document_id: "unexpected",
            type: "invoice",
            url: "https://example.test/unexpected.pdf",
          };
        },
        ensurePack: async () => {
          writes.push("ensure");
        },
        bindPack: async () => {
          writes.push("bind");
        },
      },
    );
  } catch (error) {
    message = (error as Error).message;
  }
  assertEquals(writes, []);
  assertEquals(message.includes("exact Xero PDF could not be fetched"), true);
});

Deno.test("bind-only refuses failed packs without clearing their failure", async () => {
  let fetched = false;
  let message = "";
  try {
    await _bindExistingMakesafeInvoicePackForTest(
      actionClient({
        status: "failed",
        failed_step: "money_review_gate",
      }) as any,
      {
        job_id: JOB_ID,
        invoice_number: "INV-0817",
        actor: "captain@test",
      },
      {
        fetchAllAccrecInvoices: async () => {
          fetched = true;
          return [invoice()];
        },
      },
    );
  } catch (error) {
    message = (error as Error).message;
  }
  assertEquals(fetched, false);
  assertEquals(message.includes("refuses pack status 'failed'"), true);
});

Deno.test("bind-only refuses a divergent pack invoice before PDF or document writes", async () => {
  const writes: string[] = [];
  let message = "";
  try {
    await _bindExistingMakesafeInvoicePackForTest(
      actionClient({ xero_invoice_id: "xero-other" }) as any,
      {
        job_id: JOB_ID,
        invoice_number: "INV-0817",
        actor: "captain@test",
      },
      {
        fetchAllAccrecInvoices: async () => [invoice()],
        fetchInvoicePdfBytes: async () => {
          writes.push("pdf");
          return new Uint8Array([37, 80, 68, 70]);
        },
        attachDocument: async () => {
          writes.push("attach");
          return { document_id: "unexpected" } as any;
        },
      },
    );
  } catch (error) {
    message = (error as Error).message;
  }
  assertEquals(writes, []);
  assertEquals(message.includes("refuses to replace pack invoice"), true);
});

Deno.test("bind-only replaces a DELETED pack invoice with the reminted DRAFT", async () => {
  const calls = { attach: 0, bind: 0, replaceableFromId: "" };
  const result = await _bindExistingMakesafeInvoicePackForTest(
    actionClient(
      { xero_invoice_id: "xero-old" },
      {},
      [],
      {
        xero_invoices: { data: { status: "DELETED" }, error: null },
      },
    ) as any,
    {
      job_id: JOB_ID,
      invoice_number: "INV-0817",
      actor: "captain@test",
    },
    {
      fetchAllAccrecInvoices: async () => [invoice()],
      fetchInvoicePdfBytes: async () => new Uint8Array([37, 80, 68, 70]),
      attachDocument: async () => {
        calls.attach++;
        return { document_id: "invoice-doc-0817" } as any;
      },
      ensurePack: async () => {},
      bindPack: async (
        _client: any,
        _jobId: string,
        _selected: any,
        _docId: string,
        replaceableFromId?: string,
      ) => {
        calls.bind++;
        calls.replaceableFromId = String(replaceableFromId || "");
      },
    },
  );
  assertEquals(calls.attach, 1);
  assertEquals(calls.bind, 1);
  assertEquals(calls.replaceableFromId, "xero-old");
  assertEquals(result.send_dispatched, false);
  assertEquals(result.invoice_authorise_dispatched, false);
});

Deno.test("bind-only is idempotent for the same already-bound invoice", async () => {
  const writes: string[] = [];
  const result = await _bindExistingMakesafeInvoicePackForTest(
    actionClient({
      xero_invoice_id: "xero-0817",
      invoice_doc_id: "invoice-doc-0817",
    }) as any,
    {
      job_id: JOB_ID,
      invoice_number: "INV-0817",
      actor: "captain@test",
    },
    {
      fetchAllAccrecInvoices: async () => [invoice()],
      fetchInvoicePdfBytes: async () => {
        writes.push("pdf");
        return new Uint8Array();
      },
      attachDocument: async () => {
        writes.push("attach");
        return { document_id: "unexpected" } as any;
      },
      ensurePack: async () => {
        writes.push("ensure");
      },
      bindPack: async () => {
        writes.push("bind");
      },
    },
  );
  assertEquals(writes, []);
  assertEquals(result.state, "existing_invoice_pack_already_bound");
  assertEquals(result.invoice.document_id, "invoice-doc-0817");
});

Deno.test("bind-only pack update loses cleanly to a concurrent send lock", async () => {
  const filters: Array<[string, unknown]> = [];
  const chain: any = {
    update: () => chain,
    eq: (column: string, value: unknown) => {
      filters.push([`eq:${column}`, value]);
      return chain;
    },
    in: (column: string, value: unknown) => {
      filters.push([`in:${column}`, value]);
      return chain;
    },
    is: (column: string, value: unknown) => {
      filters.push([`is:${column}`, value]);
      return chain;
    },
    or: (value: string) => {
      filters.push(["or", value]);
      return chain;
    },
    select: async () => ({ data: [], error: null }),
  };
  let message = "";
  try {
    await _bindExistingInvoicePackStrictForTest(
      { from: () => chain } as any,
      JOB_ID,
      invoice() as any,
      "invoice-doc-0817",
    );
  } catch (error) {
    message = (error as Error).message;
  }
  assertEquals(message.includes("entered send state"), true);
  assertEquals(
    filters.some(([key, value]) => key === "is:sent_at" && value === null),
    true,
  );
  assertEquals(
    filters.some(([key, value]) =>
      key === "is:send_started_at" && value === null
    ),
    true,
  );
  assertEquals(
    filters.some(([key, value]) =>
      key === "in:status" && Array.isArray(value) &&
      !value.includes("failed") && !value.includes("sending")
    ),
    true,
  );
});

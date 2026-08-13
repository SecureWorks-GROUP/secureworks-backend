// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  canBindExistingMakesafeInvoicePack,
  selectExistingInvoiceForPackBind,
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

Deno.test("bind-only prior-cycle boundary fails closed", () => {
  const error = assertThrows(
    () =>
      selectExistingInvoiceForPackBind({
        job,
        detail: {
          ...detail,
          reattend_count: 1,
          last_reattend_at: "2026-08-10T00:00:00Z",
        },
        invoices: [invoice({ created_at: "2026-08-01T00:00:00Z" })],
        expected_invoice_number: "INV-0817",
      }),
    SesBindExistingInvoiceError,
  );
  assertEquals(error.code, "named_invoice_not_current_card_receivable");
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

function actionClient(packOverrides: Record<string, unknown> = {}) {
  const rows: Record<string, any> = {
    jobs: { data: job, error: null },
    makesafe_job_details: {
      data: { ...detail, job_id: JOB_ID, attendance_cycle_id: "cycle-26740" },
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
  };
  return {
    from(table: string) {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => rows[table],
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
  assertEquals(result.lineage_required, false);
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

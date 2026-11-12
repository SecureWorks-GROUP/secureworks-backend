import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type SesEffectClaim,
  type SesEffectState,
  type SesExternalEffect,
  type SesExternalEffectStore,
} from "./ses_external_effects.ts";
import {
  assertRestorationInvoiceSendable,
  resolveRestorationRecipient,
  restorationSendBody,
  restorationSendSubject,
  sendRestorationDocumentAction,
} from "./restoration_send.ts";
import { SesActionError } from "./ses_reporting_actions.ts";

const JOB_ID = "b94fe335-6047-43eb-bd8c-a6df770eb505";
const AMBER = "coordinator@builder.example";
const PDF = new TextEncoder().encode("%PDF-1.4\n% restoration-send-test\n%%EOF\n");

class MemoryEffectStore implements SesExternalEffectStore {
  row: SesExternalEffect | null = null;
  dispatches = 0;
  claim(effect: Omit<SesExternalEffect, "state">, _owner: string): Promise<SesEffectClaim> {
    if (!this.row) {
      this.row = { ...effect, state: "reserved", id: "effect-1" };
      return Promise.resolve({ effect: { ...this.row }, claim_mode: "dispatch", duplicate_refused: false });
    }
    return Promise.resolve({
      effect: { ...this.row },
      claim_mode: this.row.state === "confirmed" ? "confirmed" : "reconcile",
      duplicate_refused: true,
    });
  }
  transition(
    operationKey: string,
    from: SesEffectState,
    to: SesEffectState,
    _eventKind: string,
    detail: Record<string, unknown>,
    _actor: string,
  ): Promise<SesExternalEffect> {
    if (!this.row || this.row.operation_key !== operationKey || this.row.state !== from) {
      return Promise.reject(new Error("bad transition"));
    }
    this.row = {
      ...this.row,
      state: to,
      external_id: String(detail.external_id || this.row.external_id || "") || null,
      provider_digest: (detail.provider_digest as Record<string, unknown>) || this.row.provider_digest,
    };
    if (to === "dispatching") this.dispatches++;
    return Promise.resolve({ ...this.row });
  }
}

type Row = Record<string, unknown>;

function makeClient(opts: {
  family?: string;
  invoiceStatus?: string;
  invoiceJobId?: string;
  recipients?: string[];
  quoteDoc?: boolean;
} = {}) {
  const tables: Record<string, Row[]> = {
    jobs: [{
      id: JOB_ID,
      org_id: "00000000-0000-0000-0000-000000000001",
      type: "makesafe",
      job_number: "SWMS-261709",
      status: "in_progress",
      metadata: { makesafe_job_family: opts.family ?? "restoration" },
      site_address: "18A Devon Way",
      site_suburb: "Lynwood",
    }],
    makesafe_job_details: [{
      job_id: JOB_ID,
      requesting_company_id: "co-1",
      requesting_company_slug: "mlb",
      external_ref: "MLR-41228",
    }],
    makesafe_companies: [{ id: "co-1", slug: "mlb", name: "ML Builders", restoration_recipients: opts.recipients ?? [AMBER] }],
    xero_invoices: [{
      xero_invoice_id: "inv-1",
      invoice_number: "INV-1891",
      invoice_type: "ACCREC",
      status: opts.invoiceStatus ?? "AUTHORISED",
      total: 275,
      amount_due: 275,
      reference: "MLR-41228",
      job_id: opts.invoiceJobId ?? JOB_ID,
    }],
    job_documents: opts.quoteDoc === false ? [] : [{
      id: "doc-q2",
      job_id: JOB_ID,
      type: "other",
      file_name: "Restoration Quote - SWMS-261709-Q2.pdf",
      pdf_url: "https://storage.example/quote-q2.pdf",
      storage_url: null,
      metadata: { restoration_document: "quote", quote_number: "SWMS-261709-Q2" },
      created_at: "2026-11-12T09:00:00Z",
    }],
    job_events: [],
  };
  const inserted: Row[] = [];
  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let single = false;
    const run = () => {
      const rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)));
      return { data: single ? rows[0] ?? null : rows, error: null };
    };
    const chain: any = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return chain;
      },
      order: () => chain,
      limit: () => Promise.resolve(run()),
      maybeSingle: () => {
        single = true;
        return Promise.resolve(run());
      },
      insert: (row: Row) => {
        inserted.push({ table, ...row });
        return Promise.resolve({ error: null });
      },
    };
    return chain;
  }
  return { client: { from: builder }, inserted };
}

function deps(store: MemoryEffectStore, sends: Row[]) {
  let sent: Record<string, unknown> | null = null;
  return {
    makeMailGateway: (load: (h: string[]) => Promise<unknown[]>) => ({
      createDraftAndSend: async (route: Record<string, any>, context: any) => {
        const atts = await load(route.attachment_hashes);
        sends.push({ route, atts });
        sent = { message_id: "msg-1", operation_token: context.external_token };
        return sent as any;
      },
      reconcileSent: () => Promise.resolve((sent ? [sent] : []) as any),
    }),
    effectStore: store,
    fetchInvoicePdf: (_id: string) => Promise.resolve(PDF),
    fetchDocumentBytes: (_url: string) => Promise.resolve(PDF),
  };
}

const API = { mode: "api_key" as const, user: null };

Deno.test("restoration send: an authorised invoice goes to the builder's restoration contact, ses@ copied", async () => {
  const { client, inserted } = makeClient();
  const store = new MemoryEffectStore();
  const sends: Row[] = [];
  const result = await sendRestorationDocumentAction(
    client,
    API,
    { job_id: JOB_ID, kind: "invoice", to: AMBER.toUpperCase(), xero_invoice_id: "inv-1", dry_run: false },
    deps(store, sends) as any,
  );
  assertEquals(result.success, true);
  assertEquals(result.to, [AMBER]);
  assertEquals(result.cc, ["ses@secureworkswa.com.au"]);
  assertEquals(sends.length, 1);
  assertStringIncludes(String((sends[0].route as Row).subject), "INV-1891");
  assertEquals(store.row?.effect_kind, "restoration_send");
  assertEquals(store.row?.state, "confirmed");
  assert(inserted.some((r) => r.event_type === "restoration_document_sent"));
});

Deno.test("restoration send: dry run sends nothing and claims nothing", async () => {
  const { client } = makeClient();
  const store = new MemoryEffectStore();
  const sends: Row[] = [];
  const result = await sendRestorationDocumentAction(
    client,
    API,
    { job_id: JOB_ID, kind: "quote", to: AMBER },
    deps(store, sends) as any,
  );
  assertEquals(result.dry_run, true);
  assertEquals(sends.length, 0);
  assertEquals(store.row, null);
  assertEquals((result.document as Row).job_document_id, "doc-q2");
  assertStringIncludes(String(result.subject), "Quote SWMS-261709-Q2");
});

Deno.test("restoration send: a DRAFT, another job's or a purchase invoice is refused", async () => {
  for (const [opts, code] of [
    [{ invoiceStatus: "DRAFT" }, "restoration_send_invoice_not_authorised"],
    [{ invoiceJobId: "other-job" }, "restoration_send_invoice_other_job"],
  ] as const) {
    const { client } = makeClient(opts);
    const err = await assertRejects(
      () =>
        sendRestorationDocumentAction(
          client,
          API,
          { job_id: JOB_ID, kind: "invoice", to: AMBER, xero_invoice_id: "inv-1" },
          deps(new MemoryEffectStore(), []) as any,
        ),
      SesActionError,
    );
    assertEquals(refusalCode(err), code);
  }
  try {
    assertRestorationInvoiceSendable({ job_id: JOB_ID, invoice_type: "ACCPAY", status: "AUTHORISED" }, JOB_ID);
    throw new Error("expected refusal");
  } catch (e) {
    assertEquals(refusalCode(e), "restoration_send_invoice_not_sales");
  }
});

Deno.test("restoration send: a make-safe card, an unlisted address and a routine are refused", async () => {
  const cases: Array<[Parameters<typeof makeClient>[0], Record<string, unknown>, unknown, string]> = [
    [{ family: "general_makesafe" }, { to: AMBER }, API, "restoration_send_not_restoration"],
    [{}, { to: "someone@else.example" }, API, "restoration_send_to_not_allowed"],
    [{}, { to: AMBER }, { mode: "routine", user: null }, "restoration_send_privileged_only"],
    [{}, { to: AMBER }, { mode: "jwt", user: { id: "u", email: "t@x", role: "lead_installer" } }, "restoration_send_privileged_only"],
  ];
  for (const [opts, extra, auth, code] of cases) {
    const { client } = makeClient(opts);
    const err = await assertRejects(
      () =>
        sendRestorationDocumentAction(
          client,
          auth as any,
          { job_id: JOB_ID, kind: "invoice", xero_invoice_id: "inv-1", ...extra },
          deps(new MemoryEffectStore(), []) as any,
        ),
      SesActionError,
    );
    assertEquals(refusalCode(err), code);
  }
});

Deno.test("restoration send: no quote document on the job is refused", async () => {
  const { client } = makeClient({ quoteDoc: false });
  const err = await assertRejects(
    () =>
      sendRestorationDocumentAction(
        client,
        API,
        { job_id: JOB_ID, kind: "quote", to: AMBER },
        deps(new MemoryEffectStore(), []) as any,
      ),
    SesActionError,
  );
  assertEquals(refusalCode(err), "restoration_send_quote_missing");
});

Deno.test("restoration send: subject and body are plain and carry the builder reference", () => {
  assertEquals(
    restorationSendSubject({ kind: "invoice", documentLabel: "INV-1891", builderRef: "MLR-41228", site: "18A Devon Way, Lynwood", jobNumber: "SWMS-261709" }),
    "Tax invoice INV-1891 | MLR-41228 | 18A Devon Way, Lynwood",
  );
  const body = restorationSendBody({ kind: "quote", documentLabel: "Q2", builderRef: "MLR-41228", site: "Lynwood" });
  assertStringIncludes(body, "Please find attached our quote Q2 for MLR-41228, Lynwood.");
  assertEquals(resolveRestorationRecipient(" Coordinator@Builder.Example ", [AMBER]), AMBER);
});

function refusalCode(error: unknown): string | undefined {
  return ((error as SesActionError).refusal as { code?: string }).code;
}

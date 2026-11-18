// Unit tests for P3-02.3 supplier credit proposal from stored mail PDFs.
// Run: ~/.deno/bin/deno test --no-check --allow-env --allow-read supabase/functions/xero-sync/supplier_credit_propose_test.ts

import { _resetSwitchCacheForTest } from "../_shared/switch_cache.ts";
import {
  CONTEXT_EMAIL_ATTACHMENTS_BUCKET,
  proposeSupplierCredits,
  SUPPLIER_CREDIT_DRAFTS_FLAG,
} from "./supplier_credit_propose.ts";
import { _scheduledBillPrematchForTest } from "./index.ts";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${msg ? `${msg}: ` : ""}expected ${b}, got ${a}`);
  }
}

function assert(cond: unknown, msg = "assertion failed"): void {
  if (!cond) throw new Error(msg);
}

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const JOB_ID = "32023000-0000-4000-8000-000000000002";
const NOW_ISO = "2026-10-10T08:00:00.000Z";

interface FakeAttachment {
  id: string;
  file_name: string | null;
  content_type: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  status: string | null;
  created_at: string;
}

interface FakeInvoice {
  org_id: string;
  xero_invoice_id: string;
  invoice_type: string;
  invoice_number: string | null;
  xero_contact_id: string | null;
  contact_name: string | null;
  job_id: string | null;
}

interface FakeXeroCreditNote {
  org_id: string;
  xero_credit_note_id: string;
  xero_contact_id: string | null;
  credit_note_number: string | null;
}

interface FakeDraftRow {
  id: string;
  org_id: string;
  source_attachment_id: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  xero_contact_id: string | null;
  supplier_name: string;
  credit_number: string;
  credit_date: string | null;
  amount_ex: number | null;
  amount_inc: number | null;
  names_bill_number: string | null;
  matched_bill_xero_invoice_id: string | null;
  matched_job_id: string | null;
  match_reasons: unknown[];
  state: string;
}

interface FakeRaisedItem {
  id: string;
  kind: string;
  subject_table: string;
  subject_id: string;
  job_ids: string[];
  suggestion: unknown;
  evidence: Record<string, unknown>;
  raised_by: string;
}

interface FaultState {
  candidateError?: { code: string; message: string } | null;
  downloadErrorPaths?: Set<string>;
  billLookupError?: { code: string; message: string } | null;
  recordProposalError?: { code: string; message: string } | null;
}

function makeFakeEnv(seed: {
  switchOn?: boolean;
  attachments?: FakeAttachment[];
  files?: Record<string, string>;
  invoices?: FakeInvoice[];
  xeroCreditNotes?: FakeXeroCreditNote[];
  drafts?: FakeDraftRow[];
  faults?: FaultState;
} = {}) {
  _resetSwitchCacheForTest();
  let switchOn = seed.switchOn ?? true;
  const attachments: FakeAttachment[] = [...(seed.attachments ?? [])];
  const files: Record<string, string> = { ...(seed.files ?? {}) };
  const invoices: FakeInvoice[] = [...(seed.invoices ?? [])];
  const xeroCreditNotes: FakeXeroCreditNote[] = [
    ...(seed.xeroCreditNotes ?? []),
  ];
  const drafts: FakeDraftRow[] = [...(seed.drafts ?? [])];
  const raisedItems: FakeRaisedItem[] = [];
  const webhookLogs: unknown[] = [];
  const faults: FaultState = seed.faults ?? {};

  let nextSeq = 1;
  let candidateReads = 0;
  let storageDownloads = 0;
  let billReads = 0;
  let recordCalls = 0;

  const client = {
    from(table: string) {
      if (table === "feature_flags") {
        return {
          select(_cols: string) {
            return {
              eq(col: string, val: string) {
                return {
                  limit(_n: number) {
                    const enabled = col === "flag_name" &&
                      val === SUPPLIER_CREDIT_DRAFTS_FLAG && switchOn;
                    return Promise.resolve({
                      data: [{ flag_name: val, enabled }],
                      error: null,
                    });
                  },
                };
              },
            };
          },
        };
      }
      if (table === "webhook_log") {
        return {
          insert(row: unknown) {
            webhookLogs.push(row);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      // Minimal stub for scheduledBillPrematch's runBillPrematch queue read.
      return {
        select(_cols: string) {
          const chain = {
            eq: () => chain,
            in: () => chain,
            not: () => chain,
            order: () => chain,
            range: () => Promise.resolve({ data: [], error: null }),
          };
          return chain;
        },
      };
    },

    storage: {
      from(bucket: string) {
        return {
          download(path: string) {
            storageDownloads++;
            if (faults.downloadErrorPaths?.has(path)) {
              return Promise.resolve({
                data: null,
                error: { statusCode: "503", message: "storage unavailable" },
              });
            }
            const key = `${bucket}/${path}`;
            const content = files[key];
            if (content === undefined) {
              return Promise.resolve({
                data: null,
                error: { statusCode: "404", message: "not found" },
              });
            }
            return Promise.resolve({
              data: new TextEncoder().encode(content),
              error: null,
            });
          },
        };
      },
    },

    // deno-lint-ignore no-explicit-any
    rpc(fn: string, args: Record<string, any>) {
      if (fn === "supplier_credit_candidate_attachments") {
        candidateReads++;
        if (faults.candidateError) {
          return Promise.resolve({ data: null, error: faults.candidateError });
        }
        const sinceMs = Date.parse(args.p_since);
        const excluded = new Set<string>(args.p_exclude_ids ?? []);
        const usedIds = new Set(
          drafts
            .filter((d) =>
              d.org_id === args.p_org_id && d.source_attachment_id !== null
            )
            .map((d) => d.source_attachment_id as string),
        );
        const filtered = attachments
          .filter((a) => {
            if (a.status !== "stored") return false;
            if (a.content_type !== "application/pdf") return false;
            if (Date.parse(a.created_at) < sinceMs) return false;
            const fnLower = (a.file_name ?? "").toLowerCase();
            if (
              !fnLower.includes("credit") &&
              !fnLower.includes("adjust") &&
              !fnLower.includes("cn")
            ) {
              return false;
            }
            if (excluded.has(a.id) || usedIds.has(a.id)) return false;
            return true;
          })
          .sort((a, b) => {
            const cmp = Date.parse(a.created_at) - Date.parse(b.created_at);
            return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
          })
          .slice(0, Math.max(args.p_limit ?? 10, 0));
        return Promise.resolve({ data: filtered, error: null });
      }

      if (fn === "supplier_credit_matching_bills") {
        billReads++;
        if (faults.billLookupError) {
          return Promise.resolve({ data: null, error: faults.billLookupError });
        }
        const target = String(args.p_bill_number ?? "").trim().toLowerCase();
        const matches = invoices
          .filter((inv) =>
            inv.org_id === args.p_org_id &&
            inv.invoice_type === "ACCPAY" &&
            inv.invoice_number !== null &&
            inv.invoice_number.toLowerCase() === target
          )
          .slice(0, 2)
          .map((inv) => ({
            xero_invoice_id: inv.xero_invoice_id,
            invoice_number: inv.invoice_number,
            xero_contact_id: inv.xero_contact_id,
            contact_name: inv.contact_name,
            job_id: inv.job_id,
          }));
        return Promise.resolve({ data: matches, error: null });
      }

      if (fn === "supplier_credit_record_proposal") {
        recordCalls++;
        if (faults.recordProposalError) {
          return Promise.resolve({
            data: null,
            error: faults.recordProposalError,
          });
        }
        const contactId = args.p_xero_contact_id ?? null;
        const creditNo = String(args.p_credit_number);
        const supplier = String(args.p_supplier_name);
        const isDuplicate = contactId !== null &&
          xeroCreditNotes.some((cn) =>
            cn.org_id === args.p_org_id &&
            cn.xero_contact_id === contactId &&
            cn.credit_note_number !== null &&
            cn.credit_note_number.toLowerCase() === creditNo.toLowerCase()
          );

        const conflict = drafts.some((d) =>
          d.org_id === args.p_org_id &&
          d.supplier_name.toLowerCase() === supplier.toLowerCase() &&
          d.credit_number === creditNo
        );
        if (conflict) {
          return Promise.resolve({
            data: { outcome: "already_exists" },
            error: null,
          });
        }

        const draftId = `32023000-0000-4000-8000-${
          String(nextSeq++).padStart(12, "0")
        }`;
        const state = isDuplicate ? "duplicate" : "proposed";
        drafts.push({
          id: draftId,
          org_id: args.p_org_id,
          source_attachment_id: args.p_source_attachment_id,
          storage_bucket: args.p_storage_bucket,
          storage_path: args.p_storage_path,
          xero_contact_id: contactId,
          supplier_name: supplier,
          credit_number: creditNo,
          credit_date: args.p_credit_date,
          amount_ex: args.p_amount_ex,
          amount_inc: args.p_amount_inc,
          names_bill_number: args.p_names_bill_number,
          matched_bill_xero_invoice_id: args.p_matched_bill_xero_invoice_id,
          matched_job_id: args.p_matched_job_id,
          match_reasons: args.p_match_reasons ?? [],
          state,
        });

        if (isDuplicate) {
          return Promise.resolve({
            data: { outcome: "duplicate", draft_id: draftId },
            error: null,
          });
        }

        const itemId = `32023999-0000-4000-8000-${
          String(nextSeq++).padStart(12, "0")
        }`;
        raisedItems.push({
          id: itemId,
          kind: "credit_note_proposed",
          subject_table: "supplier_credit_drafts",
          subject_id: draftId,
          job_ids: args.p_matched_job_id ? [args.p_matched_job_id] : [],
          suggestion: args.p_suggestion,
          evidence: args.p_evidence,
          raised_by: "phase3:books",
        });

        return Promise.resolve({
          data: {
            outcome: "proposed",
            draft_id: draftId,
            reconcile_item_id: itemId,
          },
          error: null,
        });
      }

      return Promise.resolve({
        data: null,
        error: { code: "PGRST202", message: `unknown rpc ${fn}` },
      });
    },
  };

  const fakeTextReader = (bytes: Uint8Array) =>
    Promise.resolve(new TextDecoder().decode(bytes));

  return {
    client,
    fakeTextReader,
    drafts,
    raisedItems,
    webhookLogs,
    attachments,
    files,
    faults,
    setSwitch(on: boolean) {
      switchOn = on;
      _resetSwitchCacheForTest();
    },
    metrics() {
      return { candidateReads, storageDownloads, billReads, recordCalls };
    },
  };
}

function makeAttachment(
  id: string,
  fileName: string,
  path: string,
  createdAt = "2026-10-04T09:00:00.000Z",
  overrides: Partial<FakeAttachment> = {},
): FakeAttachment {
  return {
    id,
    file_name: fileName,
    content_type: "application/pdf",
    storage_bucket: CONTEXT_EMAIL_ATTACHMENTS_BUCKET,
    storage_path: path,
    status: "stored",
    created_at: createdAt,
    ...overrides,
  };
}

Deno.test("proposeSupplierCredits: switch off gives 0 reads and scheduledBillPrematch matches main", async () => {
  const env = makeFakeEnv({
    switchOn: false,
    attachments: [
      makeAttachment(
        "00000000-0000-4000-8000-0000000000a1",
        "credit_note_CN-1001.pdf",
        "mail/cn-1001.pdf",
      ),
    ],
    files: {
      "context-email-attachments/mail/cn-1001.pdf":
        "CREDIT NOTE CN-1001\nDate: 3 October 2026\nTotal inc GST $220.00",
    },
  });

  const res = await proposeSupplierCredits(env.client, ORG_ID, {
    limit: 10,
    now: () => new Date(NOW_ISO),
    extractText: env.fakeTextReader,
  });

  assertEquals(res, { read: 0, proposed: 0, duplicate: 0, not_credit: 0 });
  assertEquals(env.metrics(), {
    candidateReads: 0,
    storageDownloads: 0,
    billReads: 0,
    recordCalls: 0,
  });
  assertEquals(env.drafts.length, 0);
  assertEquals(env.raisedItems.length, 0);

  const scheduled = await _scheduledBillPrematchForTest(env.client);
  assertEquals("supplier_credits" in scheduled, false);
  assertEquals(scheduled.success, true);
  assertEquals(env.metrics().candidateReads, 0);
});

Deno.test("proposeSupplierCredits: rule 22 example proposes credit matched to bill and job, raises once, and second run gives nothing new", async () => {
  const attId = "00000000-0000-4000-8000-0000000000a1";
  const pdfText = [
    "ZZTEST Supplies Pty Ltd",
    "CREDIT NOTE CN-1001",
    "Date: 3 October 2026",
    "Original invoice INV-5001",
    "Total inc GST $220.00",
    "Total GST $20.00",
  ].join("\n");

  const env = makeFakeEnv({
    switchOn: true,
    attachments: [
      makeAttachment(attId, "Supplier_Credit_CN-1001.pdf", "mail/cn-1001.pdf"),
    ],
    files: {
      "context-email-attachments/mail/cn-1001.pdf": pdfText,
    },
    invoices: [
      {
        org_id: ORG_ID,
        xero_invoice_id: "xinv-5001",
        invoice_type: "ACCPAY",
        invoice_number: "inv-5001",
        xero_contact_id: "xcontact-zztest",
        contact_name: "ZZTEST Supplies",
        job_id: JOB_ID,
      },
    ],
  });

  const first = await proposeSupplierCredits(env.client, ORG_ID, {
    limit: 10,
    now: () => new Date(NOW_ISO),
    extractText: env.fakeTextReader,
  });

  assertEquals(first, { read: 1, proposed: 1, duplicate: 0, not_credit: 0 });
  assertEquals(env.drafts.length, 1);
  assertEquals(env.drafts[0], {
    id: env.drafts[0].id,
    org_id: ORG_ID,
    source_attachment_id: attId,
    storage_bucket: CONTEXT_EMAIL_ATTACHMENTS_BUCKET,
    storage_path: "mail/cn-1001.pdf",
    xero_contact_id: "xcontact-zztest",
    supplier_name: "ZZTEST Supplies",
    credit_number: "CN-1001",
    credit_date: "2026-10-03",
    amount_ex: 200,
    amount_inc: 220,
    names_bill_number: "INV-5001",
    matched_bill_xero_invoice_id: "xinv-5001",
    matched_job_id: JOB_ID,
    match_reasons: [{ code: "credit_names_bill", value: "inv-5001" }],
    state: "proposed",
  });

  assertEquals(env.raisedItems.length, 1);
  assertEquals(env.raisedItems[0], {
    id: env.raisedItems[0].id,
    kind: "credit_note_proposed",
    subject_table: "supplier_credit_drafts",
    subject_id: env.drafts[0].id,
    job_ids: [JOB_ID],
    suggestion: { outcome: "job", job_id: JOB_ID },
    evidence: {
      reason: "credit_document_read",
      amount_ex: 200,
      document_date: "2026-10-03",
      summary: {
        words: "Credit CN-1001 from ZZTEST Supplies for bill INV-5001",
        credit_number: "CN-1001",
        supplier_name: "ZZTEST Supplies",
        names_bill_number: "INV-5001",
        amount_inc: 220,
      },
    },
    raised_by: "phase3:books",
  });

  // Second run on the same attachment gives nothing new.
  const second = await proposeSupplierCredits(env.client, ORG_ID, {
    limit: 10,
    now: () => new Date(NOW_ISO),
    extractText: env.fakeTextReader,
  });
  assertEquals(second, { read: 0, proposed: 0, duplicate: 0, not_credit: 0 });
  assertEquals(env.drafts.length, 1);
  assertEquals(env.raisedItems.length, 1);

  // Another email carrying the exact same supplier and credit number hits unique conflict and skips.
  const att2 = "00000000-0000-4000-8000-0000000000a2";
  env.attachments.push(
    makeAttachment(att2, "CN-1001-copy.pdf", "mail/cn-1001-copy.pdf"),
  );
  env.files["context-email-attachments/mail/cn-1001-copy.pdf"] = pdfText;
  const third = await proposeSupplierCredits(env.client, ORG_ID, {
    limit: 10,
    now: () => new Date(NOW_ISO),
    extractText: env.fakeTextReader,
  });
  assertEquals(third, { read: 1, proposed: 0, duplicate: 0, not_credit: 0 });
  assertEquals(env.drafts.length, 1);
  assertEquals(env.raisedItems.length, 1);
});

Deno.test("proposeSupplierCredits: credit already in Xero copy records state duplicate and raises nothing", async () => {
  const attId = "00000000-0000-4000-8000-0000000000b1";
  const env = makeFakeEnv({
    switchOn: true,
    attachments: [
      makeAttachment(attId, "adjustment_note_CN-1001.pdf", "mail/adj-1001.pdf"),
    ],
    files: {
      "context-email-attachments/mail/adj-1001.pdf": [
        "Adjustment Note CN-1001",
        "Date: 3 October 2026",
        "Original invoice INV-5001",
        "Total inc GST $220.00",
        "Total GST $20.00",
      ].join("\n"),
    },
    invoices: [
      {
        org_id: ORG_ID,
        xero_invoice_id: "xinv-5001",
        invoice_type: "ACCPAY",
        invoice_number: "INV-5001",
        xero_contact_id: "xcontact-zztest",
        contact_name: "ZZTEST Supplies",
        job_id: JOB_ID,
      },
    ],
    xeroCreditNotes: [
      {
        org_id: ORG_ID,
        xero_credit_note_id: "xcn-existing-1",
        xero_contact_id: "xcontact-zztest",
        credit_note_number: "cn-1001",
      },
    ],
  });

  const res = await proposeSupplierCredits(env.client, ORG_ID, {
    limit: 10,
    now: () => new Date(NOW_ISO),
    extractText: env.fakeTextReader,
  });

  assertEquals(res, { read: 1, proposed: 0, duplicate: 1, not_credit: 0 });
  assertEquals(env.drafts.length, 1);
  assertEquals(env.drafts[0].state, "duplicate");
  assertEquals(env.raisedItems.length, 0);
});

Deno.test("proposeSupplierCredits: two bills with named number or no bill named give proposal with no matched bill", async () => {
  const attTwoBills = "00000000-0000-4000-8000-0000000000c1";
  const attNoBill = "00000000-0000-4000-8000-0000000000c2";
  const env = makeFakeEnv({
    switchOn: true,
    attachments: [
      makeAttachment(
        attTwoBills,
        "credit_CN-3001.pdf",
        "mail/cn-3001.pdf",
        "2026-10-04T09:00:00.000Z",
      ),
      makeAttachment(
        attNoBill,
        "cn_3002.pdf",
        "mail/cn-3002.pdf",
        "2026-10-04T10:00:00.000Z",
      ),
    ],
    files: {
      "context-email-attachments/mail/cn-3001.pdf": [
        "  ZZTEST Timber Group  ",
        "CREDIT NOTE CN-3001",
        "Date: 4 October 2026",
        "Original invoice INV-7777",
        "Total inc GST $110.00",
        "Total GST $10.00",
      ].join("\n"),
      "context-email-attachments/mail/cn-3002.pdf": [
        "ZZTEST Hardware Co",
        "CREDIT NOTE CN-3002",
        "Date: 5 October 2026",
        "Credit Total (inc GST) $55.00",
      ].join("\n"),
    },
    invoices: [
      {
        org_id: ORG_ID,
        xero_invoice_id: "xinv-a",
        invoice_type: "ACCPAY",
        invoice_number: "INV-7777",
        xero_contact_id: "xcontact-a",
        contact_name: "Supplier A",
        job_id: JOB_ID,
      },
      {
        org_id: ORG_ID,
        xero_invoice_id: "xinv-b",
        invoice_type: "ACCPAY",
        invoice_number: "INV-7777",
        xero_contact_id: "xcontact-b",
        contact_name: "Supplier B",
        job_id: null,
      },
    ],
  });

  const res = await proposeSupplierCredits(env.client, ORG_ID, {
    limit: 10,
    now: () => new Date(NOW_ISO),
    extractText: env.fakeTextReader,
  });

  assertEquals(res, { read: 2, proposed: 2, duplicate: 0, not_credit: 0 });
  assertEquals(env.drafts[0].matched_bill_xero_invoice_id, null);
  assertEquals(env.drafts[0].matched_job_id, null);
  assertEquals(env.drafts[0].xero_contact_id, null);
  assertEquals(env.drafts[0].supplier_name, "ZZTEST Timber Group");
  assertEquals(env.drafts[0].match_reasons, []);
  assertEquals(env.raisedItems[0].job_ids, []);
  assertEquals(env.raisedItems[0].suggestion, null);
  assertEquals(
    (env.raisedItems[0].evidence.summary as Record<string, unknown>).words,
    "Credit CN-3001 from ZZTEST Timber Group for bill INV-7777",
  );

  assertEquals(env.drafts[1].names_bill_number, null);
  assertEquals(env.drafts[1].amount_ex, null);
  assertEquals(env.drafts[1].amount_inc, 55);
  assertEquals(
    (env.raisedItems[1].evidence.summary as Record<string, unknown>).words,
    "Credit CN-3002 from ZZTEST Hardware Co for bill no bill named",
  );
});

Deno.test("proposeSupplierCredits: filters candidates, orders oldest first within limit, and skips non-credit PDFs", async () => {
  const env = makeFakeEnv({
    switchOn: true,
    attachments: [
      // Too old (> 14 days before 2026-10-10)
      makeAttachment(
        "00000000-0000-4000-8000-0000000000d0",
        "credit_old.pdf",
        "mail/old.pdf",
        "2026-09-20T00:00:00.000Z",
      ),
      // Wrong filename
      makeAttachment(
        "00000000-0000-4000-8000-0000000000d1",
        "tax_invoice_5001.pdf",
        "mail/inv.pdf",
        "2026-10-01T00:00:00.000Z",
      ),
      // Non-credit PDF whose filename matches 'credit' (oldest valid candidate)
      makeAttachment(
        "00000000-0000-4000-8000-0000000000d2",
        "credit_application.pdf",
        "mail/app.pdf",
        "2026-10-02T00:00:00.000Z",
      ),
      // Second valid candidate
      makeAttachment(
        "00000000-0000-4000-8000-0000000000d3",
        "ADJUST_4001.pdf",
        "mail/adj-4001.pdf",
        "2026-10-03T00:00:00.000Z",
      ),
      // Third valid candidate beyond limit: 2
      makeAttachment(
        "00000000-0000-4000-8000-0000000000d4",
        "CN_4002.pdf",
        "mail/cn-4002.pdf",
        "2026-10-04T00:00:00.000Z",
      ),
    ],
    files: {
      "context-email-attachments/mail/app.pdf":
        "TAX INVOICE INV-9000\nTotal $110.00",
      "context-email-attachments/mail/adj-4001.pdf":
        "ZZTEST Metals\nAdjustment Note ADJ-4001\nDate: 03/10/2026\nCredit Total $88.00",
      "context-email-attachments/mail/cn-4002.pdf":
        "ZZTEST Metals\nCredit Note CN-4002\nDate: 04/10/2026\nCredit Total $99.00",
    },
  });

  const res = await proposeSupplierCredits(env.client, ORG_ID, {
    limit: 2,
    now: () => new Date(NOW_ISO),
    extractText: env.fakeTextReader,
  });

  assertEquals(res, { read: 2, proposed: 1, duplicate: 0, not_credit: 1 });
  assertEquals(env.drafts.length, 1);
  assertEquals(env.drafts[0].credit_number, "ADJ-4001");
});

Deno.test("proposeSupplierCredits: credit amount mismatch and line-only GST never guess figures and raise to a person", async () => {
  const env = makeFakeEnv({
    switchOn: true,
    attachments: [
      makeAttachment(
        "00000000-0000-4000-8000-0000000000e1",
        "credit_mismatch_CN-5001.pdf",
        "mail/cn-5001.pdf",
        "2026-10-05T01:00:00.000Z",
      ),
      makeAttachment(
        "00000000-0000-4000-8000-0000000000e2",
        "credit_line_gst_CN-5002.pdf",
        "mail/cn-5002.pdf",
        "2026-10-05T02:00:00.000Z",
      ),
    ],
    files: {
      "context-email-attachments/mail/cn-5001.pdf": [
        "ZZTEST Supplies",
        "CREDIT NOTE CN-5001",
        "Date: 5 October 2026",
        "Original invoice INV-5001",
        "Subtotal (ex GST) $200.00",
        "Total GST $20.00",
        "Credit Total (inc GST) $250.00",
      ].join("\n"),
      "context-email-attachments/mail/cn-5002.pdf": [
        "ZZTEST Supplies",
        "CREDIT NOTE CN-5002",
        "Date: 5 October 2026",
        "Original invoice INV-5001",
        "Total $550.00",
        "Line 1 post kit  GST $10.00",
        "Line 2 rail kit  GST $10.00",
        "Credit Total (inc GST) $220.00",
      ].join("\n"),
    },
    invoices: [
      {
        org_id: ORG_ID,
        xero_invoice_id: "xinv-5001",
        invoice_type: "ACCPAY",
        invoice_number: "INV-5001",
        xero_contact_id: "xcontact-zztest",
        contact_name: "ZZTEST Supplies",
        job_id: JOB_ID,
      },
    ],
  });

  const res = await proposeSupplierCredits(env.client, ORG_ID, {
    limit: 10,
    now: () => new Date(NOW_ISO),
    extractText: env.fakeTextReader,
  });

  assertEquals(res, { read: 2, proposed: 2, duplicate: 0, not_credit: 0 });
  // Mismatched ex + GST vs inc withholds all figures and sends to a person.
  assertEquals(env.drafts[0].amount_ex, null);
  assertEquals(env.drafts[0].amount_inc, null);
  assertEquals(env.raisedItems[0].evidence.amount_ex, null);
  assertEquals(env.raisedItems[0].evidence.amounts_need_review, true);
  assertEquals(
    (env.raisedItems[0].evidence.summary as Record<string, unknown>).amount_inc,
    null,
  );

  // Earlier bare Total $550.00 and line-only GST $10.00 are ignored; Credit Total $220.00 wins with ex null.
  assertEquals(env.drafts[1].amount_inc, 220);
  assertEquals(env.drafts[1].amount_ex, null);
});

Deno.test("proposeSupplierCredits: bad paths with switch ON never throw, write nothing partial, and retry cleanly", async () => {
  const attId = "00000000-0000-4000-8000-0000000000f1";
  const env = makeFakeEnv({
    switchOn: true,
    attachments: [
      makeAttachment(attId, "credit_CN-6001.pdf", "mail/cn-6001.pdf"),
    ],
    files: {
      "context-email-attachments/mail/cn-6001.pdf": [
        "ZZTEST Supplies",
        "CREDIT NOTE CN-6001",
        "Date: 6 October 2026",
        "Original invoice INV-6001",
        "Credit Total $110.00",
      ].join("\n"),
    },
    invoices: [
      {
        org_id: ORG_ID,
        xero_invoice_id: "xinv-6001",
        invoice_type: "ACCPAY",
        invoice_number: "INV-6001",
        xero_contact_id: "xcontact-zztest",
        contact_name: "ZZTEST Supplies",
        job_id: JOB_ID,
      },
    ],
    faults: {
      candidateError: { code: "57014", message: "statement timeout" },
    },
  });

  // 1. Candidate read fails: returns error, zero throws, nothing written.
  const candFail = await proposeSupplierCredits(env.client, ORG_ID, {
    limit: 10,
    now: () => new Date(NOW_ISO),
    extractText: env.fakeTextReader,
  });
  assertEquals(candFail, {
    read: 0,
    proposed: 0,
    duplicate: 0,
    not_credit: 0,
    error: "candidate_read_failed",
  });
  assertEquals(env.drafts.length, 0);

  // 2. Bill lookup fails: refuses to treat failure as 0 bills, writes nothing.
  env.faults.candidateError = null;
  env.faults.billLookupError = { code: "57014", message: "timeout" };
  const billFail = await proposeSupplierCredits(env.client, ORG_ID, {
    limit: 10,
    now: () => new Date(NOW_ISO),
    extractText: env.fakeTextReader,
  });
  assertEquals(billFail, {
    read: 1,
    proposed: 0,
    duplicate: 0,
    not_credit: 0,
    error: "bill_lookup_failed",
  });
  assertEquals(env.drafts.length, 0);
  assertEquals(env.raisedItems.length, 0);

  // 3. Proposal write fails: nothing persisted, next run retries and succeeds.
  env.faults.billLookupError = null;
  env.faults.recordProposalError = { code: "40P01", message: "deadlock" };
  const writeFail = await proposeSupplierCredits(env.client, ORG_ID, {
    limit: 10,
    now: () => new Date(NOW_ISO),
    extractText: env.fakeTextReader,
  });
  assertEquals(writeFail.error, "proposal_write_failed");
  assertEquals(env.drafts.length, 0);

  // 4. Retry after refusal succeeds cleanly with matched bill and job intact.
  env.faults.recordProposalError = null;
  const recovered = await proposeSupplierCredits(env.client, ORG_ID, {
    limit: 10,
    now: () => new Date(NOW_ISO),
    extractText: env.fakeTextReader,
  });
  assertEquals(recovered, { read: 1, proposed: 1, duplicate: 0, not_credit: 0 });
  assertEquals(env.drafts.length, 1);
  assertEquals(env.drafts[0].matched_bill_xero_invoice_id, "xinv-6001");
  assertEquals(env.raisedItems.length, 1);
  assert(env.raisedItems[0].subject_id === env.drafts[0].id);
});

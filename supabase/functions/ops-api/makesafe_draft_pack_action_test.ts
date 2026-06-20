// MakeSafe Draft Pack action tests.
//
// Stubs every external dependency so this proves orchestration shape without
// network, Supabase, Xero, storage, or email. The invariant: draft_makesafe_report_pack
// may call Claude, render a report, create a Xero DRAFT invoice, fetch/attach the
// draft invoice PDF, and mark the pack ready. It must not authorise or send.
//
// Run:
//   deno test --no-check --allow-all \
//     supabase/functions/ops-api/makesafe_draft_pack_action_test.ts

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _claimDraftPackForDraftingForTest as claimDraftPackForDrafting,
  _compactDraftPackBillingNoteForTest as compactDraftPackBillingNote,
  _createMakesafeDraftInvoiceForTest as createMakesafeDraftInvoice,
  _draftMakesafeReportPackDueForTest as draftMakesafeReportPackDue,
  _draftMakesafeReportPackForTest as draftMakesafeReportPack,
  _evaluateMakesafeDraftInvoicePricingForTest
    as evaluateMakesafeDraftInvoicePricing,
  _makesafeDraftInvoicePayloadLinesForXeroUpdateForTest
    as makesafeDraftInvoicePayloadLinesForXeroUpdate,
} from "./index.ts";

function claudeJson(summary = "Draft pack refreshed for human review.") {
  return JSON.stringify({
    report: {
      ref: "AJBR-67713",
      address: "14 Preview Street, Aveley WA",
      works: "Ceiling area made safe and temporary protection installed.",
      scope: "Emergency make safe attendance.",
    },
    invoice: {
      reference: "AJBR-67713",
      contact_name: "AJS Group",
      line_items: [
        {
          description: "Emergency make-safe attendance",
          quantity: 1,
          unit_price: 420,
          account_code: "210",
        },
      ],
    },
    change_summary: summary,
  });
}

Deno.test("draftMakesafeReportPack: drafts report + DRAFT invoice + invoice PDF only", async () => {
  const calls: Record<string, any[]> = {
    claude: [],
    render: [],
    createDraftInvoice: [],
    getToken: [],
    fetchInvoicePdf: [],
    attachDoc: [],
    ensure: [],
    patch: [],
    markReady: [],
    assertEligible: [],
    claim: [],
    markFailed: [],
  };

  const result = await draftMakesafeReportPack(
    {},
    {
      job_id: "job-1",
      selected_photo_urls: ["https://example.com/approved.jpg"],
    },
    "routine",
    {
      assertRoutineEligible: async (_client, jobId, packKind, authMode) => {
        calls.assertEligible.push({ jobId, packKind, authMode });
      },
      claimDraftPack: async (_client, jobId, packKind, authMode) => {
        calls.claim.push({ jobId, packKind, authMode });
      },
      markDraftPackFailed: async (_client, jobId, packKind, err) => {
        calls.markFailed.push({ jobId, packKind, err });
      },
      loadContext: async () => ({
        job: {
          id: "job-1",
          job_number: "SWF-67713",
          client_name: "Jane Homeowner",
          site_address: "14 Preview Street, Aveley WA",
        },
        detail: {
          external_ref: "AJBR-67713",
          requesting_company_name: "AJS Group",
          report_received_at: "2026-06-19T01:00:00Z",
        },
        service_report: { checklist_json: { work_done: "Made safe." } },
        feedback_notes: [],
        selected_photo_urls: ["https://example.com/default.jpg"],
      }),
      callClaude: async (model, system, userContent) => {
        calls.claude.push({ model, system, userContent });
        return claudeJson();
      },
      renderReport: async (_client, body) => {
        calls.render.push(body);
        return {
          success: true,
          document_id: "report-doc-1",
          render_hash: "hash-1",
        };
      },
      createDraftInvoice: async (_client, body) => {
        calls.createDraftInvoice.push(body);
        return {
          success: true,
          skipped: false,
          xero_invoice_id: "xero-draft-1",
          invoice_number: "INV-DRAFT-1",
        };
      },
      getToken: async () => {
        calls.getToken.push({});
        return { accessToken: "token", tenantId: "tenant" };
      },
      fetchInvoicePdfBytes: async (_at, _tenant, xeroInvoiceId) => {
        calls.fetchInvoicePdf.push({ xeroInvoiceId });
        return new Uint8Array([37, 80, 68, 70]);
      },
      attachDoc: async (_client, body) => {
        calls.attachDoc.push(body);
        return { document_id: "invoice-doc-1" };
      },
      ensurePackRow: async (_client, jobId, packKind, extra) => {
        calls.ensure.push({ jobId, packKind, extra });
      },
      patchPack: async (_client, jobId, packKind, patch) => {
        calls.patch.push({ jobId, packKind, patch });
      },
      markReady: async (_client, jobId, detail) => {
        calls.markReady.push({ jobId, detail });
      },
    },
  );

  assertEquals(result.success, true);
  assertEquals(result.model, "claude-sonnet-4-6");
  assertEquals(result.report.document_id, "report-doc-1");
  assertEquals(result.invoice.document_id, "invoice-doc-1");
  assertEquals(result.selected_photo_count, 1);

  assertEquals(calls.assertEligible, [{
    jobId: "job-1",
    packKind: "main",
    authMode: "routine",
  }]);
  assertEquals(calls.claim, [{
    jobId: "job-1",
    packKind: "main",
    authMode: "routine",
  }]);
  assertEquals(calls.markFailed.length, 0);

  assertEquals(calls.claude.length, 1);
  assertEquals(calls.claude[0].model, "claude-sonnet-4-6");
  assertStringIncludes(calls.claude[0].system, "Return JSON only");

  assertEquals(calls.render.length, 1);
  assertEquals(calls.render[0].job.photos, [{
    url: "https://example.com/approved.jpg",
  }]);

  assertEquals(calls.createDraftInvoice.length, 1);
  assertEquals(
    calls.createDraftInvoice[0].line_items[0].description,
    "Emergency make-safe attendance",
  );
  assertEquals(calls.createDraftInvoice[0].line_items[0].unit_price, 420);

  assertEquals(calls.getToken.length, 1);
  assertEquals(calls.fetchInvoicePdf.length, 1);
  assertEquals(calls.attachDoc.length, 1);
  assertEquals(calls.attachDoc[0].type, "invoice");
  assertStringIncludes(calls.attachDoc[0].file_name, "Draft Xero Invoice");

  assertEquals(calls.ensure.length, 1);
  assertEquals(calls.patch.length, 1);
  assertEquals(calls.patch[0].patch.status, "admin_to_send_report");
  assertEquals(calls.patch[0].patch.report_doc_id, "report-doc-1");
  assertEquals(calls.patch[0].patch.invoice_doc_id, "invoice-doc-1");
  assertEquals(calls.markReady.length, 1);
});

Deno.test("draftMakesafeReportPack: rejects zero-priced Claude output before rendering report or invoice", async () => {
  const calls: Record<string, any[]> = {
    render: [],
    createDraftInvoice: [],
    markFailed: [],
    markReady: [],
  };

  await assertRejects(
    () =>
      draftMakesafeReportPack(
        {},
        { job_id: "job-zero" },
        "routine",
        {
          assertRoutineEligible: async () => {},
          claimDraftPack: async () => {},
          markDraftPackFailed: async (_client, jobId, packKind, err) => {
            calls.markFailed.push({
              jobId,
              packKind,
              message: (err as Error).message,
            });
          },
          loadContext: async () => ({
            job: {
              id: "job-zero",
              job_number: "SWMS-26652",
              site_address: "23 James Cook Avenue",
            },
            detail: {
              external_ref: "AJBR-67996",
              requesting_company_name: "AJ Building & Restoration",
            },
            selected_photo_urls: ["https://example.com/site.jpg"],
          }),
          callClaude: async () =>
            JSON.stringify({
              report: {
                ref: "AJBR-67996",
                address: "23 James Cook Avenue",
                works: "Temporary fencing and hardifence made safe.",
              },
              invoice: {
                reference: "AJBR-67996",
                contact_name: "AJ Building & Restoration",
                line_items: [{
                  description: "Make-safe labour placeholder",
                  quantity: 4,
                  unit_price: 0,
                }],
              },
            }),
          renderReport: async () => {
            calls.render.push({});
            throw new Error("report render must not run after bad pricing");
          },
          createDraftInvoice: async () => {
            calls.createDraftInvoice.push({});
            throw new Error("invoice draft must not run after bad pricing");
          },
          markReady: async () => {
            calls.markReady.push({});
          },
        },
      ),
    Error,
    "$0/invalid unit_price",
  );

  assertEquals(calls.render.length, 0);
  assertEquals(calls.createDraftInvoice.length, 0);
  assertEquals(calls.markReady.length, 0);
  assertEquals(calls.markFailed.length, 1);
  assertStringIncludes(calls.markFailed[0].message, "$0/invalid unit_price");
});

Deno.test("draftMakesafeReportPack: invoice/Xero failure stops before report render", async () => {
  const calls: Record<string, any[]> = { render: [], markFailed: [] };

  await assertRejects(
    () =>
      draftMakesafeReportPack(
        {},
        { job_id: "job-project-line" },
        "api_key",
        {
          assertRoutineEligible: async () => {},
          claimDraftPack: async () => {},
          markDraftPackFailed: async (_client, jobId, packKind, err) => {
            calls.markFailed.push({
              jobId,
              packKind,
              message: (err as Error).message,
            });
          },
          loadContext: async () => ({
            job: { id: "job-project-line", site_address: "1 Project St" },
            detail: {
              external_ref: "AJBR-67870",
              requesting_company_name: "AJ Building & Restoration",
            },
            selected_photo_urls: [],
          }),
          callClaude: async () =>
            claudeJson("Draft should fail at invoice first."),
          createDraftInvoice: async () => {
            throw new Error("Xero validation error: project line IDs required");
          },
          renderReport: async () => {
            calls.render.push({});
            throw new Error("report render must not run after Xero failure");
          },
        },
      ),
    Error,
    "project line IDs required",
  );

  assertEquals(calls.render.length, 0);
  assertEquals(calls.markFailed.length, 1);
});

Deno.test("draftMakesafeReportPack: existing non-DRAFT invoice does not attach a fake draft PDF", async () => {
  const calls: Record<string, any[]> = { getToken: [], attachDoc: [] };
  const result = await draftMakesafeReportPack(
    {},
    {
      job_id: "job-2",
    },
    "routine",
    {
      assertRoutineEligible: async () => {},
      claimDraftPack: async () => {},
      markDraftPackFailed: async () => {},
      loadContext: async () => ({
        job: {
          id: "job-2",
          job_number: "SWF-2",
          site_address: "2 Test Street",
        },
        detail: {
          external_ref: "AJBR-2",
          requesting_company_name: "AJS Group",
        },
        selected_photo_urls: [],
      }),
      callClaude: async () =>
        claudeJson("Existing live invoice found; no fake draft PDF."),
      renderReport: async () => ({
        success: true,
        document_id: "report-doc-2",
        render_hash: "hash-2",
      }),
      createDraftInvoice: async () => ({
        skipped: true,
        existing_invoice: {
          xero_invoice_id: "xero-auth-1",
          invoice_number: "INV-AUTH-1",
          status: "AUTHORISED",
        },
      }),
      getToken: async () => {
        calls.getToken.push({});
        return { accessToken: "token", tenantId: "tenant" };
      },
      fetchInvoicePdfBytes: async () => new Uint8Array([1]),
      attachDoc: async (_client, body) => {
        calls.attachDoc.push(body);
        return { document_id: "should-not-happen" };
      },
      ensurePackRow: async () => {},
      patchPack: async () => {},
      markReady: async () => {},
    },
  );

  assertEquals(result.invoice.status, "AUTHORISED");
  assertEquals(result.invoice.document_id, null);
  assertEquals(result.warnings, [
    "draft_invoice_pdf_not_attached_existing_invoice_not_draft",
  ]);
  assertEquals(calls.getToken.length, 0);
  assertEquals(calls.attachDoc.length, 0);
});

Deno.test("createMakesafeDraftInvoice: revises an existing DRAFT invoice instead of silently reusing it", async () => {
  const calls: Record<string, any[]> = { update: [], create: [] };
  const result = await createMakesafeDraftInvoice(
    {},
    {
      reference: "MLB-25767",
      contact_name: "ML Builders",
      line_items: [
        {
          description: "Mould remediation make-safe labour",
          quantity: 3,
          unit_price: 85,
          account_code: "210",
        },
        {
          description: "Mould killer",
          quantity: 1,
          unit_price: 25,
          account_code: "210",
        },
      ],
      operator: "ops-test",
    },
    {
      fetchAllAccrecInvoices: async () => [{
        xero_invoice_id: "xero-draft-25767",
        invoice_number: "INV-0743",
        status: "DRAFT",
        reference: "SWMS-26604 / MLB-25767",
      }],
      updateExistingDraftInvoice: async (_client, args) => {
        calls.update.push(args);
        return {
          success: true,
          skipped: false,
          updated_existing: true,
          xero_invoice_id: args.existing.xero_invoice_id,
          invoice_number: args.existing.invoice_number,
          status: "DRAFT",
          total: 308,
          reference: args.reference,
        };
      },
      createInvoiceFn: async (_client, body) => {
        calls.create.push(body);
        throw new Error("should not create a duplicate invoice");
      },
    },
  );

  assertEquals(result.updated_existing, true);
  assertEquals(result.skipped, false);
  assertEquals(result.xero_invoice_id, "xero-draft-25767");
  assertEquals(calls.update.length, 1);
  assertEquals(calls.create.length, 0);
  assertEquals(calls.update[0].contact, "Major Loss Builders");
  assertEquals(calls.update[0].lineItems.length, 2);
});

Deno.test("compactDraftPackBillingNote: MLB standard invoice basis becomes a terse report note", () => {
  const note = compactDraftPackBillingNote({
    invoice: {
      reference: "MLB-25767",
      contact_name: "Major Loss Builders",
      line_items: [{
        description: "Mould remediation make-safe labour",
        quantity: 3,
        unit_price: 85,
      }, {
        description: "Mould killer",
        quantity: 1,
        unit_price: 25,
      }],
    },
  }, { detail: { external_ref: "MLB-25767" } });

  assertEquals(note, "1 trade x 3 hours.");
});

Deno.test("Xero DRAFT invoice update payload preserves existing LineItemIDs by index", () => {
  const lines = makesafeDraftInvoicePayloadLinesForXeroUpdate([
    {
      Description: "Make-safe labour revised",
      Quantity: 3,
      UnitAmount: 85,
      AccountCode: "210",
      TaxType: "OUTPUT",
    },
    {
      Description: "Mould killer",
      Quantity: 1,
      UnitAmount: 25,
      AccountCode: "210",
      TaxType: "OUTPUT",
    },
  ], {
    LineItems: [
      { LineItemID: "line-1", Description: "Old labour" },
      { LineItemID: "line-2", Description: "Old materials" },
    ],
  });

  assertEquals(lines[0].LineItemID, "line-1");
  assertEquals(lines[1].LineItemID, "line-2");
  assertEquals(lines[0].Description, "Make-safe labour revised");
});

Deno.test("createMakesafeDraftInvoice: blocks $0/invalid MakeSafe pricing before Xero create or update", async () => {
  const failures = evaluateMakesafeDraftInvoicePricing([
    { description: "Make-safe labour", quantity: 4, unit_price: 0 },
  ]);
  assertEquals(failures.length >= 1, true);
  const calls: Record<string, number> = { scan: 0, create: 0 };

  await assertRejects(
    () =>
      createMakesafeDraftInvoice(
        {},
        {
          reference: "MLB-26003",
          contact_name: "Major Loss Builders",
          line_items: [
            { description: "Make-safe labour", quantity: 4, unit_price: 0 },
          ],
        },
        {
          fetchAllAccrecInvoices: async () => {
            calls.scan += 1;
            return [];
          },
          createInvoiceFn: async () => {
            calls.create += 1;
            throw new Error(
              "Xero create should not run when pricing is invalid",
            );
          },
        },
      ),
    Error,
    "draft invoice pricing review required",
  );
  assertEquals(calls.scan, 1);
  assertEquals(calls.create, 0);
});

Deno.test("createMakesafeDraftInvoice: renderer repair can preserve an existing priced DRAFT when Claude emits zero pricing", async () => {
  const calls: Record<string, number> = { update: 0, create: 0 };
  const result = await createMakesafeDraftInvoice(
    {},
    {
      reference: "MLB-25045",
      contact_name: "Major Loss Builders",
      line_items: [
        {
          description: "Make-safe labour placeholder",
          quantity: 4,
          unit_price: 0,
        },
      ],
      preserve_existing_draft_on_invalid_pricing: true,
    },
    {
      fetchAllAccrecInvoices: async () => [{
        xero_invoice_id: "xero-draft-25045",
        invoice_number: "INV-0710",
        status: "DRAFT",
        reference: "SWMS-26642 / MLB-25045",
        sub_total: 300,
        total: 330,
        line_items: [
          {
            Description: "Make-safe labour",
            Quantity: 3,
            UnitAmount: 100,
            LineAmount: 300,
          },
        ],
      }],
      updateExistingDraftInvoice: async () => {
        calls.update += 1;
        throw new Error(
          "should preserve, not update, when incoming pricing is invalid",
        );
      },
      createInvoiceFn: async () => {
        calls.create += 1;
        throw new Error("should not create a duplicate invoice");
      },
    },
  );

  assertEquals(result.skipped, true);
  assertEquals(result.pricing_preserved_from_existing, true);
  assertEquals(result.existing_invoice.invoice_number, "INV-0710");
  assertEquals(calls.update, 0);
  assertEquals(calls.create, 0);
});

Deno.test("createMakesafeDraftInvoice: Revise Pack fails closed on existing non-DRAFT invoice when requested", async () => {
  await assertRejects(
    () =>
      createMakesafeDraftInvoice(
        {},
        {
          reference: "MLB-25767",
          contact_name: "Major Loss Builders",
          line_items: [{
            description: "Mould remediation make-safe labour",
            quantity: 3,
            unit_price: 85,
          }],
          fail_on_existing_non_draft: true,
        },
        {
          fetchAllAccrecInvoices: async () => [{
            xero_invoice_id: "xero-auth-25767",
            invoice_number: "INV-0743",
            status: "AUTHORISED",
            reference: "SWMS-26604 / MLB-25767",
          }],
          updateExistingDraftInvoice: async () => {
            throw new Error("should not update non-DRAFT invoices");
          },
          createInvoiceFn: async () => {
            throw new Error("should not create duplicate invoices");
          },
        },
      ),
    Error,
    "Revise Pack cannot rewrite a non-DRAFT invoice",
  );
});

Deno.test("draftMakesafeReportPack: claimed draft failures are marked failed", async () => {
  const calls: Record<string, any[]> = { markFailed: [] };

  await assertRejects(
    () =>
      draftMakesafeReportPack(
        {},
        { job_id: "job-fail" },
        "routine",
        {
          assertRoutineEligible: async () => {},
          claimDraftPack: async () => {},
          markDraftPackFailed: async (_client, jobId, packKind, err) => {
            calls.markFailed.push({
              jobId,
              packKind,
              message: (err as Error).message,
            });
          },
          loadContext: async () => {
            throw new Error("Claude context exploded");
          },
        },
      ),
    Error,
    "Claude context exploded",
  );

  assertEquals(calls.markFailed.length, 1);
  assertEquals(calls.markFailed[0].jobId, "job-fail");
  assertEquals(calls.markFailed[0].packKind, "main");
});

Deno.test("claimDraftPackForDrafting: failed packs are retryable only by privileged callers", async () => {
  const makeClient = (currentStatus: string) => {
    const inStatuses: string[][] = [];
    return {
      inStatuses,
      from: (_table: string) => {
        const state: { mode: "read" | "update"; statuses: string[] } = {
          mode: "read",
          statuses: [],
        };
        const builder: any = {
          select: () => builder,
          update: () => {
            state.mode = "update";
            return builder;
          },
          eq: () => builder,
          in: (_col: string, values: string[]) => {
            state.statuses = values;
            inStatuses.push(values);
            return builder;
          },
          maybeSingle: () =>
            Promise.resolve({
              data: { id: "pack-1", status: currentStatus },
              error: null,
            }),
          then: (resolve: (value: any) => void) => {
            if (state.mode === "update") {
              const locked = state.statuses.includes(currentStatus)
                ? [{ id: "pack-1", status: currentStatus }]
                : [];
              resolve({ data: locked, error: null });
              return;
            }
            resolve({ data: [], error: null });
          },
        };
        return builder;
      },
    };
  };

  const privileged = makeClient("failed");
  await claimDraftPackForDrafting(privileged, "job-1", "main", "api_key");
  assertEquals(privileged.inStatuses[0], [
    "drafted",
    "admin_to_send_report",
    "failed",
  ]);

  const routine = makeClient("failed");
  await assertRejects(
    () => claimDraftPackForDrafting(routine, "job-1", "main", "routine"),
    Error,
    "current status is 'failed'",
  );
  assertEquals(routine.inStatuses[0], ["drafted"]);
});

Deno.test("draftMakesafeReportPackDue: batch runner reuses Draft Pack per due job", async () => {
  const calls: any[] = [];
  const result = await draftMakesafeReportPackDue(
    {},
    { limit: 2, operator: "cron test" },
    "routine",
    {
      listDueJobs: async (_client, opts) => {
        assertEquals(opts.limit, 2);
        assertEquals(opts.packKind, "main");
        return [{ job_id: "job-1" }, { job_id: "job-2" }];
      },
      draftPack: async (_client, body, authMode) => {
        calls.push({ body, authMode });
        return { success: true, job_id: body.job_id };
      },
    },
  );

  assertEquals(result.success, true);
  assertEquals(result.due_count, 2);
  assertEquals(result.drafted_count, 2);
  assertEquals(result.error_count, 0);
  assertEquals(calls.map((c) => c.body.job_id), ["job-1", "job-2"]);
  assertEquals(calls[0].body.operator, "cron test");
  assertEquals(calls[0].body.source, "draft_makesafe_report_pack_due");
  assertEquals(calls[0].authMode, "routine");
});

Deno.test("draftMakesafeReportPackDue: dry run lists due jobs without drafting", async () => {
  let draftCalled = false;
  const result = await draftMakesafeReportPackDue(
    {},
    { dry_run: true },
    "routine",
    {
      listDueJobs: async () => [{ job_id: "job-1" }],
      draftPack: async () => {
        draftCalled = true;
        return {};
      },
    },
  );

  assertEquals(result.success, true);
  assertEquals(result.dry_run, true);
  assertEquals(result.due_count, 1);
  assertEquals(draftCalled, false);
});

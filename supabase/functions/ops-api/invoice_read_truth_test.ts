// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  OPEN_INVOICE_MAX_PAGES,
  OPEN_INVOICE_PAGE_SIZE,
  readAllOpenInvoices,
  sentToContactOf,
  summarizeOpenInvoices,
} from "./invoice_read_truth.ts";

const TODAY = "2026-10-26";

Deno.test("INT-35: a failed open-invoice read is unknown, never $0", async () => {
  const read = await readAllOpenInvoices(() =>
    Promise.resolve({ data: null, error: { message: "statement timeout" } })
  );
  assertEquals(summarizeOpenInvoices(read, TODAY), {
    outstanding: null,
    overdue: null,
    summary_error: "open_invoice_read_failed",
  });
});

Deno.test("INT-35: a thrown read is unknown, never $0", async () => {
  const read = await readAllOpenInvoices(() =>
    Promise.reject(new Error("network"))
  );
  assertEquals(summarizeOpenInvoices(read, TODAY).outstanding, null);
  assertEquals(
    summarizeOpenInvoices(read, TODAY).summary_error,
    "open_invoice_read_failed",
  );
});

Deno.test("INT-35: a true zero stays $0", async () => {
  const read = await readAllOpenInvoices(() =>
    Promise.resolve({ data: [], error: null })
  );
  assertEquals(summarizeOpenInvoices(read, TODAY), {
    outstanding: 0,
    overdue: 0,
    summary_error: null,
  });
});

Deno.test("INT-35: sums outstanding and overdue to the cent", () => {
  const summary = summarizeOpenInvoices({
    rows: [
      { status: "AUTHORISED", amount_due: 100.1, due_date: "2026-10-01" },
      { status: "AUTHORISED", amount_due: "200.20", due_date: "2026-11-30" },
      { status: "SUBMITTED", amount_due: 0, due_date: null },
    ],
    error: null,
  }, TODAY);
  assertEquals(summary, {
    outstanding: 300.3,
    overdue: 100.1,
    summary_error: null,
  });
});

Deno.test("INT-35: an open invoice with no amount due on record makes the summary unknown", () => {
  for (const missing of [null, undefined, "", "abc"]) {
    const summary = summarizeOpenInvoices({
      rows: [
        { status: "AUTHORISED", amount_due: 50, due_date: "2026-10-01" },
        {
          status: "AUTHORISED",
          amount_due: missing as unknown as number,
          due_date: "2026-10-01",
        },
      ],
      error: null,
    }, TODAY);
    assertEquals(summary, {
      outstanding: null,
      overdue: null,
      summary_error: "open_invoice_amount_due_missing",
    });
  }
});

Deno.test("INT-35: the read pages past PostgREST's 1,000-row stop", async () => {
  const total = OPEN_INVOICE_PAGE_SIZE * 2 + 5;
  const ranges: Array<[number, number]> = [];
  const read = await readAllOpenInvoices((from, to) => {
    ranges.push([from, to]);
    const n = Math.max(0, Math.min(to, total - 1) - from + 1);
    return Promise.resolve({
      data: Array.from(
        { length: n },
        () => ({ amount_due: 1, due_date: "2026-12-01" }),
      ),
      error: null,
    });
  });
  assertEquals(ranges, [[0, 999], [1000, 1999], [2000, 2999]]);
  assertEquals(summarizeOpenInvoices(read, TODAY).outstanding, total);
});

Deno.test("INT-35: a failure on a later page is unknown, not the partial sum", async () => {
  let page = 0;
  const read = await readAllOpenInvoices(() => {
    page++;
    if (page === 1) {
      return Promise.resolve({
        data: Array.from(
          { length: OPEN_INVOICE_PAGE_SIZE },
          () => ({ amount_due: 10 }),
        ),
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: { message: "boom" } });
  });
  assertEquals(summarizeOpenInvoices(read, TODAY).outstanding, null);
});

Deno.test("INT-35: running out of pages is reported as incomplete", async () => {
  const read = await readAllOpenInvoices(() =>
    Promise.resolve({
      data: Array.from(
        { length: OPEN_INVOICE_PAGE_SIZE },
        () => ({ amount_due: 1 }),
      ),
      error: null,
    })
  );
  assertEquals(
    read.rows.length,
    OPEN_INVOICE_PAGE_SIZE * OPEN_INVOICE_MAX_PAGES,
  );
  assertEquals(
    summarizeOpenInvoices(read, TODAY).summary_error,
    "open_invoice_read_incomplete",
  );
});

Deno.test("INT-36: sent_to_contact is Xero's own flag or null", () => {
  assertEquals(
    sentToContactOf({ SentToContact: true, Status: "AUTHORISED" }),
    true,
  );
  assertEquals(
    sentToContactOf({ SentToContact: false, Status: "AUTHORISED" }),
    false,
  );
  assertEquals(sentToContactOf(JSON.stringify({ SentToContact: true })), true);
  // No flag on the stored record: not known, never "not sent".
  assertEquals(sentToContactOf({ Status: "AUTHORISED" }), null);
  // Status never stands in for the flag.
  assertEquals(sentToContactOf({ Status: "SENT" }), null);
  assertEquals(sentToContactOf({ SentToContact: "true" }), null);
  assertEquals(sentToContactOf(null), null);
  assertEquals(sentToContactOf("not json"), null);
  assertEquals(sentToContactOf([]), null);
});

Deno.test("INT-35/36: index.ts wires the summary and the sent flag", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const start = src.indexOf("async function listInvoices(");
  const end = src.indexOf("\nasync function ", start + 1);
  const body = src.slice(start, end);
  assertEquals(body.includes("readAllOpenInvoices("), true);
  assertEquals(body.includes("summarizeOpenInvoices("), true);
  assertEquals(body.includes("summary_error"), true);
  assertEquals(body.includes("amount_due || 0"), false);
  assertEquals(body.includes("sent_to_contact:raw_json->SentToContact"), true);
  const jd = src.slice(src.indexOf("async function jobDetail("));
  assertEquals(
    jd.slice(0, 6000).includes("sentToContactOf(inv.raw_json)"),
    true,
  );
});

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _refMatchesExternalRefForTest,
  _resolveJobsByExternalRefForTest,
} from "./index.ts";

function makeResolverClient(details: any[], jobs: any[]) {
  function builder(table: string) {
    const rows = table === "makesafe_job_details"
      ? details.slice()
      : jobs.slice();
    const preds: Array<(r: any) => boolean> = [];
    const b: any = {
      select: () => b,
      ilike: (col: string, pattern: string) => {
        const needle = String(pattern).replace(/%/g, "").toLowerCase();
        preds.push((r) =>
          String(r?.[col] || "").toLowerCase().includes(needle)
        );
        return b;
      },
      not: (col: string, op: string, val: string) => {
        if (op === "in") {
          const excluded = val.replace(/[()]/g, "").split(",").map((s) =>
            s.trim().replace(/^['\"]|['\"]$/g, "")
          );
          preds.push((r) => !excluded.includes(String(r?.[col] || "")));
        }
        return b;
      },
      in: async (col: string, vals: any[]) => {
        const data = rows.filter((r) =>
          vals.includes(r?.[col]) && preds.every((p) => p(r))
        );
        return { data, error: null };
      },
      limit: async () => {
        const data = rows.filter((r) => preds.every((p) => p(r)));
        return { data, error: null };
      },
    };
    return b;
  }
  return { from: (table: string) => builder(table) };
}

Deno.test("trade invoice ref matcher accepts AJ shorthand for stored AJBR refs", () => {
  assertEquals(_refMatchesExternalRefForTest("AJ66934", "AJBR-66934"), true);
  assertEquals(_refMatchesExternalRefForTest("AJBR 66934", "AJ66934"), true);
  assertEquals(_refMatchesExternalRefForTest("66934", "AJBR-66934"), true);
});

Deno.test("trade invoice ref matcher keeps unrelated prefixes separate", () => {
  assertEquals(_refMatchesExternalRefForTest("AJ66934", "MLB-66934"), false);
  assertEquals(_refMatchesExternalRefForTest("AJS66934", "AJBR-66934"), false);
  assertEquals(_refMatchesExternalRefForTest("MLB25248", "MLB-25248"), true);
});

Deno.test("trade invoice resolver maps AJ typed refs to active AJBR jobs", async () => {
  const client = makeResolverClient(
    [
      { job_id: "job-aj", external_ref: "AJBR-66934" },
      { job_id: "job-mlb", external_ref: "MLB-66934" },
    ],
    [
      { id: "job-aj", job_number: "SWMS-AJ", status: "complete" },
      { id: "job-mlb", job_number: "SWMS-MLB", status: "complete" },
    ],
  );

  const res = await _resolveJobsByExternalRefForTest(
    client,
    ["AJ66934"],
    "('cancelled','archived')",
  );

  assertEquals(Object.keys(res.byId).sort(), ["job-aj"]);
  assertEquals(res.byRef.AJ66934.map((j: any) => j.id), ["job-aj"]);
});

Deno.test("trade invoice resolver resolves ARCHIVED make-safe with narrowed exclude (2026-06-18 fix)", async () => {
  // Regression: make-safe jobs get archived off the ops board but the trade still
  // must be paid. With the narrowed extra-items exclude (dead states only — no
  // 'archived'/'complete'), an archived job by builder ref must resolve.
  const client = makeResolverClient(
    [
      { job_id: "job-archived", external_ref: "AJBR 66933" },
      { job_id: "job-dead", external_ref: "AJBR 66999" },
    ],
    [
      { id: "job-archived", job_number: "AJBR 66933", status: "archived" },
      { id: "job-dead", job_number: "AJBR 66999", status: "cancelled" },
    ],
  );

  // The new exclude list used by the extra-items lane: dead states only.
  const NARROWED_EXCLUDE =
    "('lost','cancelled','deleted','duplicate','duplicated','void','voided')";

  const res = await _resolveJobsByExternalRefForTest(
    client,
    ["AJBR 66933", "AJBR 66999"],
    NARROWED_EXCLUDE,
  );

  // archived resolves; cancelled (genuinely dead) stays excluded.
  assertEquals(Object.keys(res.byId).sort(), ["job-archived"]);
  assertEquals(res.byRef["AJBR66933"].map((j: any) => j.id), ["job-archived"]);
  assertEquals(res.byRef["AJBR66999"], undefined);
});

Deno.test("trade invoice resolver leaves bare numeric duplicate cores ambiguous", async () => {
  const client = makeResolverClient(
    [
      { job_id: "job-aj", external_ref: "AJBR-66934" },
      { job_id: "job-mlb", external_ref: "MLB-66934" },
    ],
    [
      { id: "job-aj", job_number: "SWMS-AJ", status: "complete" },
      { id: "job-mlb", job_number: "SWMS-MLB", status: "complete" },
    ],
  );

  const res = await _resolveJobsByExternalRefForTest(
    client,
    ["66934"],
    "('cancelled','archived')",
  );

  assertEquals(Object.keys(res.byId).sort(), ["job-aj", "job-mlb"]);
  assertEquals(res.byRef["66934"].map((j: any) => j.id).sort(), [
    "job-aj",
    "job-mlb",
  ]);
});

Deno.test("trade invoice submit saves local lines before Xero and checks insert errors", async () => {
  const source = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  // NOTE: keep in sync with toTradeInvoiceLineRow. `_woProblems: _wp` joined the
  // destructure when WO labour reconciliation landed but this literal was never
  // updated, so this assertion failed and masked every ordering pin below it —
  // including the ones guarding the assignment-lock/Xero-push sequence.
  const stripMemoryOnlyField = source.indexOf(
    "const { site_address: _siteAddress, _hoursFlag: _hf, _woProblems: _wp, ...dbLine } = { ...defaults, ...line }",
  );
  const normalizedShape = source.indexOf(
    "const toTradeInvoiceLineRow = (line: any, defaults: any = {})",
  );
  const checkedLineInsert = source.indexOf(
    "const { error: lineErr } = await client.from('trade_invoice_lines').insert(lineRows)",
  );
  const checkedAssignmentStamp = source.indexOf(
    "Failed to lock invoiced job cards before Xero push:",
  );
  const duplicateExtraReview = source.indexOf(
    "Possible duplicate searched-in job line(s):",
  );
  const duplicateXeroWarning = source.indexOf(
    "POSSIBLE DUPLICATE - verify prior trade invoice before approving",
  );
  const conditionalStamp = source.indexOf(
    ".or('invoiced_in.is.null,invoiced_in.in.(' + claimableStampInvoiceIds.join(',') + ')')",
  );
  const stampOwnership = source.indexOf(
    ".eq('user_id', tradeUser.id)",
    checkedAssignmentStamp,
  );
  const failureMessage = source.indexOf("Failed to save invoice line items:");
  const xeroPush = source.indexOf(
    "// ── Auto-push to Xero as DRAFT ACCPAY bill ──",
  );

  assert(
    stripMemoryOnlyField > -1,
    "extra line insert strips site_address and _hoursFlag before PostgREST insert",
  );
  assert(
    normalizedShape > -1,
    "trade invoice lines use one normalized PostgREST insert shape",
  );
  assert(
    checkedLineInsert > -1,
    "trade_invoice_lines insert error is captured",
  );
  assert(failureMessage > checkedLineInsert, "line insert failure is surfaced");
  assert(
    checkedLineInsert < xeroPush,
    "local invoice lines are saved before any Xero push",
  );
  assert(
    checkedAssignmentStamp > checkedLineInsert,
    "assigned-card invoice lock is checked after local line save",
  );
  assert(
    checkedAssignmentStamp < xeroPush,
    "assigned-card invoice lock is checked before any Xero push",
  );
  assert(
    conditionalStamp > checkedAssignmentStamp,
    "assigned-card invoice lock conditionally claims only unlocked/released assignments",
  );
  assert(
    stampOwnership > checkedAssignmentStamp,
    "assigned-card invoice lock remains scoped to the authenticated trade",
  );
  assert(
    duplicateExtraReview > -1,
    "searched-in duplicate risk is flagged on the local invoice for review",
  );
  assert(
    duplicateXeroWarning > duplicateExtraReview,
    "searched-in duplicate risk is visible in the Xero draft line description",
  );
});

Deno.test("trade invoice PDF attach validates the Xero bill belongs to the authenticated trade", async () => {
  const source = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  const attachStart = source.lastIndexOf("case 'attach_invoice_pdf':");
  const attachCase = source.slice(
    attachStart,
    source.indexOf("case 'delete_trade_invoice':", attachStart),
  );

  assert(
    attachCase.includes(".eq('user_id', tradeUser.id)"),
    "PDF attach is scoped to the authenticated trade",
  );
  assert(
    attachCase.includes(".eq('xero_bill_id', attachBillId)"),
    "PDF attach looks up the returned Xero bill id",
  );
  assert(
    attachCase.includes("Invoice not found for this Xero bill"),
    "PDF attach rejects unowned/unknown Xero bill ids",
  );
  assert(
    attachCase.includes("const maxPdfBytes = 5 * 1024 * 1024"),
    "PDF attach enforces a bounded payload size",
  );
  assert(
    attachCase.includes("PDF payload must be a PDF document"),
    "PDF attach validates the decoded payload is a PDF",
  );
  assert(
    attachCase.includes("const attachFilename = ((attachInv.invoice_number"),
    "PDF attach derives the attachment filename from the server invoice row",
  );
  assert(
    attachCase.indexOf(
      "const { accessToken, tenantId } = await getToken(client)",
    ) > attachCase.indexOf("PDF payload must be a PDF document"),
    "PDF attach validates payload before requesting a Xero token",
  );
});

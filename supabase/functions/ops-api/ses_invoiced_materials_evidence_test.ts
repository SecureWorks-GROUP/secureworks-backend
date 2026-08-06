import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifySesInvoiceLineDescription,
  readSesInvoicedMaterialsEvidence,
  readSesReleasedCycleEvidence,
  type SesIssuedInvoiceCandidate,
} from "./ses_invoiced_materials_evidence.ts";

/**
 * Line wording throughout is taken from the shape of real MLB SES invoices,
 * with street addresses removed — suburb and builder reference only.
 */
function invoice(
  overrides: Partial<SesIssuedInvoiceCandidate> = {},
): SesIssuedInvoiceCandidate {
  return {
    invoice_id: "xero-uuid-1",
    invoice_number: "INV-0942",
    status: "AUTHORISED",
    invoice_type: "ACCREC",
    line_items: [],
    ...overrides,
  };
}

function line(Description: string, LineAmount: number) {
  return { Description, LineAmount };
}

Deno.test("classifier reads labour, materials, charged services and nothing else", () => {
  for (
    const labour of [
      "MLB-23067 - Queens Park - follow-up attendance to connect temporary fence panels - 2 trades x 2 hours",
      "MLB-25971 - reattendance - 1 trade x 5 hours",
      "Make-Safe Labour - mould remediation and roof inspection - 1 trade x 3 hours",
      "MLB-25096 - Temporary fencing retrieval, collection and loading allowance - 2 hours",
      "MLB-25881 - Morley - removed and disposed of ceiling, polyweave + staples, 1 trade x 3.5hr labour",
      "MLB-26527 - Lesmurdie call-out including travel allowance to the Perth hills",
    ]
  ) {
    assertEquals(
      classifySesInvoiceLineDescription(labour),
      "labour",
      `expected labour: ${labour}`,
    );
  }

  for (
    const materials of [
      "MLB-26925PO-55928 - Materials: 15mm plyboard x2, 90x35 H3 framing x5, bugles, fixings/consumables",
      "MLB-23067 - Temporary fence hire: 2 panels x $5 per panel per week x 12 weeks minimum",
      "MLB-23067 - Star pickets supplied - 2 units",
      "MLB-23067 - Cable ties and small consumables",
      "MLB-27129PO-56730 - Success - silicone, sealant and fixings consumed on site",
      "MLB-26527 - Roof make-safe materials: tarpaulins, silicone sealant, sand bags and fixings/consumables",
      "MLB-26390 - Screw and fixing consumable used to re-secure gutter clip",
    ]
  ) {
    assertEquals(
      classifySesInvoiceLineDescription(materials),
      "materials",
      `expected materials: ${materials}`,
    );
  }

  for (
    const service of [
      "MLB-27482 - Glass disposal",
      "MLB-25881 - ceiling removal/disposal",
      "MLB-26925PO-55928 - Disposal of damaged glass and debris",
    ]
  ) {
    assertEquals(
      classifySesInvoiceLineDescription(service),
      "excluded_service",
      `expected excluded_service: ${service}`,
    );
  }

  // Real production wording this reading cannot place. It must stay
  // unrecognised rather than be guessed into a bucket — the whole reading then
  // refuses, which is the safe direction.
  for (const unknown of ["Mould remediation spray", "polyweave and staples"]) {
    assertEquals(
      classifySesInvoiceLineDescription(unknown),
      "unrecognised",
      `expected unrecognised: ${unknown}`,
    );
  }
  assertEquals(classifySesInvoiceLineDescription(""), "unrecognised");
  assertEquals(classifySesInvoiceLineDescription(null), "unrecognised");
});

Deno.test("an hours line that also names materials is labour, never materials evidence", () => {
  // The precedence that stops a works narrative from paying for itself: this
  // line mentions installed materials but bills hours, so counting it as
  // materials would invent a materials figure out of labour money.
  assertEquals(
    classifySesInvoiceLineDescription(
      "MLB-25096 - Balcatta temporary fencing make-safe - 2 trades x 3 hours including trailer use, install of panels and fixings supplied",
    ),
    "labour",
  );
  const reading = readSesInvoicedMaterialsEvidence([
    invoice({
      line_items: [
        line(
          "MLB-25096 - Balcatta temporary fencing make-safe - 2 trades x 3 hours including install of panels and fixings supplied",
          510,
        ),
      ],
    }),
  ]);
  assertEquals(reading.kind, "none");
  if (reading.kind !== "none") throw new Error("unreachable");
  assertEquals(reading.reason_code, "invoice_prices_no_materials");
});

Deno.test("a labour-only invoice never silences the materials question", () => {
  const reading = readSesInvoicedMaterialsEvidence([
    invoice({
      invoice_number: "INV-1000",
      line_items: [
        line("MLB-22745 - Winthrop roof make-safe - 2 trades x 3 hours", 510),
      ],
    }),
  ]);
  assertEquals(reading.kind, "none");
  if (reading.kind !== "none") throw new Error("unreachable");
  assertEquals(reading.reason_code, "invoice_prices_no_materials");
  assertStringIncludes(reading.detail, "prices no materials");
});

Deno.test("labour plus a charged service is still not a materials answer", () => {
  // Disposal is money, and it is not a material. Counting it would answer the
  // materials question with a figure that buys none of the recorded materials.
  const reading = readSesInvoicedMaterialsEvidence([
    invoice({
      invoice_number: "INV-1002",
      line_items: [
        line("MLB-26705 - Balga roof make-safe - 1 trade x 3 hours", 255),
        line("MLB-26705 - Disposal of damaged glass and debris", 35),
      ],
    }),
  ]);
  assertEquals(reading.kind, "none");
  if (reading.kind !== "none") throw new Error("unreachable");
  assertEquals(reading.reason_code, "invoice_prices_no_materials");
});

Deno.test("an itemised temporary-fencing invoice answers with its materials total", () => {
  // Queens Park SWMS-26845 / INV-0942, live 2026-08-06: labour $340 plus hire
  // $120, pickets $27 and consumables $25 = $172 of materials.
  const reading = readSesInvoicedMaterialsEvidence([
    invoice({
      line_items: [
        line(
          "MLB-23067 - Queens Park - follow-up attendance to connect temporary fence panels - 2 trades x 2 hours",
          340,
        ),
        line(
          "MLB-23067 - Temporary fence hire: 2 panels x $5 per panel per week = $10.00 per week x 12 weeks minimum",
          120,
        ),
        line("MLB-23067 - Star pickets supplied - 2 units", 27),
        line("MLB-23067 - Cable ties and small consumables", 25),
      ],
    }),
  ]);
  assertEquals(reading.kind, "evidence");
  if (reading.kind !== "evidence") throw new Error("unreachable");
  assertEquals(reading.evidence.materials_ex_gst, 172);
  assertEquals(reading.evidence.invoice_number, "INV-0942");
  assertEquals(reading.evidence.status, "AUTHORISED");
  assertEquals(reading.evidence.labour_line_count, 1);
  assertEquals(reading.evidence.materials_lines.length, 3);
});

Deno.test("a charged service is excluded from the materials total, not added to it", () => {
  // Herne Hill SWMS-26955 / INV-0994, live 2026-08-06: $270 of materials, and
  // the $35 disposal is a service that must not inflate the materials answer.
  const reading = readSesInvoicedMaterialsEvidence([
    invoice({
      invoice_number: "INV-0994",
      line_items: [
        line(
          "MLB-26925PO-55928 - Herne Hill board-up make-safe - 2 trades x 3.5 hours",
          595,
        ),
        line(
          "MLB-26925PO-55928 - Materials: 15mm plyboard x2, 90x35 H3 framing x5, bugles, fixings/consumables",
          270,
        ),
        line("MLB-26925PO-55928 - Disposal of damaged glass and debris", 35),
      ],
    }),
  ]);
  assertEquals(reading.kind, "evidence");
  if (reading.kind !== "evidence") throw new Error("unreachable");
  assertEquals(reading.evidence.materials_ex_gst, 270);
  assertEquals(reading.evidence.excluded_service_line_count, 1);
});

Deno.test("only issued ACCREC money counts, and a voided predecessor is ignored", () => {
  const materialsLine = line(
    "MLB-23067 - Cable ties and small consumables",
    25,
  );
  const labourLine = line("MLB-23067 - Queens Park - 2 trades x 2 hours", 340);

  // Queens Park really carries both: INV-0868 VOIDED and INV-0942 AUTHORISED.
  const reading = readSesInvoicedMaterialsEvidence([
    invoice({
      invoice_id: "voided",
      invoice_number: "INV-0868",
      status: "VOIDED",
      line_items: [labourLine, line("MLB-23067 - Star pickets supplied", 27)],
    }),
    invoice({ line_items: [labourLine, materialsLine] }),
  ]);
  assertEquals(reading.kind, "evidence");
  if (reading.kind !== "evidence") throw new Error("unreachable");
  assertEquals(reading.evidence.invoice_number, "INV-0942");
  assertEquals(reading.evidence.materials_ex_gst, 25);

  // A DRAFT is editable and unpayable, so it is not committed money.
  for (const status of ["DRAFT", "SUBMITTED", "DELETED"]) {
    const draft = readSesInvoicedMaterialsEvidence([
      invoice({ status, line_items: [labourLine, materialsLine] }),
    ]);
    assertEquals(draft.kind, "none", `${status} must not count as issued`);
    if (draft.kind !== "none") throw new Error("unreachable");
    assertEquals(draft.reason_code, "no_issued_invoice");
  }

  // A supplier bill is not this card's revenue.
  const bill = readSesInvoicedMaterialsEvidence([
    invoice({ invoice_type: "ACCPAY", line_items: [materialsLine] }),
  ]);
  assertEquals(bill.kind, "none");
  if (bill.kind !== "none") throw new Error("unreachable");
  assertEquals(bill.reason_code, "no_issued_invoice");

  assertEquals(readSesInvoicedMaterialsEvidence([]).kind, "none");
});

Deno.test("PAID money answers as readily as AUTHORISED money", () => {
  const reading = readSesInvoicedMaterialsEvidence([
    invoice({
      invoice_number: "INV-0847",
      status: "PAID",
      line_items: [
        line(
          "MLB-26582 - Hillarys patio ceiling make-safe - 1 trade x 3 hours",
          255,
        ),
        line(
          "MLB-26582 - Timber support, bugle screws and fixings/consumables",
          35,
        ),
      ],
    }),
  ]);
  assertEquals(reading.kind, "evidence");
  if (reading.kind !== "evidence") throw new Error("unreachable");
  assertEquals(reading.evidence.materials_ex_gst, 35);
});

Deno.test("two issued invoices on one card refuse rather than pick one", () => {
  // Two issued invoices on one card is the shape a double-bill takes. Choosing
  // between them would be a guess about which money the materials belong to.
  const reading = readSesInvoicedMaterialsEvidence([
    invoice({ line_items: [line("MLB-23067 - Star pickets supplied", 27)] }),
    invoice({
      invoice_id: "xero-uuid-2",
      invoice_number: "INV-0943",
      line_items: [line("MLB-23067 - Cable ties and consumables", 25)],
    }),
  ]);
  assertEquals(reading.kind, "none");
  if (reading.kind !== "none") throw new Error("unreachable");
  assertEquals(reading.reason_code, "multiple_issued_invoices");
  assertStringIncludes(reading.detail, "INV-0942");
  assertStringIncludes(reading.detail, "INV-0943");
});

Deno.test("an invoice this reading cannot fully account for refuses", () => {
  // Absent mirrored lines: 8 of the 29 issued SES invoices measured on
  // 2026-08-06 store no line items at all, so what they priced is unreadable.
  const absent = readSesInvoicedMaterialsEvidence([
    invoice({ line_items: [] }),
  ]);
  assertEquals(absent.kind, "none");
  if (absent.kind !== "none") throw new Error("unreachable");
  assertEquals(absent.reason_code, "invoice_line_items_absent");

  const notArray = readSesInvoicedMaterialsEvidence([
    invoice({ line_items: null }),
  ]);
  assertEquals(notArray.kind, "none");
  if (notArray.kind !== "none") throw new Error("unreachable");
  assertEquals(notArray.reason_code, "invoice_line_items_absent");

  // One line nobody can bucket makes any total a partial reading presented as
  // a whole one, so the whole invoice refuses even though it names materials.
  const unrecognised = readSesInvoicedMaterialsEvidence([
    invoice({
      invoice_number: "INV-1039",
      line_items: [
        line(
          "MLB-25400PO-56788 - Tapping ceiling make-safe - 1 trade x 3 hours",
          255,
        ),
        line("Mould remediation spray", 25),
      ],
    }),
  ]);
  assertEquals(unrecognised.kind, "none");
  if (unrecognised.kind !== "none") throw new Error("unreachable");
  assertEquals(unrecognised.reason_code, "invoice_line_unrecognised");
  assertStringIncludes(unrecognised.detail, "Mould remediation spray");

  // An unreadable amount is not a zero.
  const unreadable = readSesInvoicedMaterialsEvidence([
    invoice({
      line_items: [
        line("MLB-23067 - Queens Park - 2 trades x 2 hours", 340),
        { Description: "MLB-23067 - Cable ties and small consumables" },
      ],
    }),
  ]);
  assertEquals(unreadable.kind, "none");
  if (unreadable.kind !== "none") throw new Error("unreachable");
  assertEquals(unreadable.reason_code, "invoice_line_unreadable");

  const unnamed = readSesInvoicedMaterialsEvidence([
    invoice({ line_items: [{ LineAmount: 172 }] }),
  ]);
  assertEquals(unnamed.kind, "none");
  if (unnamed.kind !== "none") throw new Error("unreachable");
  assertEquals(unnamed.reason_code, "invoice_line_unreadable");
});

Deno.test("a line amount falls back to quantity x unit price, and snake_case is read", () => {
  const reading = readSesInvoicedMaterialsEvidence([
    invoice({
      line_items: [
        {
          Description: "MLB-23067 - Queens Park - 2 trades x 2 hours",
          Quantity: 4,
          UnitAmount: 85,
        },
        {
          description: "MLB-23067 - Star pickets supplied",
          quantity: 2,
          unit_amount: 13.5,
        },
      ],
    }),
  ]);
  assertEquals(reading.kind, "evidence");
  if (reading.kind !== "evidence") throw new Error("unreachable");
  assertEquals(reading.evidence.materials_ex_gst, 27);
});

Deno.test("a zero-value materials line is not an answer", () => {
  // A $0 line prices nothing, so it must leave the question open rather than
  // record an answer of zero the operator never gave.
  const reading = readSesInvoicedMaterialsEvidence([
    invoice({
      line_items: [
        line("MLB-23067 - Queens Park - 2 trades x 2 hours", 340),
        line("MLB-23067 - Cable ties and small consumables", 0),
      ],
    }),
  ]);
  assertEquals(reading.kind, "none");
  if (reading.kind !== "none") throw new Error("unreachable");
  assertEquals(reading.reason_code, "invoice_prices_no_materials");
});

// ---------------------------------------------------------------------------
// The terminal rule: a shipped-and-billed cycle is never asked to price.
// ---------------------------------------------------------------------------

const CURRENT_CYCLE = "e773a6a2-dc6e-46f2-9a65-b768303a407d";
const PRIOR_CYCLE = "a1630441-16e2-41cc-bd1f-286fc5897d73";

function proof(cycles: string[], route_kind = "report") {
  return {
    route_kind,
    proven_at: "2026-08-05T11:25:56.439Z",
    attendance_cycle_ids: cycles,
  };
}

const ISSUED = [
  invoice({
    invoice_number: "INV-1137",
    line_items: [
      line("MLB-27301 - Woodvale roof make-safe - 1 trade x 3 hours", 310),
    ],
  }),
];

Deno.test("a shipped and billed current cycle is terminal", () => {
  // Woodvale SWMS-261128 / INV-1137, live 2026-08-06: three route proofs on
  // 5 August and an AUTHORISED invoice. Note the invoice itself is labour-only
  // here — the terminal rule reaches cards the invoice reading cannot, which is
  // the whole point of it being a separate, stronger rule.
  const reading = readSesReleasedCycleEvidence({
    attendance_cycle_id: CURRENT_CYCLE,
    route_proofs: [
      proof([PRIOR_CYCLE, CURRENT_CYCLE], "report"),
      proof([PRIOR_CYCLE, CURRENT_CYCLE], "photo"),
      proof([PRIOR_CYCLE, CURRENT_CYCLE], "invoice"),
    ],
    invoices: ISSUED,
  });
  assertEquals(reading.kind, "released");
  if (reading.kind !== "released") throw new Error("unreachable");
  assertEquals(reading.evidence.route_kinds, ["invoice", "photo", "report"]);
  assertEquals(reading.evidence.invoice_number, "INV-1137");
  assertEquals(reading.evidence.invoice_status, "AUTHORISED");

  // …and that same invoice, read for its materials, answers nothing.
  const invoiced = readSesInvoicedMaterialsEvidence(ISSUED);
  assertEquals(invoiced.kind, "none");
  if (invoiced.kind !== "none") throw new Error("unreachable");
  assertEquals(invoiced.reason_code, "invoice_prices_no_materials");
});

Deno.test("a re-attendance reopens the question a prior send settled", () => {
  // The card shipped, but on the cycle BEFORE this one. The new cycle's
  // materials were never billed, so terminal must not silence them.
  const reading = readSesReleasedCycleEvidence({
    attendance_cycle_id: CURRENT_CYCLE,
    route_proofs: [proof([PRIOR_CYCLE])],
    invoices: ISSUED,
  });
  assertEquals(reading.kind, "none");
  if (reading.kind !== "none") throw new Error("unreachable");
  assertEquals(reading.reason_code, "current_cycle_not_shipped");
  assertStringIncludes(reading.detail, "still open work");
});

Deno.test("terminal is proven from send evidence, never inferred", () => {
  // Queens Park SWMS-26845: an AUTHORISED invoice and zero route proofs. The
  // Captain ruled it was never sent, and money alone must never say otherwise.
  const neverSent = readSesReleasedCycleEvidence({
    attendance_cycle_id: "d760ea74-b3d8-496c-8aab-31784cb1d63b",
    route_proofs: [],
    invoices: ISSUED,
  });
  assertEquals(neverSent.kind, "none");
  if (neverSent.kind !== "none") throw new Error("unreachable");
  assertEquals(neverSent.reason_code, "current_cycle_not_shipped");
  assertStringIncludes(neverSent.detail, "nothing has shipped");

  // Shipped but unbilled is not terminal either — both halves are required.
  const unbilled = readSesReleasedCycleEvidence({
    attendance_cycle_id: CURRENT_CYCLE,
    route_proofs: [proof([CURRENT_CYCLE])],
    invoices: [invoice({ status: "DRAFT" })],
  });
  assertEquals(unbilled.kind, "none");
  if (unbilled.kind !== "none") throw new Error("unreachable");
  assertEquals(unbilled.reason_code, "not_billed");

  // No cycle to attribute a send to fails closed rather than matching any proof.
  const noCycle = readSesReleasedCycleEvidence({
    attendance_cycle_id: null,
    route_proofs: [proof([CURRENT_CYCLE])],
    invoices: ISSUED,
  });
  assertEquals(noCycle.kind, "none");
  if (noCycle.kind !== "none") throw new Error("unreachable");
  assertEquals(noCycle.reason_code, "no_current_attendance_cycle");

  // A proof carrying no cycle attribution cannot settle a cycle.
  const unattributed = readSesReleasedCycleEvidence({
    attendance_cycle_id: CURRENT_CYCLE,
    route_proofs: [{
      route_kind: "report",
      proven_at: null,
      attendance_cycle_ids: null,
    }],
    invoices: ISSUED,
  });
  assertEquals(unattributed.kind, "none");
  if (unattributed.kind !== "none") throw new Error("unreachable");
  assertEquals(unattributed.reason_code, "current_cycle_not_shipped");
});

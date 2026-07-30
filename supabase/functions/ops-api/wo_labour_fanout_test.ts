// Tests for the WO labour fan-out (trade.html Pay tab, Work Order mode).
//
// Regression anchor — the reported production bug (2026-07-30): Alyx worked
// out job SWF-26767 as WO $559.50 with one labour line "Tendo" 11.5h × $25 =
// $287.50, net $272 to Alyx. The $287.50 was deducted from Alyx but no pay
// record was ever created for Tendo — the labour lines were dropped by
// generate_trade_invoice. These tests pin the fan-out that now routes each
// named labour line into a pending payout invoice for the matched crew member.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _buildWoLabourPayoutInvoice,
  _cleanWoLabourLines,
  _cleanWoName,
  _extractWoLabourEntries,
  _resolveWoLabourUsers,
  _tradeInvoiceXeroTax,
  _woLabourProblemNote,
  _woNetMismatch,
  type WoLabourEntry,
} from "./wo_labour_fanout.ts";

const NOW = "2026-07-30T00:00:00.000Z";

// The production crew roster shape (names as they exist in users.name).
const USERS = [
  { id: "u-alyx", name: "Alyx" },
  { id: "u-tendo", name: "Tendo Lugesera Adrian" },
  { id: "u-kim", name: "Kim Muiruri" },
  { id: "u-jean", name: "Jean Crous" },
  { id: "u-sonny", name: "Sonny Longstaff" },
];

// The captain's screenshot, verbatim.
const ALYX_WO_ITEM = {
  row_type: "work_order",
  rate: 272,
  wo_allocated: 559.5,
  wo_labour_deduction: 287.5,
  wo_labour_lines: [{ trade_name: "Tendo", hours: 11.5, rate: 25, amount: 287.5 }],
  job_id: "j-26767",
  job_number: "SWF-26767",
  client_name: "Kelvin Gillies",
  division: "fencing",
  date: "2026-07-14",
};

// ── Name cleaning ─────────────────────────────────────────────────────────
Deno.test("_cleanWoName: trims and collapses whitespace (production 'Tendo  ' case)", () => {
  assertEquals(_cleanWoName("Tendo  "), "Tendo");
  assertEquals(_cleanWoName("  Jean   Crous "), "Jean Crous");
  assertEquals(_cleanWoName(null), "");
});

// ── Extraction ────────────────────────────────────────────────────────────
Deno.test("_extractWoLabourEntries: captain's case yields one payable Tendo entry", () => {
  const { entries, problems } = _extractWoLabourEntries(ALYX_WO_ITEM);
  assertEquals(problems, []);
  assertEquals(entries.length, 1);
  assertEquals(entries[0].trade_name, "Tendo");
  assertEquals(entries[0].hours, 11.5);
  assertEquals(entries[0].rate, 25);
  assertEquals(entries[0].amount, 287.5);
  assertEquals(entries[0].job_number, "SWF-26767");
  assertEquals(entries[0].line_date, "2026-07-14");
});

Deno.test("_extractWoLabourEntries: empty template rows drop; unnamed money and named-incomplete lines become problems", () => {
  const { entries, problems } = _extractWoLabourEntries({
    ...ALYX_WO_ITEM,
    wo_labour_lines: [
      { trade_name: "", hours: null, rate: null }, // untouched "+ Add labour line" row
      { trade_name: "", hours: 2, rate: 30 }, // money with no person
      { trade_name: "Kim", hours: 0, rate: 25 }, // person with no money
      { trade_name: "Tendo", hours: 11.5, rate: 25 },
    ],
  });
  assertEquals(entries.length, 1);
  assertEquals(entries[0].trade_name, "Tendo");
  assertEquals(problems.length, 2);
  assertEquals(problems[0].reason, "unnamed");
  assertEquals(problems[0].amount, 60);
  assertEquals(problems[1].reason, "incomplete");
  assertEquals(problems[1].trade_name, "Kim");
});

// ── Money guard ───────────────────────────────────────────────────────────
Deno.test("_woNetMismatch: consistent captain's case passes", () => {
  assertEquals(_woNetMismatch(ALYX_WO_ITEM), null);
});

Deno.test("_woNetMismatch: net that ignores the labour deduction is rejected", () => {
  const bad = _woNetMismatch({ ...ALYX_WO_ITEM, rate: 559.5 });
  assertEquals(bad?.expectedNet, 272);
  assertEquals(bad?.claimedNet, 559.5);
  assertEquals(bad?.labourSum, 287.5);
});

Deno.test("_woNetMismatch: per-line rounding matches the client (no false mismatch)", () => {
  // 3 × 33.335 → per-line round 100.01 (client algorithm), not 100.005 summed.
  const item = {
    wo_allocated: 500,
    rate: 399.99,
    wo_labour_lines: [{ trade_name: "Jean", hours: 3, rate: 33.335 }],
  };
  assertEquals(_woNetMismatch(item), null);
});

Deno.test("_woNetMismatch: validates persisted quantity times rate", () => {
  assertEquals(_woNetMismatch({ ...ALYX_WO_ITEM, quantity: 2, rate: 136 }), null);
  const bad = _woNetMismatch({ ...ALYX_WO_ITEM, quantity: 2, rate: 272 });
  assertEquals(bad?.claimedNet, 544);
});

// ── Cleaned persistence copy ──────────────────────────────────────────────
Deno.test("_cleanWoLabourLines: recomputes amounts, keeps problem lines, drops empties", () => {
  const cleaned = _cleanWoLabourLines({
    wo_labour_lines: [
      { trade_name: "Tendo  ", hours: 11.5, rate: 25, amount: 999 }, // client amount ignored
      { trade_name: "", hours: null, rate: null },
      { trade_name: "Kim", hours: 0, rate: 25 },
    ],
  });
  assertEquals(cleaned, [
    { trade_name: "Tendo", hours: 11.5, rate: 25, amount: 287.5 },
    { trade_name: "Kim", hours: 0, rate: 25, amount: 0 },
  ]);
});

// ── Name → user resolution ────────────────────────────────────────────────
function entryFor(name: string, hours = 1, rate = 25): WoLabourEntry {
  return {
    trade_name: name,
    hours,
    rate,
    amount: Math.round(hours * rate * 100) / 100,
    job_id: "j-26767",
    job_number: "SWF-26767",
    client_name: "Kelvin Gillies",
    division: "fencing",
    line_date: "2026-07-14",
  };
}

Deno.test("_resolveWoLabourUsers: first name resolves the full production roster deterministically", () => {
  const { groups, problems } = _resolveWoLabourUsers(
    [entryFor("Tendo"), entryFor("Kim"), entryFor("Jean"), entryFor("Sonny")],
    USERS,
    "u-alyx",
  );
  assertEquals(problems, []);
  assertEquals(groups.map((g) => g.user.id).sort(), ["u-jean", "u-kim", "u-sonny", "u-tendo"]);
});

Deno.test("_resolveWoLabourUsers: exact full-name and prefix matches also resolve", () => {
  const { groups, problems } = _resolveWoLabourUsers(
    [entryFor("tendo lugesera adrian"), entryFor("Jean C")],
    USERS,
    "u-alyx",
  );
  assertEquals(problems, []);
  assertEquals(groups.map((g) => g.user.id).sort(), ["u-jean", "u-tendo"]);
});

Deno.test("_resolveWoLabourUsers: unknown, ambiguous and self names become problems, never guesses", () => {
  const roster = [...USERS, { id: "u-kim2", name: "Kim Nguyen" }];
  const { groups, problems } = _resolveWoLabourUsers(
    [entryFor("Riley"), entryFor("Kim"), entryFor("Alyx")],
    roster,
    "u-alyx",
  );
  assertEquals(groups, []);
  assertEquals(problems.map((p) => p.reason), ["unmatched", "ambiguous", "self"]);
});

Deno.test("_resolveWoLabourUsers: two lines for one person group onto one payout", () => {
  const { groups } = _resolveWoLabourUsers(
    [entryFor("Tendo", 4, 25), entryFor("Tendo", 7.5, 25)],
    USERS,
    "u-alyx",
  );
  assertEquals(groups.length, 1);
  assertEquals(groups[0].entries.length, 2);
});

// ── Payout invoice build ──────────────────────────────────────────────────
Deno.test("_buildWoLabourPayoutInvoice: Tendo is paid $287.50 pending office review (captain's end outcome)", () => {
  const { groups } = _resolveWoLabourUsers(
    _extractWoLabourEntries(ALYX_WO_ITEM).entries,
    USERS,
    "u-alyx",
  );
  const { invoice, lines } = _buildWoLabourPayoutInvoice(groups[0], {
    orgId: "org-1",
    weekStart: "2026-07-13",
    weekEnd: "2026-07-19",
    invoiceNumber: "SW-INV-TLA-260730-003",
    sourceInvoiceNumber: "SW-INV-A-260730-014",
    sourceTradeName: "Alyx",
    nowIso: NOW,
  });
  assertEquals(invoice.user_id, "u-tendo");
  assertEquals(invoice.org_id, "org-1");
  assertEquals(invoice.status, "pending_ops_review");
  assertEquals(invoice.subtotal_ex, 287.5);
  assertEquals(invoice.gst, 0); // no gstRegistered flag → not registered
  assertEquals(invoice.total_inc, 287.5);
  assertEquals(invoice.total_hours, 11.5);
  assertEquals(invoice.week_start, "2026-07-13");
  assertEquals(lines.length, 1);
  assertEquals(lines[0].line_type, "labour");
  assertEquals(lines[0].total_hours, 11.5);
  assertEquals(lines[0].hourly_rate, 25);
  assertEquals(lines[0].quantity, 11.5);
  assertEquals(lines[0].unit_rate, 25);
  assertEquals(lines[0].line_total_ex, 287.5);
  assertEquals(lines[0].job_number, "SWF-26767");
  // Provenance is visible to the office on both the invoice and the line.
  assertEquals(String(invoice.query_note).includes("SW-INV-A-260730-014"), true);
  assertEquals(String(lines[0].description).includes("Alyx"), true);
});

Deno.test("_buildWoLabourPayoutInvoice: gst-registered labourer gets 10% GST", () => {
  const group = {
    user: { id: "u-jean", name: "Jean Crous", trade_details: { gstRegistered: true } },
    entries: [entryFor("Jean", 10, 35)],
  };
  const { invoice } = _buildWoLabourPayoutInvoice(group, {
    orgId: "org-1",
    weekStart: "2026-07-13",
    weekEnd: "2026-07-19",
    invoiceNumber: "SW-INV-JC-260730-013",
    sourceInvoiceNumber: "SW-INV-I-260730-004",
    sourceTradeName: "Israel",
    nowIso: NOW,
  });
  assertEquals(invoice.subtotal_ex, 350);
  assertEquals(invoice.gst, 35);
  assertEquals(invoice.total_inc, 385);
});

Deno.test("_buildWoLabourPayoutInvoice: labour+extras line shapes agree so the push reconciliation guard passes", () => {
  const group = {
    user: { id: "u-tendo", name: "Tendo Lugesera Adrian" },
    entries: [entryFor("Tendo", 11.5, 25), entryFor("Tendo", 4, 25)],
  };
  const { invoice, lines } = _buildWoLabourPayoutInvoice(group, {
    orgId: "org-1",
    weekStart: "2026-07-13",
    weekEnd: "2026-07-19",
    invoiceNumber: "SW-INV-TLA-260730-003",
    sourceInvoiceNumber: "SW-INV-A-260730-014",
    sourceTradeName: "Alyx",
    nowIso: NOW,
  });
  // push_trade_invoice_to_xero recomputes: labour shape (total_hours×hourly_rate)
  // wins when both > 0; the extras shape must equal it.
  const labourShape = lines.reduce((s, l) => s + Number(l.total_hours) * Number(l.hourly_rate), 0);
  const extrasShape = lines.reduce((s, l) => s + Number(l.quantity) * Number(l.unit_rate), 0);
  assertEquals(labourShape, extrasShape);
  assertEquals(Math.abs(labourShape - Number(invoice.subtotal_ex)) <= 0.01, true);
});

Deno.test("_tradeInvoiceXeroTax: registered and unregistered invoices use matching Xero conventions", () => {
  assertEquals(_tradeInvoiceXeroTax(35), { taxType: "INPUT", lineAmountTypes: "Exclusive" });
  assertEquals(_tradeInvoiceXeroTax(0), { taxType: "NONE", lineAmountTypes: "NoTax" });
});

// ── Office note for unroutable lines ──────────────────────────────────────
Deno.test("_woLabourProblemNote: silent when clean, loud and specific when not", () => {
  assertEquals(_woLabourProblemNote([]), "");
  const note = _woLabourProblemNote([
    { trade_name: "Riley", reason: "unmatched", amount: 192.5, job_number: "SWF-26556" },
  ]);
  assertEquals(note.includes("Riley"), true);
  assertEquals(note.includes("SWF-26556"), true);
  assertEquals(note.includes("$192.50"), true);
  assertEquals(note.includes("manually"), true);
});

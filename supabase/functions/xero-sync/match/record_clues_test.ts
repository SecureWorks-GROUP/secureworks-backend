import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  bookedTradeDayClue,
  duplicateStop,
  samePersonStop,
  scopeItemsClue,
  supplierMailClue,
  tradeAppLinkClue,
} from "./record_clues.ts";
import type { MatchDocument } from "./doc_clues.ts";
const doc: MatchDocument = {
  subject_id: "xero_bill:B2",
  document_kind: "xero_bill",
  document_id: "B2",
  party_id: "supplier:1",
  party_name: "ZZTEST",
  document_number: "INV-1001",
  reference: null,
  document_date: "2026-11-06",
  total_ex: 500,
  lines: [],
};
const receipt = {
  id: "R1",
  job_id: "J1",
  submitted_by: "trade:1",
  receipt_date: "2026-11-06",
  saved_by_trade_app: true,
};
Deno.test("named strong supplier mail gives its message root, never a document-word lane", () => {
  const row = {
    decision: "named",
    job_id: "J1",
    strong: [{
      job_id: "J1",
      lanes: [{ lane: "supplier_mail", detail: "M1" }],
    }],
  };
  assertEquals(
    [supplierMailClue([row])?.job_id, supplierMailClue([row])?.root],
    ["J1", "message:M1"],
  );
  assertEquals(
    supplierMailClue([{
      ...row,
      strong: [{
        job_id: "J1",
        lanes: [{ lane: "job_number", detail: "SWF-990001" }],
      }],
    }]),
    null,
  );
});
Deno.test("AI or weak-only mail and conflicting jobs never supply a mail clue", () => {
  assertEquals(
    supplierMailClue([{
      decision: "not_named",
      job_id: null,
      strong: [],
      weak: [{
        job_id: "J1",
        lanes: [{ lane: "supplier_mail_with_number_unproven", detail: "M1" }],
      }],
    }]),
    null,
  );
  assertEquals(
    supplierMailClue([
      {
        decision: "named",
        job_id: "J1",
        strong: [{
          job_id: "J1",
          lanes: [{ lane: "supplier_mail", detail: "M1" }],
        }],
      },
      {
        decision: "named",
        job_id: "J2",
        strong: [{
          job_id: "J2",
          lanes: [{ lane: "supplier_mail", detail: "M2" }],
        }],
      },
    ]),
    null,
  );
});
Deno.test("a receipt filed against a job by the app's trade supplies a key", () => {
  assertEquals([
    tradeAppLinkClue(receipt)?.job_id,
    tradeAppLinkClue(receipt)?.root,
  ], ["J1", "receipt:R1"]);
  assertEquals(
    tradeAppLinkClue({ ...receipt, saved_by_trade_app: false }),
    null,
  );
  assertEquals(tradeAppLinkClue({ ...receipt, submitted_by: null }), null);
});
Deno.test("one booked job gives a roster clue; two jobs or a ghost give none", () => {
  const assignment = {
    id: "A1",
    job_id: "J1",
    user_id: "trade:1",
    scheduled_date: "2026-11-06",
    status: "allocated",
    is_ghost: false,
  };
  assertEquals(
    bookedTradeDayClue(receipt, [assignment])?.root,
    "assignment:A1",
  );
  assertEquals(
    bookedTradeDayClue(receipt, [assignment, {
      ...assignment,
      id: "A2",
      job_id: "J2",
    }]),
    null,
  );
  assertEquals(
    bookedTradeDayClue(receipt, [{ ...assignment, is_ghost: true }]),
    null,
  );
});
Deno.test("two of four money lines matching one supplier budget suggest that job", () => {
  const d = {
    ...doc,
    lines: [
      "steel fence panel",
      "galvanised corner upright",
      "roof flashing",
      "gate latch",
    ].map((description, i) => ({
      line_key: String(i),
      description,
      amount_ex: 125,
      account_code: "305",
      tracking_option: null,
    })),
  };
  const lines = ["steel fence panel", "galvanised corner upright"].map(
    (description) => ({
      budget_id: "BG1",
      job_id: "J1",
      lane: "materials",
      supplier_id: "supplier:1",
      supplier_name: null,
      description,
    }),
  );
  const other = [{
    ...lines[0],
    job_id: "J2",
    budget_id: "BG2",
    description: "timber decking board",
  }];
  assertEquals([
    scopeItemsClue(d, [...lines, ...other])?.job_id,
    scopeItemsClue(d, lines)?.root,
  ], ["J1", "budget:BG1"]);
  assertEquals(
    scopeItemsClue(d, lines.map((l) => ({ ...l, supplier_id: "supplier:2" }))),
    null,
  );
});
Deno.test("one of four matches or two qualifying jobs give no scope clue", () => {
  const d = {
    ...doc,
    lines: [
      "steel fence panel",
      "galvanised corner upright",
      "roof flashing",
      "gate latch",
    ].map((description, i) => ({
      line_key: String(i),
      description,
      amount_ex: 125,
      account_code: "305",
      tracking_option: null,
    })),
  };
  const lines = ["steel fence panel", "galvanised corner upright"].map(
    (description) => ({
      budget_id: "BG1",
      job_id: "J1",
      lane: "materials",
      supplier_id: "supplier:1",
      supplier_name: null,
      description,
    }),
  );
  assertEquals(scopeItemsClue(d, lines.slice(0, 1)), null);
  assertEquals(
    scopeItemsClue(d, [
      ...lines,
      ...lines.map((l) => ({ ...l, job_id: "J2", budget_id: "BG2" })),
    ]),
    null,
  );
});
Deno.test("only the later duplicate by date then id is held", () => {
  const earlier = {
    ...doc,
    subject_id: "xero_bill:B1",
    document_id: "B1",
    document_date: "2026-11-05",
    state_words: "needs a person",
    status: "AUTHORISED",
  };
  assertEquals(duplicateStop(doc, [earlier]), {
    code: "possible_duplicate",
    words: "An earlier live document has the same supplier, number and amount",
    detail: {
      other_document_id: "B1",
      other_number: "INV-1001",
      other_state_words: "needs a person",
    },
  });
  assertEquals(
    duplicateStop(earlier, [{
      ...doc,
      status: "AUTHORISED",
      state_words: "on a job",
    }]),
    null,
  );
  assertEquals(
    duplicateStop(doc, [{ ...earlier, document_date: doc.document_date }])
      ?.code,
    "possible_duplicate",
  );
  assertEquals(duplicateStop(doc, [{ ...earlier, total_ex: 501 }]), null);
  assertEquals(duplicateStop(doc, [{ ...earlier, status: "VOIDED" }]), null);
});
Deno.test("a trade's own contact with nearby app costs stops double counting", () => {
  const user = {
    id: "trade:1",
    xero_contact_id: "supplier:1",
    candidate_job_id: "J1",
  };
  const lines = [{
    job_id: "J1",
    user_id: "trade:1",
    line_date: "2026-11-01",
    total_ex: 800,
  }];
  assertEquals(samePersonStop(doc, user, lines)?.detail, {
    trade_lines_total_ex: 800,
  });
  assertEquals(
    samePersonStop(doc, user, [{ ...lines[0], job_id: "J2" }]),
    null,
  );
  assertEquals(
    samePersonStop(doc, user, [{ ...lines[0], line_date: "2026-10-01" }]),
    null,
  );
  assertEquals(
    samePersonStop(doc, { ...user, xero_contact_id: "supplier:2" }, lines),
    null,
  );
});

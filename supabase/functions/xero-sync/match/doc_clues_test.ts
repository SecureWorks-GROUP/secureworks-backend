import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  deliveryAddressClue,
  divisionTagNarrower,
  documentStops,
  groupTagClue,
  jobNumberClue,
  type MatchDocument,
  type MatchJob,
  orderNumberClue,
  overheadAccountClue,
} from "./doc_clues.ts";
import { LABOUR } from "../../_shared/people_accounts_test_support.ts";
import { labourAccounts } from "../../_shared/people_accounts.ts";

const job: MatchJob = {
  id: "J1",
  job_number: "SWF-990001",
  status: "accepted",
  created_at: "2026-10-01",
  site_address: null,
  site_suburb: null,
  holding: false,
};
const doc = (over: Partial<MatchDocument> = {}): MatchDocument => ({
  subject_id: "xero_bill:B1",
  document_kind: "xero_bill",
  document_id: "B1",
  party_id: "supplier:1",
  party_name: "ZZTEST",
  document_number: "SWF-990001",
  reference: "",
  document_date: "2026-11-01",
  total_ex: 1000,
  lines: [{
    line_key: "1",
    description: "plain",
    account_code: "305",
    tracking_option: null,
    amount_ex: 1000,
  }],
  ...over,
});
const codes = (d: MatchDocument, jobs = [job]) =>
  documentStops(d, jobs, LABOUR).map((s) => s.code);

Deno.test("document number is read as the Xero reference box", () => {
  const c = jobNumberClue(doc(), [job]);
  assertEquals(
    [c?.clue_code, c?.job_id, c?.seen_where, c?.seen_value, c?.root],
    ["job_number", "J1", "Xero reference box", "SWF-990001", "doc:B1"],
  );
});
Deno.test("a number only on line two keeps its source", () => {
  const d = doc({
    document_number: "B1",
    lines: [...doc().lines, {
      ...doc().lines[0],
      line_key: "2",
      description: "SWF-990001",
      amount_ex: 0,
    }],
  });
  assertEquals(jobNumberClue(d, [job])?.seen_where, "line 2 description");
});
Deno.test("two live numbers produce a stop and no number clue", () => {
  const jobs = [job, { ...job, id: "J2", job_number: "SWP-990002" }];
  const d = doc({ reference: "SWP-990002" });
  assertEquals(jobNumberClue(d, jobs), null);
  assertEquals(codes(d, jobs).includes("two_jobs_named"), true);
});
Deno.test("digit twins stop the match without a number clue", () => {
  const jobs = [job, { ...job, id: "J2", job_number: "SWP-990001" }];
  assertEquals(jobNumberClue(doc(), jobs), null);
  assertEquals(codes(doc(), jobs).includes("digit_twin"), true);
});
Deno.test("cancelled and holding jobs cannot supply a key", () => {
  for (
    const j of [{ ...job, status: "cancelled" }, { ...job, holding: true }]
  ) {
    assertEquals(jobNumberClue(doc(), [j]), null);
    assertEquals(codes(doc(), [j]).includes("job_not_live"), true);
  }
});
Deno.test("overhead and group clues require every nonzero line and at least one", () => {
  const d = doc({
    lines: [{
      ...doc().lines[0],
      account_code: "461",
      tracking_option: "SW - GROUP",
    }],
  });
  assertEquals(overheadAccountClue(d)?.outcome, "overhead");
  assertEquals(groupTagClue(d)?.outcome, "overhead");
  assertEquals(overheadAccountClue(doc({ lines: [] })), null);
  assertEquals(groupTagClue(doc({ lines: [] })), null);
  assertEquals(overheadAccountClue(doc()), null);
});
Deno.test("line totals conserve exactly; a whole cent discrepancy stops", () => {
  const lines = [400, 350, 250].map((amount_ex, i) => ({
    ...doc().lines[0],
    line_key: String(i),
    amount_ex,
  }));
  assertEquals(
    codes(doc({ lines })).includes("document_does_not_conserve"),
    false,
  );
  assertEquals(
    codes(doc({ lines, total_ex: 1000.01 })).includes(
      "document_does_not_conserve",
    ),
    true,
  );
  assertEquals(codes(doc({ total_ex: null })).includes("amount_unknown"), true);
  assertEquals(
    codes(doc({ lines: [{ ...lines[0], amount_ex: null }] })).includes(
      "amount_unknown",
    ),
    true,
  );
});
Deno.test("address requires the matching suburb in the same text and a unique live site", () => {
  const j = { ...job, site_address: "12 Test St", site_suburb: "Testville" };
  assertEquals(
    deliveryAddressClue(doc({ reference: "12 Test St Testville" }), [j])
      ?.job_id,
    "J1",
  );
  assertEquals(
    deliveryAddressClue(doc({ reference: "12 Test St" }), [j]),
    null,
  );
  assertEquals(
    deliveryAddressClue(doc({ reference: "12 Test St Testville" }), [j, {
      ...j,
      id: "J2",
    }]),
    null,
  );
});
Deno.test("installer accounts stop a bill and an early document stops before a new job", () => {
  assertEquals(
    codes(doc({ lines: [{ ...doc().lines[0], account_code: "306" }] }))
      .includes("installer_bill_outside_app"),
    true,
  );
  assertEquals(
    codes(doc({ document_date: "2026-09-16" })).includes("document_before_job"),
    true,
  );
  assertEquals(
    codes(doc({ document_date: "2026-09-17" })).includes("document_before_job"),
    false,
  );
});
Deno.test("a named supplier order requires an unmatched live job and a whole order token", () => {
  const d = doc({ reference: "PO-1000001" });
  const o = {
    order_kind: "purchase_order",
    order_id: "O1",
    order_number: "PO-1000001",
    job_id: "J1",
    party_id: d.party_id,
    status: "sent",
    matched: false,
  };
  assertEquals(orderNumberClue(d, [o], [job])?.root, "order:O1");
  assertEquals(orderNumberClue(d, [{ ...o, matched: true }], [job]), null);
  assertEquals(orderNumberClue(d, [o], [{ ...job, status: "draft" }]), null);
  assertEquals(
    orderNumberClue(d, [{ ...o, party_id: "supplier:2" }], [job]),
    null,
  );
  assertEquals(
    orderNumberClue(doc({ reference: "PO-10000012" }), [o], [job]),
    null,
  );
});
Deno.test("division tags are only narrower evidence", () => {
  const c = divisionTagNarrower(
    doc({ lines: [{ ...doc().lines[0], tracking_option: "SW - FENCING" }] }),
    job,
    "SW - FENCING",
  );
  assertEquals([c.class, c.detail], ["narrower", {
    tag: "SW - FENCING",
    expected: "SW - FENCING",
    agrees: true,
  }]);
});

Deno.test("installer stop reads the labour flag: 306 and 301 stop, 475 does not (not labour), a padded code never did", () => {
  const on = (code: string) => doc({ lines: [{ ...doc().lines[0], account_code: code }] });
  assert(codes(on("306")).includes("installer_bill_outside_app"));
  assert(codes(on("301")).includes("installer_bill_outside_app"));
  assert(!codes(on("475")).includes("installer_bill_outside_app"));
  assert(!codes(on(" 306")).includes("installer_bill_outside_app"));
  // 475 stays an overhead account (main's list); in the matcher the hidden skip runs first.
  assert(overheadAccountClue(on("475")) !== null);
  // The flag decides, not code.
  assert(documentStops(on("475"), [job], labourAccounts(["301", "306", "475"])).some((s) => s.code === "installer_bill_outside_app"));
});

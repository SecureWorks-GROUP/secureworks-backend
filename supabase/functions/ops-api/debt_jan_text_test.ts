// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { DebtMorningItem } from "./debt_chase_schedule.ts";
import { parseDebtDraftId } from "./debt_draft_templates.ts";
import {
  buildJanText,
  createSupabaseJanStaffStore,
  JAN_TEXT_MAX_INVOICES,
  type JanMobile,
  janMorningText,
  janTextDraftId,
  janTextDraftIdMatches,
  janTextProblem,
  janTextTemplateMatches,
  normaliseAuMobile,
  readJanMobile,
  resolveJanMobile,
} from "./debt_jan_text.ts";

const TODAY = "2026-10-01";
const JAN_PHONE = "+61411222333";
const SET: JanMobile = {
  phone: JAN_PHONE,
  source: "staff",
  staff_user_id: "u-jan",
  staff_name: "Jan Example",
  problem: null,
};

let seq = 0;
function item(over: Partial<DebtMorningItem> = {}): DebtMorningItem {
  seq += 1;
  const id = `aaaaaaaa-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  return {
    id: `${TODAY}:contact-${seq}:jan:jan_visit`,
    payer_key: `contact-${seq}`,
    payer_name: `Client ${seq}`,
    payer: "client",
    group: "jan",
    step: "jan_visit",
    step_label: "Day 7: Jan visits",
    amount: 1200,
    days_overdue: 9,
    invoices: [{
      xero_invoice_id: id,
      invoice_number: `INV-${String(seq).padStart(4, "0")}`,
      kind: "final",
      amount_due: 1200,
      due_date: "2026-09-22",
      invoice_date: "2026-09-08",
      days_overdue: 9,
      promise: null,
    }],
    hold: null,
    hold_reason: null,
    held_step: null,
    phone: "0400 000 000",
    email: null,
    promise: null,
    last_outcome: null,
    draft: null,
    draft_problem: null,
    ...over,
  };
}

// ── Jan's mobile ──

Deno.test("Jan's mobile: an Australian mobile in any common shape, nothing else", () => {
  for (
    const raw of [
      "0411 222 333",
      "0411222333",
      "+61 411 222 333",
      "+61411222333",
      "61411222333",
      "(0411) 222-333",
    ]
  ) assertEquals(normaliseAuMobile(raw), JAN_PHONE, raw);
  for (
    const raw of [
      "",
      "08 9123 4567",
      "+1 411 222 333",
      "0411 222 33",
      "0411 222 3333",
      "call Jan",
      null,
      411222333,
    ]
  ) assertEquals(normaliseAuMobile(raw), null, String(raw));
});

Deno.test("Jan's mobile: only from the one staff record named Jan", () => {
  const staff = [
    { id: "u-jan", name: "Jan Example", phone: "0411 222 333" },
    { id: "u-2", name: "Janet Other", phone: "0499 999 999" },
    { id: "u-3", name: "Sam Jan", phone: "0488 888 888" },
  ];
  assertEquals(resolveJanMobile(staff), SET);
  // Two records for the same person with one number is still one number.
  assertEquals(
    resolveJanMobile([
      ...staff,
      { id: "u-jan2", name: "jan", phone: "+61411222333" },
    ]).phone,
    JAN_PHONE,
  );
});

Deno.test("Jan's mobile: not set when it cannot be found unambiguously, and says why", () => {
  const notSet = (staff: any[]) => {
    const m = resolveJanMobile(staff);
    assertEquals(m.phone, null);
    assertEquals(m.source, null);
    assert(
      m.problem!.startsWith("Jan's mobile not set in staff records: "),
      m.problem!,
    );
    return m.problem!;
  };
  assert(notSet([]).includes("no staff record is named Jan"));
  assert(
    notSet([{ id: "u", name: "Janet", phone: "0411222333" }])
      .includes("no staff record is named Jan"),
  );
  assert(
    notSet([{ id: "u", name: "Jan Example", phone: null }])
      .includes("add an Australian mobile"),
  );
  assert(
    notSet([{ id: "u", name: "Jan Example", phone: "08 9123 4567" }])
      .includes("add an Australian mobile"),
  );
  assert(
    notSet([
      { id: "u1", name: "Jan One", phone: "0411222333" },
      { id: "u2", name: "Jan Two", phone: "0499999999" },
    ]).includes("2 staff records are named Jan"),
  );
});

Deno.test("Jan's mobile: the staff read is org-scoped; a failed read is not set", async () => {
  const calls: any[] = [];
  const client = {
    from(table: string) {
      const q: any = {};
      for (const m of ["select", "eq", "ilike"]) {
        q[m] = (...args: unknown[]) => {
          calls.push([table, m, ...args]);
          return q;
        };
      }
      q.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data: [{ id: "u-jan", name: "Jan Example", phone: "0411222333" }],
          error: null,
        }).then(resolve);
      return q;
    },
  };
  const store = createSupabaseJanStaffStore(client, "org-1");
  assertEquals(await readJanMobile(store), SET);
  assertEquals(calls, [
    ["users", "select", "id, name, phone"],
    ["users", "eq", "org_id", "org-1"],
    ["users", "ilike", "name", "jan%"],
  ]);

  const failing = createSupabaseJanStaffStore({
    from: () => {
      const q: any = {};
      for (const m of ["select", "eq", "ilike"]) q[m] = () => q;
      q.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, error: { message: "boom" } }).then(
          resolve,
        );
      return q;
    },
  }, "org-1");
  const m = await readJanMobile(failing);
  assertEquals(m.phone, null);
  assert(m.problem!.includes("could not be read"));
});

// ── The text ──

Deno.test("Jan's text: one line per visit with name, address when known, invoices, amount owing and days overdue", () => {
  const text = janMorningText(TODAY, [
    {
      payer_name: "Dylan Example",
      site: "12 Example Street, Exampleton",
      invoices: [{ invoice_number: "INV-0034", amount_due: 1200 }],
      amount: 1200,
      days_overdue: 45,
    },
    {
      payer_name: "Nur Example",
      site: null,
      invoices: [
        { invoice_number: "INV-0267", amount_due: 300.5 },
        { invoice_number: "INV-1069", amount_due: 73.18 },
      ],
      amount: 373.68,
      days_overdue: 1,
    },
  ]);
  assertEquals(
    text,
    "Hi Jan, your visits for Thu 1 Oct 2026:\n" +
      "1. Dylan Example, 12 Example Street, Exampleton: INV-0034, $1,200.00 owing, 45 days overdue.\n" +
      "2. Nur Example: INV-0267 and INV-1069, $373.68 owing, oldest 1 day overdue.\n" +
      "Please tell Shaun how each visit goes. Thanks",
  );
  assert(!/—/.test(text));
});

Deno.test("Jan's text: the draft id is today's, tied to Jan's number and the invoices in order", () => {
  const invoices = [
    { xero_invoice_id: "A", amount_due: 100 },
    { xero_invoice_id: "B", amount_due: 50.5 },
  ];
  const words = "Hi Jan\n1. Alpha: INV-1, $150.50 owing.";
  const id = janTextDraftId(TODAY, JAN_PHONE, invoices, words);
  assert(
    /^2026-10-01:jan-[0-9a-f]{8}-[0-9a-f]{8}:jan:jan_text\|10000,5050$/.test(
      id,
    ),
    id,
  );
  const parsed = parseDebtDraftId(id)!;
  assertEquals(parsed.step, "jan_text");
  assertEquals(parsed.group, "jan");
  assertEquals(parsed.perth_date, TODAY);
  assertEquals(parsed.amounts, [100, 50.5]);
  assert(janTextDraftIdMatches(id, JAN_PHONE, ["a", "b"]));
  assert(!janTextDraftIdMatches(id, "+61400111222", ["A", "B"]));
  assert(!janTextDraftIdMatches(id, JAN_PHONE, ["B", "A"]));
  assert(!janTextDraftIdMatches(id, JAN_PHONE, ["A"]));
  assert(
    janTextDraftId(TODAY, "+61400111222", invoices, words) !== id &&
      janTextDraftId(TODAY, JAN_PHONE, [invoices[1], invoices[0]], words) !==
        id,
  );
  // Other wording is another draft, still tied to the same number and list.
  const renamed = janTextDraftId(
    TODAY,
    JAN_PHONE,
    invoices,
    "Hi Jan\n1. Bravo: INV-1, $150.50 owing.",
  );
  assert(renamed !== id);
  assert(janTextDraftIdMatches(renamed, JAN_PHONE, ["A", "B"]));
});

Deno.test("Jan's text: the legal-action words are checked only on what Shaun adds or changes", () => {
  const a = item({ payer_name: "Courtney Legal Pty Ltd" });
  const b = item({ payer_name: "Sam Example" });
  const c = item({ payer_name: "Jo Bloggs" });
  const sites: Record<string, string> = {
    [a.payer_name]: "7 Wattle Court, Thornlie",
    [b.payer_name]: "2 Banksia\nCourt — Rear, Kelmscott",
    [c.payer_name]: "3 High Street, Armadale",
  };
  const draft = buildJanText([a, b, c], [], {
    perthDate: TODAY,
    mobile: SET,
    siteFor: (i) => sites[i.payer_name],
  })!;
  const template = draft.template_text!;
  assert(
    template.includes("1. Courtney Legal Pty Ltd, 7 Wattle Court, Thornlie: "),
  );
  assert(
    template.includes("2. Sam Example, 2 Banksia Court - Rear, Kelmscott: "),
  );
  assertEquals([draft.approvable, draft.problem], [true, null]);
  assertEquals(janTextProblem(template, template), null);
  // Untouched lines are never checked, however another line is edited, or deleted.
  const lines = template.split("\n");
  for (
    const edited of [
      template.replace("Jo Bloggs", "Jo Bloggs (back gate)"),
      template.replace("Sam Example", "Sam Smith"),
      [...lines.slice(0, 3), ...lines.slice(4)].join("\n"),
      [lines[0], lines[3], lines[1], lines[2], lines[4]].join("\n"),
      `${template}\nRing me after the first one.`,
    ]
  ) assertEquals(janTextProblem(edited, template), null, edited);
  // A legal word Shaun adds is refused, wherever he puts it.
  for (
    const edited of [
      `${template}\nIf they do not pay, tell them we will take them to court.`,
      template.replace("owing", "owing, mention a default listing"),
      template.replace("Thornlie:", "Thornlie, lawyer:"),
      template.replace("Jo Bloggs", "Jo Bloggs (court)"),
      template.replace("3 High Street", "3 High Court"),
    ]
  ) {
    assert(
      janTextProblem(edited, template)?.includes("mentions"),
      edited,
    );
  }
  // Empty, em dash and length still cover the whole text.
  assertEquals(janTextProblem("", template), "The message is empty");
  assertEquals(
    janTextProblem(template.replace("Armadale", "Armadale — rear"), template),
    "The message contains an em dash",
  );
  assert(
    janTextProblem(`${template}${"x".repeat(1600)}`, template)!.includes(
      "longer than 1600",
    ),
  );
});

Deno.test("Jan's text: approvable and problem are the approve check on the text shown", () => {
  const opts = { perthDate: TODAY, mobile: SET, siteFor: () => null };
  const draft = buildJanText([item()], [], opts)!;
  assertEquals(draft.problem, janTextProblem(draft.text, draft.template_text!));
  assertEquals(draft.approvable, true);
  // An approved edit reads back with the same check against the same wording.
  const i = item();
  const first = buildJanText([i], [], opts)!;
  const words = `${first.template_text}\nThe Court one first.`;
  const approved = buildJanText(
    [i],
    row(first.id, first.xero_invoice_ids, {
      outcome_code: null,
      outcome: "approved",
      approved_by_user_id: "u-shaun",
      notes: words,
    }),
    opts,
  )!;
  assertEquals(approved.status, "approved");
  assertEquals(approved.text, words);
  assertEquals(approved.problem, janTextProblem(words, first.template_text!));
  assert(approved.problem!.includes("mentions court"));
  assertEquals(approved.approvable, false);
  assert(janTextTemplateMatches(draft.id, draft.template_text));
  assert(!janTextTemplateMatches(draft.id, `${draft.template_text} `));
  assert(!janTextTemplateMatches(draft.id, undefined));
});

// ── The draft on the morning list ──

Deno.test("Jan's text: lists today's Jan visits, broken promises at the Jan step included, never holds", () => {
  const a = item({ payer_name: "Alpha", amount: 900 });
  const broken = item({
    payer_name: "Bravo",
    group: "broken_promise",
    step_label: "Promise broken: Day 7: Jan visits",
  });
  const held = item({
    payer_name: "Held",
    group: "hold",
    step: null,
    hold: "check_first",
    hold_reason: "the payer disputed it",
    held_step: "jan_visit",
  });
  const text = item({
    payer_name: "Text",
    group: "text",
    step: "friendly_text",
  });
  const sites: Record<string, string> = { Bravo: "1 Bravo Road, Brook" };
  const draft = buildJanText([broken, a, held, text], [], {
    perthDate: TODAY,
    mobile: SET,
    siteFor: (i) => sites[i.payer_name] ?? null,
  })!;
  assertEquals(draft.step, "jan_text");
  assertEquals(draft.channel, "sms");
  assertEquals(draft.to, "jan");
  assertEquals(draft.to_phone, JAN_PHONE);
  assertEquals(draft.mobile_source, "staff");
  assertEquals(draft.visits.map((v) => v.payer_name), ["Bravo", "Alpha"]);
  assertEquals(draft.visits[0].broken_promise, true);
  assertEquals(draft.visits[0].site, "1 Bravo Road, Brook");
  assertEquals(draft.visits[1].site, null);
  assertEquals(draft.xero_invoice_ids, [
    broken.invoices[0].xero_invoice_id,
    a.invoices[0].xero_invoice_id,
  ]);
  assertEquals(
    draft.id,
    janTextDraftId(
      TODAY,
      JAN_PHONE,
      [...broken.invoices, ...a.invoices],
      draft.template_text!,
    ),
  );
  assertEquals(draft.status, "pending");
  assertEquals(draft.text, draft.template_text);
  assert(draft.text!.includes("1. Bravo, 1 Bravo Road, Brook: "));
  assert(draft.text!.includes("2. Alpha: "));
  assertEquals(draft.approvable, true);
  assertEquals(draft.problem, null);
  // No Jan visits today: no Jan text.
  assertEquals(
    buildJanText([held, text], [], {
      perthDate: TODAY,
      mobile: SET,
      siteFor: () => null,
    }),
    null,
  );
});

Deno.test("Jan's text: with Jan's mobile not set the draft says so and cannot be approved", () => {
  const draft = buildJanText([item()], [], {
    perthDate: TODAY,
    mobile: resolveJanMobile([]),
    siteFor: () => null,
  })!;
  assertEquals(draft.to_phone, null);
  assertEquals(draft.approvable, false);
  assert(draft.problem!.startsWith("Jan's mobile not set in staff records"));
  // The wording is still shown, so Shaun can see what Jan would get.
  assert(draft.text!.startsWith("Hi Jan, your visits for"));
});

Deno.test("Jan's text: a list too long for one text cannot be approved, and says why", () => {
  const many = Array.from(
    { length: JAN_TEXT_MAX_INVOICES + 1 },
    () => item(),
  );
  const draft = buildJanText(many, [], {
    perthDate: TODAY,
    mobile: SET,
    siteFor: () => null,
  })!;
  assertEquals(draft.approvable, false);
  assert(draft.problem!.includes(`${JAN_TEXT_MAX_INVOICES}`), draft.problem!);
});

function row(
  draftId: string,
  ids: string[],
  over: Record<string, unknown>,
  at = "2026-10-01T01:00:00Z",
) {
  return ids.map((id) => ({
    xero_invoice_id: id,
    created_at: at,
    draft_id: draftId,
    covers_invoice_ids: ids,
    chased_by: "shaun@example.test",
    schedule_step: null,
    method: "sms",
    ...over,
  }));
}

Deno.test("Jan's text: an approval and a skip read back from the chase log", () => {
  const a = item();
  const opts = { perthDate: TODAY, mobile: SET, siteFor: () => null };
  const first = buildJanText([a], [], opts)!;
  const ids = first.xero_invoice_ids;
  const approved = buildJanText(
    [a],
    row(first.id, ids, {
      outcome_code: null,
      outcome: "approved",
      approved_by_user_id: "u-shaun",
      notes: "Hi Jan, edited. Thanks",
    }),
    opts,
  )!;
  assertEquals(approved.status, "approved");
  assertEquals(approved.text, "Hi Jan, edited. Thanks");
  assertEquals(approved.edited, true);
  assertEquals(approved.approved_by_user_id, "u-shaun");
  assertEquals(approved.approvable, true);
  const skipped = buildJanText(
    [a],
    row(first.id, ids, { outcome_code: "skipped", outcome: "skipped" }),
    opts,
  )!;
  assertEquals(skipped.status, "skipped");
  assertEquals(skipped.text, first.template_text);
});

Deno.test("Jan's text: once sent today it stays the day's Jan text, even when an outcome changes the list", () => {
  const a = item({ payer_name: "Alpha" });
  const b = item({ payer_name: "Bravo" });
  const opts = { perthDate: TODAY, mobile: SET, siteFor: () => null };
  const first = buildJanText([a, b], [], opts)!;
  const sent = row(first.id, first.xero_invoice_ids, {
    outcome_code: "sent",
    outcome: "sent",
    approved_by_user_id: "u-shaun",
    notes: first.text,
    provider_message_id: "m1",
  });
  // Bravo's outcome was logged, so only Alpha is still on Jan's list.
  const later = buildJanText([a], sent, opts)!;
  assertEquals(later.id, first.id);
  assertEquals(later.status, "sent");
  assertEquals(later.text, first.text);
  assertEquals(later.xero_invoice_ids, first.xero_invoice_ids);
  assertEquals(later.visits.map((v) => v.payer_name), ["Alpha"]);
  assertEquals(later.approvable, false);
  // A claimed send that was not confirmed is shown, never re-sendable.
  const claimed = buildJanText(
    [a],
    sent.map((r) => ({
      ...r,
      outcome_code: "sending",
      outcome: "send not confirmed: timeout",
    })),
    opts,
  )!;
  assertEquals(claimed.status, "sending");
  assertEquals(claimed.last_send?.outcome, "not_confirmed");
  // Yesterday's sent Jan text does not stand for today.
  const yesterday = janTextDraftId(
    "2026-09-30",
    JAN_PHONE,
    a.invoices,
    first.template_text!,
  );
  const fresh = buildJanText(
    [a],
    row(yesterday, [a.invoices[0].xero_invoice_id], {
      outcome_code: "sent",
      outcome: "sent",
      notes: "old",
    }, "2026-09-30T01:00:00Z"),
    opts,
  )!;
  assertEquals(fresh.status, "pending");
});
